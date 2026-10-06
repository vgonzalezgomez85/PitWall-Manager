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
// Corregir vueltas con la manga en marcha. La corrección escribe en `laps` y el
// motor llevaba sus contadores en memoria: el directo no cambiaba hasta el
// siguiente cruce, y ese cruce se numeraba con el contador viejo (dos vueltas
// con el mismo lap_number tras añadir una a mano).

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db            = require('../src/config/database');
const Manga         = require('../src/models/Manga');
const Lap           = require('../src/models/Lap');
const TimingService = require('../src/services/TimingService');
const SocketService = require('../src/services/SocketService');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

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
  TimingService.session = null;
  TimingService._activeShiftsByLane = {};
}

// Lo que el motor manda a los clientes, para comprobar que el directo se entera.
let emitidos = [];
const emitOrig = SocketService.emit, standingsOrig = SocketService.emitStandings;
SocketService.emit = (ev, data) => { emitidos.push({ ev, data }); };
SocketService.emitStandings = (data) => { emitidos.push({ ev: 'standings', data }); };

after(() => {
  apagarTimers();
  SocketService.emit = emitOrig; SocketService.emitStandings = standingsOrig;
  limpiarBdTemporal();
});

beforeEach(() => {
  apagarTimers();
  emitidos = [];
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

function enMarcha() {
  const perfiles = ['Ana', 'Caro'].map(n => ({ nombre: n, id: crearPerfil(n) }));
  perfiles.forEach((p, i) => crearEquipoCatalogo(`E${i + 1}`, [p]));
  const { raceId, mangaId } = crearCarreraConManga(
    perfiles.map((p, i) => ({ nombre: `E${i + 1}`, pilotos: [p] })),
  );
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  TimingService.startManga(manga, race, Manga.getLanes(mangaId),
    db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(manga.tanda_id),
    db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(manga.tanda_id),
    60 * MIN);
  const t0 = TimingService.session.startTime;
  // Carril 1: salida + 3 vueltas.
  [9500, 9000, 9100, 9200].forEach((ms, i) => TimingService._onCrossing(1, t0 + (i + 1) * 9500, ms));
  return { raceId, mangaId, t0 };
}

const filaCarril = (lane) => TimingService.getStandings().standings.find(r => r.lane === lane);

test('añadir vueltas a mano se ve al momento y el siguiente cruce sigue la numeración', () => {
  const e = enMarcha();
  assert.equal(filaCarril(1).lapCount, 4);

  Lap.addManual({ mangaId: e.mangaId, raceId: e.raceId, lane: 1, lapTimeMs: 9300 });
  Lap.addManual({ mangaId: e.mangaId, raceId: e.raceId, lane: 1, lapTimeMs: 9300 });
  emitidos = [];
  TimingService.applyLapCorrection(e.raceId, e.mangaId);

  assert.equal(filaCarril(1).lapCount, 6, 'el directo cuenta las vueltas añadidas sin esperar a un cruce');
  const st = emitidos.find(x => x.ev === 'standings');
  assert.ok(st, 'se emite un standings nuevo');
  assert.equal(st.data.standings.find(r => r.lane === 1).lapCount, 6);
  assert.deepEqual(emitidos.find(x => x.ev === 'laps:corrected').data,
    { raceId: e.raceId, mangaId: e.mangaId, running: true });

  TimingService._onCrossing(1, e.t0 + 5 * 9500, 9050);
  const nums = db.prepare('SELECT lap_number FROM laps WHERE manga_id = ? AND lane = 1 AND is_ghost = 0 ORDER BY lap_number')
    .all(e.mangaId).map(r => r.lap_number);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7], 'sin números de vuelta repetidos');
});

test('quitar o anular vueltas baja el contador y la mejor vuelta al momento', () => {
  const e = enMarcha();
  const vueltas = db.prepare('SELECT id, lap_time_ms FROM laps WHERE manga_id = ? AND lane = 1 ORDER BY lap_number').all(e.mangaId);
  assert.equal(filaCarril(1).bestLapMs, 9000);

  Lap.markGhost(vueltas[1].id);              // la de 9000
  TimingService.applyLapCorrection(e.raceId, e.mangaId);
  assert.equal(filaCarril(1).lapCount, 3);
  assert.equal(filaCarril(1).bestLapMs, 9100, 'la mejor vuelta ya no es la anulada');

  Lap.deleteLap(vueltas[3].id);              // la última (9200)
  TimingService.applyLapCorrection(e.raceId, e.mangaId);
  assert.equal(filaCarril(1).lapCount, 2);
  assert.equal(filaCarril(1).lastLapMs, 9100, 'la última vuelta pasa a ser la anterior');
});

test('la corrección no toca el último cruce físico (de él sale el tiempo del siguiente)', () => {
  const e = enMarcha();
  const ld = TimingService.session.laneMap[1];
  const cruce = ld.lastCrossing;
  const vueltas = db.prepare('SELECT id FROM laps WHERE manga_id = ? AND lane = 1 ORDER BY lap_number').all(e.mangaId);
  Lap.deleteLap(vueltas[3].id);
  TimingService.applyLapCorrection(e.raceId, e.mangaId);
  assert.equal(ld.lastCrossing, cruce);
  assert.equal(ld.firstRealLapDone, true, 'la vuelta siguiente no vuelve a ser de salida');
});

test('sin manga en marcha avisa para que las vistas recarguen desde la BD', () => {
  const e = enMarcha();
  apagarTimers();
  emitidos = [];
  TimingService.applyLapCorrection(e.raceId, e.mangaId);
  assert.equal(emitidos.some(x => x.ev === 'standings'), false);
  assert.deepEqual(emitidos.find(x => x.ev === 'laps:corrected').data,
    { raceId: e.raceId, mangaId: e.mangaId, running: false });
});

test('anular una vuelta del medio: cuenta las válidas y el cruce siguiente no repite número', () => {
  const e = enMarcha();
  const v2 = db.prepare('SELECT id FROM laps WHERE manga_id = ? AND lane = 1 AND lap_number = 2').get(e.mangaId);
  Lap.markGhost(v2.id);
  TimingService.applyLapCorrection(e.raceId, e.mangaId);
  assert.equal(filaCarril(1).lapCount, 3, 'mismo recuento que los resultados (COUNT de válidas)');

  TimingService._onCrossing(1, e.t0 + 5 * 9500, 9050);
  assert.equal(filaCarril(1).lapCount, 4);
  const nums = db.prepare('SELECT lap_number FROM laps WHERE manga_id = ? AND lane = 1 AND is_ghost = 0 ORDER BY lap_number')
    .all(e.mangaId).map(r => r.lap_number);
  assert.deepEqual(nums, [1, 3, 4, 5]);
});
