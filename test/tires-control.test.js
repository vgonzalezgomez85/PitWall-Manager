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
// Control de neumáticos de resistencia. Disponibles/usados se DERIVAN de las
// filas de tire_changes (dotación − nº de entregas); deshacer = borrar la fila.
// El control es por equipo REAL: una carrera con tandas tiene varias filas en
// `teams` por equipo, y todas cuentan bajo el id canónico (el menor).
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db             = require('../src/config/database');
const Race           = require('../src/models/Race');
const TireChange     = require('../src/models/TireChange');
const TireController  = require('../src/controllers/TireController');

// ── Utilidades de montaje ──────────────────────────────────────────────────
function nuevaCarrera(tirePairs) {
  return Race.create({
    name: 'Resis', type: 'championship', format: 'team',
    lanes_count: 8, lane_sequence: [1,2,3,4,5,6,7,8], manga_duration_minutes: 20,
    tire_pairs_per_team: tirePairs,
  });
}
function nuevaTanda(raceId, number) {
  return db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, number).lastInsertRowid;
}
function nuevoEquipo(raceId, tandaId, name, lane) {
  return db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, ?, ?)')
    .run(raceId, tandaId, name, lane, '#abc').lastInsertRowid;
}
function nuevaManga(raceId, tandaId, number, status) {
  return db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, ?, ?)')
    .run(tandaId, raceId, number, status || 'pending').lastInsertRowid;
}
// req/res falsos para ejercitar el controlador sin Express.
function fakeReq(params, body) { return { params: params || {}, body: body || {}, t: (k) => k }; }
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (o) => { r.body = o; return r; };
  return r;
}

// ── Modelo: disponibles/usados derivados ────────────────────────────────────
test('summary: dotación intacta si no hay cambios', () => {
  const raceId = nuevaCarrera(5);
  const tanda  = nuevaTanda(raceId, 1);
  nuevoEquipo(raceId, tanda, 'Alfa', 1);
  nuevoEquipo(raceId, tanda, 'Beta', 2);

  const s = TireChange.summaryByRace(raceId);
  assert.equal(s.allowance, 5);
  assert.equal(s.teams.length, 2);
  s.teams.forEach(t => { assert.equal(t.used, 0); assert.equal(t.available, 5); });
});

test('add resta 1 disponible y suma 1 usado; remove lo devuelve', () => {
  const raceId = nuevaCarrera(4);
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);

  const id1 = TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, raceElapsedMs: 60000, createdAtMs: 1000 });
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 2, raceElapsedMs: 90000, createdAtMs: 2000 });

  let t = TireChange.summaryByRace(raceId).teams[0];
  assert.equal(t.used, 2);
  assert.equal(t.available, 2);

  TireChange.remove(id1);
  t = TireChange.summaryByRace(raceId).teams[0];
  assert.equal(t.used, 1);
  assert.equal(t.available, 3);
});

test('available puede ser negativo al exceder la dotación', () => {
  const raceId = nuevaCarrera(1);
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  TireChange.add({ raceId, teamId: alfa, createdAtMs: 1 });
  TireChange.add({ raceId, teamId: alfa, createdAtMs: 2 });
  const t = TireChange.summaryByRace(raceId).teams[0];
  assert.equal(t.used, 2);
  assert.equal(t.available, -1);
});

// ── Canonicalización por nombre (carrera con tandas) ────────────────────────
test('un equipo en 2 tandas cuenta como UNO bajo el id canónico', () => {
  const raceId = nuevaCarrera(6);
  const t1 = nuevaTanda(raceId, 1);
  const t2 = nuevaTanda(raceId, 2);
  const alfa1 = nuevoEquipo(raceId, t1, 'Alfa', 1);   // canónico (menor id)
  const alfa2 = nuevoEquipo(raceId, t2, 'Alfa', 1);   // misma escudería, otra tanda

  assert.equal(TireChange.canonicalTeamId(raceId, alfa2), alfa1);

  // Una entrega sobre la fila de la 2ª tanda debe caer en el canónico.
  const canon = TireChange.canonicalTeamId(raceId, alfa2);
  TireChange.add({ raceId, teamId: canon, createdAtMs: 1 });

  const s = TireChange.summaryByRace(raceId);
  assert.equal(s.teams.length, 1);            // deduplicado por nombre
  assert.equal(s.teams[0].id, alfa1);
  assert.equal(s.teams[0].used, 1);
  assert.equal(s.teams[0].available, 5);
});

// ── Controlador: entrega normaliza al canónico y sella la manga ─────────────
test('addChange sobre fila no canónica escribe en el canónico y sella manga activa', () => {
  const raceId = nuevaCarrera(3);
  const t1 = nuevaTanda(raceId, 1);
  const t2 = nuevaTanda(raceId, 2);
  const alfa1 = nuevoEquipo(raceId, t1, 'Alfa', 1);
  const alfa2 = nuevoEquipo(raceId, t2, 'Alfa', 1);
  nuevaManga(raceId, t1, 7, 'active');        // manga viva en BD (sin sesión de motor)

  const res = fakeRes();
  TireController.addChange(fakeReq({ id: String(raceId), teamId: String(alfa2) }), res);

  assert.equal(res.body.ok, true);
  const s = res.body.summary;
  assert.equal(s.teams.length, 1);
  assert.equal(s.teams[0].id, alfa1);
  assert.equal(s.teams[0].used, 1);

  // La fila quedó sellada con el nº de manga activa y sin elapsed (no hay motor).
  const row = db.prepare('SELECT * FROM tire_changes WHERE race_id=? ORDER BY id DESC LIMIT 1').get(raceId);
  assert.equal(row.team_id, alfa1);
  assert.equal(row.manga_number, 7);
  assert.equal(row.race_elapsed_ms, null);
});

test('addChange se rechaza si la carrera no lleva control de neumáticos', () => {
  const raceId = nuevaCarrera(0);              // dotación 0 = sin control
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  const res = fakeRes();
  TireController.addChange(fakeReq({ id: String(raceId), teamId: String(alfa) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

// ── Historial: editar y añadir a mano ───────────────────────────────────────
test('updateChange reescribe manga/tiempo; parseo mm:ss → ms', () => {
  const raceId = nuevaCarrera(3);
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  const id = TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, raceElapsedMs: 1000, createdAtMs: 1 });

  const res = fakeRes();
  TireController.updateChange(
    fakeReq({ id: String(raceId), changeId: String(id) }, { manga_number: '3', elapsed: '12:30' }),
    res
  );
  assert.equal(res.body.ok, true);
  const row = TireChange.findById(id);
  assert.equal(row.manga_number, 3);
  assert.equal(row.race_elapsed_ms, (12 * 60 + 30) * 1000);   // 750000
});

test('addManual crea un registro con nota y tiempo h:mm:ss', () => {
  const raceId = nuevaCarrera(3);
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);

  const res = fakeRes();
  TireController.addManual(
    fakeReq({ id: String(raceId), teamId: String(alfa) },
            { manga_number: '2', elapsed: '1:05:00', note: '  pinchazo  ' }),
    res
  );
  assert.equal(res.body.ok, true);
  const row = db.prepare('SELECT * FROM tire_changes WHERE race_id=? ORDER BY id DESC LIMIT 1').get(raceId);
  assert.equal(row.manga_number, 2);
  assert.equal(row.race_elapsed_ms, (3600 + 300) * 1000);   // 3900000
  assert.equal(row.note, 'pinchazo');
});

test('historyByTeam ordena por más reciente primero', () => {
  const raceId = nuevaCarrera(5);
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, createdAtMs: 100 });
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 2, createdAtMs: 200 });
  const h = TireChange.historyByTeam(raceId, alfa);
  assert.equal(h.length, 2);
  assert.equal(h[0].manga_number, 2);   // el más reciente primero
  assert.equal(h[1].manga_number, 1);
});

// ── Historial GLOBAL (todas las mangas) ─────────────────────────────────────
test('fullHistoryByRace: lista TODAS las mangas, incluidas las sin cambios', () => {
  const raceId = nuevaCarrera(4);
  const tanda  = nuevaTanda(raceId, 1);
  nuevaManga(raceId, tanda, 1);
  nuevaManga(raceId, tanda, 2);
  nuevaManga(raceId, tanda, 3);
  const alfa = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, createdAtMs: 100 });

  const log = TireChange.fullHistoryByRace(raceId);
  assert.equal(log.allowance, 4);
  assert.equal(log.totalChanges, 1);
  assert.deepEqual(log.groups.map(g => g.mangaNumber), [1, 2, 3]);  // ordenadas
  assert.equal(log.groups[0].changes.length, 1);   // manga 1 con cambio
  assert.equal(log.groups[1].changes.length, 0);   // manga 2 vacía
  assert.equal(log.groups[2].changes.length, 0);   // manga 3 vacía
});

test('fullHistoryByRace: numera el JUEGO por equipo en orden cronológico', () => {
  const raceId = nuevaCarrera(6);
  const tanda  = nuevaTanda(raceId, 1);
  nuevaManga(raceId, tanda, 1);
  nuevaManga(raceId, tanda, 2);
  const alfa = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  const beta = nuevoEquipo(raceId, tanda, 'Beta', 2);
  // Alfa: 2 juegos (mangas 1 y 2); Beta: 1 juego (manga 1). Entremezclados.
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, createdAtMs: 100 });
  TireChange.add({ raceId, teamId: beta, mangaNumber: 1, createdAtMs: 150 });
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 2, createdAtMs: 300 });

  const log = TireChange.fullHistoryByRace(raceId);
  assert.equal(log.totalChanges, 3);
  const m1 = log.groups.find(g => g.mangaNumber === 1).changes;
  const m2 = log.groups.find(g => g.mangaNumber === 2).changes;
  // Manga 1, en orden: Alfa juego 1, Beta juego 1.
  assert.deepEqual(m1.map(c => [c.team_name, c.set_number]), [['Alfa', 1], ['Beta', 1]]);
  // Manga 2: el 2º juego de Alfa (numeración global del equipo, no por manga).
  assert.deepEqual(m2.map(c => [c.team_name, c.set_number]), [['Alfa', 2]]);
  // Trae color/nombre del equipo para pintar la fila.
  assert.equal(m1[0].team_color, '#abc');
});

test('fullHistoryByRace: cambios sin manga van a un grupo aparte al final', () => {
  const raceId = nuevaCarrera(3);
  const tanda  = nuevaTanda(raceId, 1);
  nuevaManga(raceId, tanda, 1);
  const alfa = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, createdAtMs: 100 });
  TireChange.add({ raceId, teamId: alfa, mangaNumber: null, createdAtMs: 200 });

  const log = TireChange.fullHistoryByRace(raceId);
  const last = log.groups[log.groups.length - 1];
  assert.equal(last.mangaNumber, null);            // grupo "sin manga"
  assert.equal(last.changes.length, 1);
  assert.equal(last.changes[0].set_number, 2);     // sigue la numeración del equipo
});
