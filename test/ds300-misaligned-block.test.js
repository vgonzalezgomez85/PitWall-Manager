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
// RESISLEMANS 1 (01/10/2026): PitWall contó 9 vueltas más que TicTac. Con los
// logs debug de la carrera:
//  · En las ráfagas del arranque el corte por silencio partía una trama y el
//    siguiente bloque empezaba por la cola de la anterior. Ese bloque se leía
//    entero como UNA trama: carril y byte12 de bytes cualquiera (0xAA → carriles
//    1,3,5,7), las tramas reales de dentro perdidas y, por el contador falso,
//    ~97 cruces de relleno. TimingService se quedaba con uno: +1 vuelta.
//  · Las retransmisiones (×2-3) partidas entre dos bloques no se colapsaban.
//  · Al cerrar, la reposición de bandera no contaba el fantasma que PitWall había
//    pasado a otro carril y reponía otra vuelta: la misma vuelta para los dos.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const SerialService = require('../src/services/SerialService');
const TimingService = require('../src/services/TimingService');
const { CircuitConnection } = SerialService;
const { crearCarreraConManga } = require('./helpers/seed');

after(limpiarBdTemporal);

function circuito() {
  const cruces = [];
  const noop = () => {};
  const c = new CircuitConnection(
    0, 0, (cruce) => cruces.push(cruce),
    noop, noop, noop, noop,
    noop, noop, noop, noop, noop,
  );
  c._setConnected = () => {};
  return { c, cruces };
}

const hex = (s) => s.trim().split(/\s+/).map(h => parseInt(h, 16));

// Los tres primeros bloques de la manga 122 (T1·M4), tal y como llegaron.
const BLOQUES_M122 = [
  // 2 copias de la trama del carril 6 + el principio de una 3ª
  hex('e0 7a 15 03 00 04 4c 1b a9 00 04 00 01 00 aa ab aa aa 54 00 eb e0 7a 15 03 00 04 4c 1b a9 00 04 00 01 00 aa ab aa aa 54 00 eb e0 7a 15 03 00 04'),
  // cola de esa 3ª copia + carril 1 + el principio de su retransmisión
  hex('1b a9 00 04 00 01 00 aa ab aa aa 54 00 eb e0 7b 15 03 00 04 4c 1b 00 00 80 00 01 00 aa ab aa aa 28 00 eb e0 7b 15 03 00 04 4c 1b 00 00 80 00'),
  // cola de la retransmisión del carril 1 + otra copia + 3 copias del carril 2
  hex('01 00 aa ab aa aa 28 00 eb e0 7b 15 03 00 04 4c 1b 00 00 80 00 01 00 aa ab aa aa 28 00 eb e0 7c 15 03 00 04 4c 1b 00 00 40 00 01 00 aa ab aa aa e9 00 eb e0 7c 15 03 00 04 4c 1b 00 00 40 00 01 00 aa ab aa aa e9 00 eb e0 7c 15 03 00 04 4c 1b 00 00 40 00 01 00 aa ab aa aa e9 00 eb'),
];

test('bloques desalineados reales: un cruce por coche, ninguno inventado', () => {
  const { c, cruces } = circuito();
  BLOQUES_M122.forEach((b, i) => c._processFrame(b, 1000 + i * 400));
  const carriles = cruces.map(x => x.lane).sort();
  assert.deepEqual(carriles, [1, 2, 6], 'antes salían también 3, 4, 5, 7 y 8');
  assert.equal(cruces.filter(x => x.missed).length, 0, 'sin cruces de relleno');
});

test('tras un bloque desalineado, el contador sigue sano: la vuelta siguiente no dispara ~97 de relleno', () => {
  const { c, cruces } = circuito();
  BLOQUES_M122.forEach((b, i) => c._processFrame(b, 1000 + i * 400));
  // Carril 4: primer cruce (sin tiempo), byte12 = 01. Con el bloque mal leído el
  // carril 4 había quedado con byte12 = 03 → 01 parecía una vuelta de contador.
  c._processFrame(hex('e0 7d 15 03 00 04 4c 1b 00 00 10 00 01 00 aa ab aa aa ba 00 eb'), 8300);
  const carril4 = cruces.filter(x => x.lane === 4);
  assert.equal(carril4.length, 1);
  assert.equal(carril4[0].missed, undefined);
});

test('un fragmento suelto (no empieza por 0xE0) no produce cruces', () => {
  const { c, cruces } = circuito();
  c._processFrame(hex('1b a9 00 04 00 01 00 aa ab aa aa 54 00 eb 00 00 00 00 00 00'), 1000);
  assert.equal(cruces.length, 0);
});

test('una retransmisión partida entre dos bloques cuenta una sola vez', () => {
  const { c, cruces } = circuito();
  const trama = hex('e0 80 15 03 00 04 4c 1b a9 00 80 00 02 00 00 10 03 57 98 00 eb');
  c._processFrame(trama, 1000);
  c._processFrame(trama, 1003);
  assert.equal(cruces.length, 1);
  assert.equal(cruces[0].lapTimeMs, 10035.7);
});

test('la vuelta siguiente del mismo carril SÍ cuenta (sube el byte12)', () => {
  const { c, cruces } = circuito();
  c._processFrame(hex('e0 80 15 03 00 04 4c 1b a9 00 80 00 02 00 00 10 03 57 98 00 eb'), 1000);
  c._processFrame(hex('e0 81 15 03 00 04 4c 1b a9 00 80 00 03 00 00 09 73 55 98 00 eb'), 10735);
  assert.equal(cruces.length, 2);
});

test('el GO olvida la última trama: la 1ª vuelta de la manga nueva cuenta aunque sea idéntica', () => {
  const { c, cruces } = circuito();
  const primera = hex('e0 7b 15 03 00 04 4c 1b 00 00 80 00 01 00 aa ab aa aa 28 00 eb');
  c._processFrame(primera, 1000);
  const go = new Array(21).fill(0);
  go[0] = 0xe0; go[7] = 0x3e; go[8] = 0xa1; go[10] = 0x10; go[20] = 0xeb;
  c._processFrame(go, 2000);
  clearTimeout(c._goFallbackTimer);
  c._processFrame(primera, 3000);
  assert.equal(cruces.length, 2);
});

// ── Reposición de bandera con un fantasma reasignado ───────────────────────

beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'drivers', 'teams', 'mangas', 'tandas', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

test('al cerrar, el fantasma pasado a otro carril cuenta como ya registrado en el suyo', () => {
  const { raceId, mangaId, teams } = crearCarreraConManga([
    { nombre: 'Uno', pilotos: [] },
    { nombre: 'Dos', pilotos: [] },
  ]);
  const ins = db.prepare(`INSERT INTO laps (race_id, manga_id, team_id, lane, lap_number, lap_time_ms, elapsed_ms, is_ghost, source_lap_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let n = 1; n <= 5; n++) ins.run(raceId, mangaId, teams[1].id, 2, n, 10000, n * 10000, 0, null);
  // El DS contó en el carril 2 un cruce de 6,7 s que PitWall certificó como
  // fantasma y pasó al carril 1.
  const ghostId = ins.run(raceId, mangaId, teams[1].id, 2, 0, 6727, 55000, 1, null).lastInsertRowid;
  ins.run(raceId, mangaId, teams[0].id, 1, 1, 10144, 55000, 0, ghostId);

  const Klass = TimingService.constructor;
  assert.equal(Klass.dsCountedLaps(mangaId, 2).n, 6, '5 válidas + el fantasma reasignado');
  assert.equal(Klass.dsCountedLaps(mangaId, 2).maxNum, 5);

  const orig = {
    status: SerialService.getLinkStatus, counters: SerialService.getDsLapCounters,
  };
  SerialService.getLinkStatus    = () => ({ simulating: false });
  SerialService.getDsLapCounters = () => ({ 2: 6 });   // el DS: 6 en el carril 2
  try {
    TimingService.session = null;
    TimingService._reconcileFinalLaps({
      mangaId, raceId, mangaNumber: 1,
      lanes: [{ lane: 2, teamId: teams[1].id, driverId: null, name: 'Dos',
                refAvgMs: 10000, lastCrossing: 60000, circuitStartTime: 10000 }],
    });
  } finally {
    SerialService.getLinkStatus    = orig.status;
    SerialService.getDsLapCounters = orig.counters;
  }
  const bandera = db.prepare('SELECT COUNT(*) AS n FROM laps WHERE manga_id = ? AND is_flag_lap = 1').get(mangaId).n;
  assert.equal(bandera, 0, 'antes reponía una vuelta de bandera falsa');
});
