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
// Cruce de la bandera: tras terminar el circuito, un cruce dentro de la ventana
// (`late_crossing_grace_ms`) cuenta como vuelta con su TIEMPO REAL, deja la coma a 0
// y desempata entre equipos de la misma manga final (utils/tieBreak): gana quien
// cruzó antes. Con otra manga, o sin dato, manda la coma como siempre.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga         = require('../src/models/Manga');
const Lap           = require('../src/models/Lap');
const Settings      = require('../src/models/Settings');
const SerialService = require('../src/services/SerialService');
const TimingService = require('../src/services/TimingService');
const { compareLastManga } = require('../src/utils/tieBreak');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

const MIN = 60000;

function apagarTimers() {
  clearInterval(TimingService._tickInt);      TimingService._tickInt = null;
  clearTimeout(TimingService._autoStopTimer); TimingService._autoStopTimer = null;
  clearTimeout(TimingService._outageReconcileTimer); TimingService._outageReconcileTimer = null;
  clearTimeout(TimingService._lateCloseTimer);      TimingService._lateCloseTimer = null;
  clearTimeout(TimingService._flagReconcileTimer);  TimingService._flagReconcileTimer = null;
  if (TimingService.session) {
    Object.values(TimingService.session.circuits).forEach(c => {
      if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    });
  }
  TimingService._detachLapHandler();
  TimingService.session = null;
  TimingService._lateWindows.clear();
}

const linkOriginal = SerialService.getLinkStatus.bind(SerialService);
SerialService.getLinkStatus = () => ({ ...linkOriginal(), simulating: false });

after(() => { apagarTimers(); SerialService.getLinkStatus = linkOriginal; limpiarBdTemporal(); });

beforeEach(async () => {
  // El cruce de salida se persiste en setImmediate: dejarlo aterrizar antes de
  // borrar las tablas evita errores de clave ajena del test anterior.
  await new Promise(r => setImmediate(r));
  apagarTimers();
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles', 'settings']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

function dosEquipos() {
  const a = { nombre: 'Ana', id: crearPerfil('Ana') };
  const b = { nombre: 'Beto', id: crearPerfil('Beto') };
  crearEquipoCatalogo('E1', [a]);
  crearEquipoCatalogo('E2', [b]);
  const { raceId, mangaId, teams } = crearCarreraConManga(
    [{ nombre: 'E1', pilotos: [a] }, { nombre: 'E2', pilotos: [b] }], { circuitsConfig: [2] });
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return { raceId, mangaId, race, manga, teams };
}

function darGo(e) {
  const lanes   = Manga.getLanes(e.mangaId);
  const teams   = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id);
  TimingService.startManga(e.manga, e.race, lanes, teams, drivers, 60 * MIN);
}

function cruce(lane, timestamp, lapTimeMs) {
  SerialService.emit('lane_crossing', { lane, timestamp, lapTimeMs, circuit: 0 });
}

/**
 * Manga de 60 min ya "casi acabada": el carril 1 cruzó por última vez 1 s antes del
 * final y el 2 hace 11 s (coma vieja: el 2 iba más lejos en la vuelta siguiente).
 * Ambos con las mismas vueltas.
 */
function mangaEmpatada() {
  const e = dosEquipos();
  darGo(e);
  const c = TimingService.session.circuits[0];
  c.startTime = Date.now() - 60 * MIN;
  const fin = c.startTime + 60 * MIN;
  for (const lane of [1, 2]) cruce(lane, c.startTime + 1000, null);
  cruce(1, fin - 1000, 12000);
  cruce(2, fin - 11000, 12000);
  assert.equal(TimingService.session.laneMap[1].lapCount, TimingService.session.laneMap[2].lapCount);
  return { e, c, fin };
}

const flagLaps = (mangaId, lane) =>
  db.prepare('SELECT * FROM laps WHERE manga_id = ? AND lane = ? AND is_flag_lap = 1').all(mangaId, lane);
const filaCarril = (mangaId, lane) =>
  db.prepare('SELECT coma, last_cross_ms FROM manga_lanes WHERE manga_id = ? AND lane = ?').get(mangaId, lane);

test('el cruce tras el final cuenta como vuelta con su tiempo real y deja la coma a 0', () => {
  const { e } = mangaEmpatada();
  TimingService.finishCircuit(0);
  assert.equal(TimingService.session, null, 'la manga se cerró');

  const t = Date.now();
  cruce(1, t + 100, 11800);
  cruce(2, t + 600, 12300);

  const f1 = flagLaps(e.mangaId, 1), f2 = flagLaps(e.mangaId, 2);
  assert.equal(f1.length, 1);
  assert.equal(f1[0].lap_time_ms, 11800, 'tiempo REAL del DS, no la media');
  assert.equal(f1[0].is_estimated, 0);
  assert.equal(f2[0].lap_time_ms, 12300);
  assert.equal(filaCarril(e.mangaId, 1).coma, 0);
  assert.ok(filaCarril(e.mangaId, 1).last_cross_ms < filaCarril(e.mangaId, 2).last_cross_ms);
});

test('a igualdad de vueltas y misma manga final gana quien cruzó antes (aunque su coma vieja fuera menor)', () => {
  const { e } = mangaEmpatada();
  TimingService.finishCircuit(0);
  const t = Date.now();
  cruce(1, t + 100, 11800);
  cruce(2, t + 600, 12300);

  const filas = Lap.aggregateByRace(e.raceId);
  assert.equal(filas[0].total_laps, filas[1].total_laps);
  assert.equal(filas[0].entity_name, 'E1', 'el carril 1 cruzó 500 ms antes');
});

test('un segundo cruce del mismo carril dentro de la ventana no cuenta', () => {
  const { e } = mangaEmpatada();
  TimingService.finishCircuit(0);
  const t = Date.now();
  cruce(1, t + 100, 11800);
  cruce(1, t + 400, 300);
  assert.equal(flagLaps(e.mangaId, 1).length, 1);
});

test('fuera de la ventana el cruce se descarta (queda la reposición por contador)', () => {
  const { e } = mangaEmpatada();
  TimingService.finishCircuit(0);
  cruce(1, Date.now() + 5000, 11800);
  assert.equal(flagLaps(e.mangaId, 1).length, 0);
});

test('la ventana es editable en Ajustes; 0 la desactiva', () => {
  Settings.set('late_crossing_grace_ms', 4000);
  assert.equal(TimingService.constructor.lateCrossingGraceMs(), 4000);
  Settings.set('late_crossing_grace_ms', 99999);
  assert.equal(TimingService.constructor.lateCrossingGraceMs(), 10000, 'tope 10 s');

  Settings.set('late_crossing_grace_ms', 0);
  const { e } = mangaEmpatada();
  TimingService.finishCircuit(0);
  cruce(1, Date.now() + 100, 11800);
  assert.equal(flagLaps(e.mangaId, 1).length, 0);
});

test('sin vuelta de bandera, la coma de siempre (y el cruce más temprano gana dentro de la misma manga)', () => {
  const { e } = mangaEmpatada();
  TimingService.finishCircuit(0);
  const filas = Lap.aggregateByRace(e.raceId);
  // E1 cruzó 1 s antes del final, E2 11 s antes: E1 va delante por cruzar después... no:
  // cruzó DESPUÉS, así que E2 (cruce más temprano) lleva más vuelta recorrida.
  assert.equal(filas[0].entity_name, 'E2');
});

// ── Comparador ───────────────────────────────────────────────────────────────

test('compareLastManga: misma manga → cruce más temprano; si no, la coma', () => {
  const a = { last_manga_id: 5, last_manga_cross_ms: 3600100, last_manga_coma: 0 };
  const b = { last_manga_id: 5, last_manga_cross_ms: 3600600, last_manga_coma: 0 };
  assert.ok(compareLastManga(a, b) < 0, 'a cruzó antes → va delante');
  assert.ok(compareLastManga(b, a) > 0);

  const c = { last_manga_id: 6, last_manga_cross_ms: 3600600, last_manga_coma: 0.7 };
  assert.ok(compareLastManga(c, a) < 0, 'mangas distintas → manda la coma (0,7 > 0)');

  const sinDato = { last_manga_id: 5, last_manga_cross_ms: null, last_manga_coma: 0.2 };
  assert.ok(compareLastManga(sinDato, a) < 0, 'sin instante de cruce → coma');

  assert.equal(compareLastManga(a, { ...a }), 0, 'empate total → sigue el tiempo total');
});
