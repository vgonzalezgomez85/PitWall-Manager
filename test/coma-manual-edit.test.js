/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// Corrección manual de la coma (Ajustes → Preferencias, apagada por defecto).
// Con el ajuste activo, `manga_lanes.coma_manual` manda sobre la coma automática
// y sobre el instante del cruce en el desempate (utils/tieBreak); con el ajuste
// apagado se ignora y todo queda como siempre.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db         = require('../src/config/database');
const Lap        = require('../src/models/Lap');
const Manga      = require('../src/models/Manga');
const Settings   = require('../src/models/Settings');
const SocketService = require('../src/services/SocketService');
const SettingsController = require('../src/controllers/SettingsController');
const LapCorrectionController = require('../src/controllers/LapCorrectionController');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

// Silencio de socket en los tests (applyLapCorrection emite laps:corrected).
const emitOrig = SocketService.emit;
const standingsOrig = SocketService.emitStandings;
SocketService.emit = () => {};
SocketService.emitStandings = () => {};
after(() => { SocketService.emit = emitOrig; SocketService.emitStandings = standingsOrig; limpiarBdTemporal(); });

beforeEach(() => {
  Settings.set('manual_coma', 'auto');
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles', 'settings']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

/**
 * Carrera de 1 manga, 2 equipos con las mismas 5 vueltas, manga cerrada y comas
 * ya persistidas a mano en manga_lanes (automática, cruce y corrección manual).
 */
function carrera({ coma1 = 0, coma2 = 0, cross1 = null, cross2 = null, manual1 = null, manual2 = null } = {}) {
  const a = { nombre: 'Ana',  id: crearPerfil('Ana')  };
  const b = { nombre: 'Beto', id: crearPerfil('Beto') };
  crearEquipoCatalogo('E1', [a]);
  crearEquipoCatalogo('E2', [b]);
  const { raceId, mangaId, teams } = crearCarreraConManga(
    [{ nombre: 'E1', pilotos: [a] }, { nombre: 'E2', pilotos: [b] }], { circuitsConfig: [2] });

  for (const lane of [1, 2]) {
    for (let i = 1; i <= 5; i++) {
      Lap.create({
        race_id: raceId, manga_id: mangaId, team_id: teams[lane - 1].id,
        lane, lap_number: i, lap_time_ms: 10000, elapsed_ms: i * 10000,
      });
    }
  }
  const set = db.prepare('UPDATE manga_lanes SET coma = ?, last_cross_ms = ?, coma_manual = ? WHERE manga_id = ? AND lane = ?');
  set.run(coma1, cross1, manual1, mangaId, 1);
  set.run(coma2, cross2, manual2, mangaId, 2);
  db.prepare("UPDATE mangas SET status = 'finished' WHERE id = ?").run(mangaId);
  return { raceId, mangaId, teams };
}

const fila = (rows, nombre) => rows.find(r => r.entity_name === nombre);
const orden = (rows) => rows.map(r => r.entity_name).filter((n, i, arr) => arr.indexOf(n) === i);
const comaGuardada = (mangaId, lane) =>
  db.prepare('SELECT coma, coma_manual FROM manga_lanes WHERE manga_id = ? AND lane = ?').get(mangaId, lane);

// ── Ajuste apagado (por defecto): todo como siempre ──────────────────────────

test('por defecto (auto) la coma manual se ignora en la clasificación', () => {
  const e = carrera({ coma1: 0.30, coma2: 0.10, manual1: 0.80 });
  const rows = Lap.aggregateByRace(e.raceId);
  assert.equal(fila(rows, 'E1').last_manga_coma, 0.30, 'sigue la automática, no el 0,80');
  assert.equal(fila(rows, 'E1').last_manga_coma_manual, false);
  assert.equal(orden(rows)[0], 'E1', 'el 0,30 automático manda');
  // La vía troceada (manga viva) coincide.
  const split = Lap.aggregateByRaceSplit(e.raceId, e.mangaId, []);
  assert.equal(fila(split, 'E1').last_manga_coma, 0.30);
  assert.equal(orden(split).join(), orden(rows).join());
});

test('apagar el ajuste devuelve al instante la coma automática', () => {
  const e = carrera({ coma1: 0.30, coma2: 0.10, manual1: 0.80 });
  Settings.set('manual_coma', 'manual');
  assert.equal(fila(Lap.aggregateByRace(e.raceId), 'E1').last_manga_coma, 0.80);
  Settings.set('manual_coma', 'auto');
  assert.equal(fila(Lap.aggregateByRace(e.raceId), 'E1').last_manga_coma, 0.30);
});

// ── Ajuste activo: la coma manual manda ──────────────────────────────────────

test('con el ajuste activo, la coma manual cambia la coma efectiva y el orden', () => {
  const e = carrera({ coma1: 0.10, coma2: 0.30, manual1: 0.90 });
  let rows = Lap.aggregateByRace(e.raceId);
  assert.equal(orden(rows)[0], 'E2', 'sin el ajuste ganaría el 0,30 de E2');

  Settings.set('manual_coma', 'manual');
  rows = Lap.aggregateByRace(e.raceId);
  assert.equal(fila(rows, 'E1').last_manga_coma, 0.90);
  assert.equal(fila(rows, 'E1').last_manga_coma_manual, true);
  assert.equal(orden(rows)[0], 'E1', 'el 0,90 corregido a mano manda');

  // Las dos vías coinciden (la del directo y la de resultados).
  const split = Lap.aggregateByRaceSplit(e.raceId, e.mangaId, []);
  assert.equal(fila(split, 'E1').last_manga_coma, 0.90);
  assert.equal(fila(split, 'E1').last_manga_coma_manual, true);
  assert.deepEqual(orden(split), orden(rows));

  // Y la suma acumulada (referencia para Control) también la respeta.
  assert.equal(fila(rows, 'E1').coma_total, 0.90);
});

test('la coma manual manda sobre el instante del cruce (misma manga final)', () => {
  // E2 cruzó antes (3000 < 5000): sin corrección, E2 va delante.
  const e = carrera({ cross1: 5000, cross2: 3000, coma1: 0, coma2: 0 });
  assert.equal(orden(Lap.aggregateByRace(e.raceId))[0], 'E2');

  Settings.set('manual_coma', 'manual');
  Manga.setLaneComa(e.mangaId, 1, 0.50);   // el coche de E1 se quedó parado, va delante
  const rows = Lap.aggregateByRace(e.raceId);
  assert.equal(orden(rows)[0], 'E1', 'la coma corregida a mano gana al cruce real');
  assert.equal(fila(rows, 'E1').last_manga_coma_manual, true);
});

test('sin coma manual en ninguno, sigue mandando quien cruzó antes', () => {
  const e = carrera({ cross1: 5000, cross2: 3000, coma1: 0.4, coma2: 0 });
  Settings.set('manual_coma', 'manual');
  assert.equal(orden(Lap.aggregateByRace(e.raceId))[0], 'E2', 'el cruce manda si nadie corrigió');
});

// ── Alta, baja y supervivencia del valor manual ──────────────────────────────

test('Manga.setLaneComa fija y borra la coma manual', () => {
  const e = carrera({ coma1: 0.25 });
  assert.equal(Manga.setLaneComa(e.mangaId, 1, 0.70), 1);
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, 0.70);
  assert.equal(comaGuardada(e.mangaId, 1).coma, 0.25, 'la automática no se toca');
  Manga.setLaneComa(e.mangaId, 1, null);
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, null);
  Settings.set('manual_coma', 'manual');
  assert.equal(fila(Lap.aggregateByRace(e.raceId), 'E1').last_manga_coma, 0.25, 'vuelve a la automática');
});

test('la corrección sobrevive a la reescritura automática de coma (cruce de bandera)', () => {
  const e = carrera({ coma1: 0.40 });
  Settings.set('manual_coma', 'manual');
  Manga.setLaneComa(e.mangaId, 1, 0.90);
  // El cruce de bandera tardío / la reconciliación escriben `coma`, no `coma_manual`.
  db.prepare('UPDATE manga_lanes SET coma = 0 WHERE manga_id = ? AND lane = ?').run(e.mangaId, 1);
  const rows = Lap.aggregateByRace(e.raceId);
  assert.equal(fila(rows, 'E1').last_manga_coma, 0.90);
});

// ── Invariantes ─────────────────────────────────────────────────────────────

test('una manga que vuelve a pending borra la coma manual (se vuelve a correr)', () => {
  const e = carrera({ coma1: 0.20 });
  Settings.set('manual_coma', 'manual');
  Manga.setLaneComa(e.mangaId, 1, 0.90);
  Manga.updateStatus(e.mangaId, 'pending');
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, null);
  // Al cerrarse de nuevo, la coma automática manda otra vez.
  db.prepare("UPDATE mangas SET status = 'finished' WHERE id = ?").run(e.mangaId);
  assert.equal(fila(Lap.aggregateByRace(e.raceId), 'E1').last_manga_coma, 0.20);
});

test('una coma manual en una manga anterior no cambia el desempate (solo la suma)', () => {
  const e = carrera({ coma1: 0.20, coma2: 0.10 });
  // Segunda manga de la misma tanda: pasa a ser la última de cada entidad.
  const tandaId = db.prepare('SELECT tanda_id FROM mangas WHERE id = ?').get(e.mangaId).tanda_id;
  const mid2 = db.prepare("INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, 2, 'finished')")
    .run(tandaId, e.raceId).lastInsertRowid;
  for (const i of [0, 1]) {
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, ?, ?, 0, ?)')
      .run(mid2, i + 1, e.teams[i].id, i === 0 ? 0.05 : 0.30);
  }

  Settings.set('manual_coma', 'manual');
  Manga.setLaneComa(e.mangaId, 1, 0.95);      // manga 1, ya no es la última de E1
  const rows = Lap.aggregateByRace(e.raceId);
  assert.equal(fila(rows, 'E1').last_manga_coma, 0.05, 'manda la última manga (la 2)');
  assert.equal(fila(rows, 'E1').last_manga_coma_manual, false);
  assert.equal(fila(rows, 'E1').coma_total, +(0.95 + 0.05).toFixed(2), 'la suma sí la recoge');
});

test('las filas de descanso no contaminan', () => {
  const e = carrera({ coma1: 0.20 });
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma, coma_manual) VALUES (?, 0, ?, 1, 0, 0.99)')
    .run(e.mangaId, e.teams[0].id);
  Settings.set('manual_coma', 'manual');
  assert.equal(fila(Lap.aggregateByRace(e.raceId), 'E1').last_manga_coma, 0.20);
  assert.equal(fila(Lap.aggregateByRace(e.raceId), 'E1').coma_total, 0.20);
});

test('cambiar el ajuste invalida las cachés por contador', () => {
  const antes = Lap.mutationCount;
  const res = fakeRes();
  SettingsController.savePrefs({ body: { key: 'manual_coma', value: 'manual' } }, res);
  assert.ok(Lap.mutationCount > antes, 'encender/apagar cambia la coma efectiva sin tocar laps');
});

test('la pantalla de correcciones sabe si la manga decide el desempate', () => {
  const e = carrera({ coma1: 0.20, coma2: 0.10 });
  Settings.set('manual_coma', 'manual');
  const res = fakeRes();
  LapCorrectionController.show(
    { params: { id: e.raceId, mangaId: e.mangaId }, t: (k) => k }, res);
  assert.equal(res.data.manualComa, true);
  assert.equal(res.data.decidesTie[1], true, 'es la única manga: decide el desempate');
  assert.equal(res.data.laneGroups.length, 2);
});

// ── Controlador (POST /races/:id/mangas/:mangaId/corrections/coma) ───────────

function fakeRes() {
  return { code: 200, redirectTo: null, body: null,
    status(c) { this.code = c; return this; },
    render(view, data) { this.view = view; this.data = data; return this; },
    redirect(u) { this.redirectTo = u; return this; },
    json(o) { this.body = o; return this; } };
}
const fakeReq = (e, body) => ({ params: { id: e.raceId, mangaId: e.mangaId }, body, t: (k) => k });
const postComa = (e, body) => {
  const res = fakeRes();
  LapCorrectionController.setComa(fakeReq(e, body), res);
  return res;
};

test('el controlador guarda con el ajuste activo y una manga cerrada', () => {
  const e = carrera({ coma1: 0.20 });
  Settings.set('manual_coma', 'manual');
  const res = postComa(e, { lane: '1', coma: '0,85' });   // coma decimal española
  assert.equal(res.redirectTo, `/races/${e.raceId}/mangas/${e.mangaId}/corrections`);
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, 0.85);
  assert.equal(comaGuardada(e.mangaId, 1).coma, 0.20);

  // Vacío = volver a la automática.
  postComa(e, { lane: '1', coma: '' });
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, null);
});

test('el controlador ignora la edición con el ajuste apagado', () => {
  const e = carrera({ coma1: 0.20 });
  postComa(e, { lane: '1', coma: '0,85' });
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, null);
});

test('el controlador rechaza valores fuera de rango, carriles y mangas no cerradas', () => {
  const e = carrera({ coma1: 0.20 });
  Settings.set('manual_coma', 'manual');

  postComa(e, { lane: '1', coma: '1,5' });      // > 0,99
  postComa(e, { lane: '1', coma: '-0,2' });     // < 0
  postComa(e, { lane: '1', coma: 'abc' });
  postComa(e, { lane: '9', coma: '0,5' });      // carril que no existe
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, null, 'nada de eso escribe');

  db.prepare("UPDATE mangas SET status = 'active' WHERE id = ?").run(e.mangaId);
  postComa(e, { lane: '1', coma: '0,50' });
  assert.equal(comaGuardada(e.mangaId, 1).coma_manual, null, 'una manga viva no se edita');
});

test('el controlador invalida las cachés por contador (mutación externa)', () => {
  const e = carrera({ coma1: 0.20 });
  Settings.set('manual_coma', 'manual');
  const antes = Lap.mutationCount;
  postComa(e, { lane: '1', coma: '0,60' });
  assert.ok(Lap.mutationCount > antes, 'la coma vive en manga_lanes y hay que forzar la invalidación');
});

// ── Ajustes: la preferencia y su validación ─────────────────────────────────

test('el ajuste manual_coma se guarda solo con valores válidos', () => {
  const res = fakeRes();
  SettingsController.savePrefs({ body: { key: 'manual_coma', value: 'manual' } }, res);
  assert.equal(Settings.get('manual_coma'), 'manual');

  const bad = fakeRes();
  SettingsController.savePrefs({ body: { key: 'manual_coma', value: 'sí' } }, bad);
  assert.equal(bad.code, 400);
  assert.equal(Settings.get('manual_coma'), 'manual', 'no se ha tocado');
});
