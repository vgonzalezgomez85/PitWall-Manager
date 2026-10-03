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
// Salidas = «vuelta lenta» de TicTac: más de 1,5 s por encima de la vuelta
// rápida del carril en la manga. Como la rápida baja durante la manga, la marca
// en directo es provisional y se revisa cada vez que mejora; al cerrar, pasada
// final. La media limpia interna (coma, bandera) sigue con media + 1,7 s.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga         = require('../src/models/Manga');
const SerialService = require('../src/services/SerialService');
const TimingService = require('../src/services/TimingService');
const { crearCarreraConManga } = require('./helpers/seed');

const MIN = 60000;

function apagarTimers() {
  clearInterval(TimingService._tickInt);      TimingService._tickInt = null;
  clearTimeout(TimingService._autoStopTimer); TimingService._autoStopTimer = null;
  clearTimeout(TimingService._outageReconcileTimer); TimingService._outageReconcileTimer = null;
  if (TimingService.session) {
    Object.values(TimingService.session.circuits).forEach(c => {
      if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    });
  }
  TimingService._detachLapHandler();
  TimingService.session = null;
}

after(() => { apagarTimers(); limpiarBdTemporal(); });

beforeEach(() => {
  apagarTimers();
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

function arrancar() {
  const { raceId, mangaId } = crearCarreraConManga([
    { nombre: 'Uno', pilotos: [] },
    { nombre: 'Dos', pilotos: [] },
  ]);
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  const teams = db.prepare('SELECT * FROM teams WHERE tanda_id = ?').all(manga.tanda_id);
  TimingService.startManga(manga, race, Manga.getLanes(mangaId), teams, [], 60 * MIN);
  return { mangaId, t0: TimingService.session.circuits[0].startTime };
}

/** Rueda el carril 1: cruce de salida + las vueltas dadas. */
function rodar(t0, vueltas) {
  let ts = t0 + 1000;
  SerialService.emit('lane_crossing', { lane: 1, timestamp: ts, lapTimeMs: null, circuit: 0 });
  for (const ms of vueltas) {
    ts += ms;
    SerialService.emit('lane_crossing', { lane: 1, timestamp: ts, lapTimeMs: ms, circuit: 0 });
  }
}

const salidas = (mangaId) => db.prepare(
  'SELECT lap_time_ms AS ms, is_pit_stop AS pit FROM laps WHERE manga_id = ? AND lane = 1 AND is_exit = 1 ORDER BY lap_number'
).all(mangaId);

test('salida = más de 1,5 s sobre la vuelta rápida que lleva el carril', () => {
  const { mangaId, t0 } = arrancar();
  rodar(t0, [10000, 11400, 11600]);
  assert.deepEqual(salidas(mangaId).map(s => s.ms), [11600], '11,4 no pasa de 10 + 1,5; 11,6 sí');
  assert.equal(TimingService.session.laneMap[1].exitCount, 1);
});

test('al mejorar la rápida, las vueltas anteriores que quedan por encima pasan a ser salida', () => {
  const { mangaId, t0 } = arrancar();
  rodar(t0, [11000, 11800, 10000]);
  // Con 11,0 de rápida, 11,8 no era salida. Con 10,0 el límite baja a 11,5.
  assert.deepEqual(salidas(mangaId).map(s => s.ms), [11800]);
  assert.equal(TimingService.session.laneMap[1].exitCount, 1);
});

test('parada en boxes: salida de al menos el doble de la media limpia', () => {
  const { mangaId, t0 } = arrancar();
  rodar(t0, [10000, 10200, 10100, 25000]);
  assert.deepEqual(salidas(mangaId), [{ ms: 25000, pit: 1 }]);
  assert.equal(TimingService.session.laneMap[1].pitStopCount, 1);
});

test('la media limpia (coma, bandera) sigue con el criterio de siempre: media + 1,7 s', () => {
  const { t0 } = arrancar();
  rodar(t0, [11000, 11800, 10000, 10200, 12000, 25000]);
  const ld = TimingService.session.laneMap[1];
  // 12,0 es salida para TicTac (> 10,0 + 1,5) pero no se aparta 1,7 s de la
  // media limpia (10,75): sigue dentro. Solo 25,0 queda fuera.
  assert.equal(ld.cleanAvgMs, (11000 + 11800 + 10000 + 10200 + 12000) / 5);
  assert.equal(ld.exitCount, 3, '11,8 + 12,0 + 25,0');
});

test('al cerrar la manga quedan marcadas todas las vueltas por encima de la rápida definitiva', () => {
  const { mangaId, t0 } = arrancar();
  rodar(t0, [11000, 11800, 10000, 10200, 12000]);
  // Simula una marca perdida (p. ej. tras un reinicio): la pasada final la repone.
  db.prepare('UPDATE laps SET is_exit = 0 WHERE manga_id = ?').run(mangaId);
  TimingService.stopManga(true);
  assert.deepEqual(salidas(mangaId).map(s => s.ms), [11800, 12000]);
});

test('tras un reinicio, la media limpia y las salidas se reconstruyen igual que en directo', () => {
  const { mangaId, t0 } = arrancar();
  rodar(t0, [11000, 11800, 10000, 10200, 12000, 25000]);
  const s = TimingService.session;
  const ld = s.laneMap[1];
  const antes = { clean: ld.cleanAvgMs, exits: ld.exitCount, pits: ld.pitStopCount };
  Object.assign(ld, { cleanAvgMs: 0, cleanAvgCount: 0, cleanLapsSum: 0, exitCount: 0, pitStopCount: 0 });
  TimingService._restoreLaneStatsFromDb(mangaId, s.circuits, s.laneToCircuit);
  assert.deepEqual({ clean: ld.cleanAvgMs, exits: ld.exitCount, pits: ld.pitStopCount }, antes);
});
