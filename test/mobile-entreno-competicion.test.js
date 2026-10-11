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
// La app móvil ve el entreno de competición: GET /api/mobile/training y
// GET /api/mobile/session lo tratan como un entreno más (antes solo miraban el
// entreno libre y la app no ofrecía conectarse al de competición).
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const TrainingService            = require('../src/services/TrainingService');
const CompetitionTrainingService = require('../src/services/CompetitionTrainingService');
const MobileController           = require('../src/controllers/MobileController');

function llamar(handler) {
  let cuerpo;
  handler({}, { json: c => { cuerpo = c; } });
  return cuerpo;
}

// Sombrea getters/métodos del servicio con propiedades propias (los getters
// reales viven en el prototipo) y devuelve la función que las quita.
function simular(servicio, props) {
  for (const [k, v] of Object.entries(props)) {
    const descriptor = typeof v === 'function'
      ? { configurable: true, writable: true, value: v }
      : { configurable: true, get: () => v };
    Object.defineProperty(servicio, k, descriptor);
  }
  return () => { for (const k of Object.keys(props)) delete servicio[k]; };
}

const LANES_COMP = [
  { lane: 1, participantName: 'Ana', color: '#ef4444', count: 3, avgMs: 8000, bestMs: 7900, lastMs: 8100 },
  { lane: 2, participantName: 'Luis', color: '#3b82f6', count: 2, avgMs: 8200, bestMs: 8100, lastMs: 8300 },
];

test('sin ningún entreno: /training dice active:false', () => {
  const r = llamar(MobileController.training);
  assert.equal(r.active, false);
  assert.equal(r.competition, false);
  assert.deepEqual(r.lanes, []);
});

test('entreno de competición montado: aparece, con heat y nombres', () => {
  const restaurar = simular(CompetitionTrainingService, {
    isReady: true, heatNumber: 3, startedAt: 111, durationMs: 300000,
    getLanes: () => LANES_COMP,
    getRoster: () => [
      { name: 'Ana', color: '#ef4444', lane: 1 },
      { name: 'Luis', color: '#3b82f6', lane: 2 },
      { name: 'Eva', color: null, lane: null },
    ],
  });
  try {
    const r = llamar(MobileController.training);
    assert.equal(r.active, true);
    assert.equal(r.competition, true);
    assert.equal(r.heat, 3);
    assert.equal(r.durationMs, 300000);
    assert.deepEqual(r.lanes.map(l => [l.lane, l.participantName]), [[1, 'Ana'], [2, 'Luis']]);
    // También llegan los que descansan: la app sigue al participante, no al carril.
    assert.deepEqual(r.participants.map(p => [p.name, p.lane]), [['Ana', 1], ['Luis', 2], ['Eva', null]]);

    const s = llamar(MobileController.session);
    assert.equal(s.type, 'training');
    assert.equal(s.name, 'Entreno de competición');
    assert.deepEqual(s.participants.map(p => p.name), ['Ana', 'Luis']);
  } finally {
    restaurar();
  }
});

test('entreno libre en marcha: sigue igual, sin nombres de participante', () => {
  const restaurar = simular(TrainingService, {
    isActive: true, startedAt: 5, durationMs: 60000,
    getLanes: () => [{ lane: 1, color: '#fff', count: 1, avgMs: 9000, bestMs: 9000, lastMs: 9000 }],
  });
  try {
    const r = llamar(MobileController.training);
    assert.equal(r.active, true);
    assert.equal(r.competition, false);
    assert.equal(r.heat, null);
    assert.deepEqual(r.participants, []);
    assert.equal(r.lanes[0].participantName, null);

    const s = llamar(MobileController.session);
    assert.equal(s.name, 'Entrenamiento');
    assert.equal(s.participants[0].name, 'Carril 1');
  } finally {
    restaurar();
  }
});

// ── Descarga de sesiones guardadas ──────────────────────────────────────────
const CompetitionTrainingResult = require('../src/models/CompetitionTrainingResult');

function llamarConId(handler, id) {
  let cuerpo, status = 200;
  handler({ params: { id } }, {
    json: c => { cuerpo = c; },
    status(n) { status = n; return this; },
  });
  return { cuerpo, status };
}

test('lista y detalle de sesiones guardadas, con clasificación y heats', () => {
  CompetitionTrainingResult.saveHeat('ct-prueba-1', 1, [
    { lane: 1, participantName: 'Ana',  bestLapMs: 7900, avgLapMs: 8000, lapCount: 10 },
    { lane: 2, participantName: 'Luis', bestLapMs: 8100, avgLapMs: 8200, lapCount: 9 },
  ]);
  CompetitionTrainingResult.saveHeat('ct-prueba-1', 2, [
    { lane: 1, participantName: 'Luis', bestLapMs: 7950, avgLapMs: 8050, lapCount: 11 },
    { lane: 2, participantName: 'Ana',  bestLapMs: 8000, avgLapMs: 8100, lapCount: 8 },
  ]);

  const lista = llamar(MobileController.competitionTrainings);
  const s = lista.sessions.find(x => x.id === 'ct-prueba-1');
  assert.ok(s);
  assert.equal(s.heats, 2);
  assert.equal(s.participants, 2);
  assert.equal(s.laps, 38);
  assert.equal(s.bestLapMs, 7900);
  assert.match(s.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const { cuerpo: d, status } = llamarConId(MobileController.competitionTrainingShow, 'ct-prueba-1');
  assert.equal(status, 200);
  // Luis: 9+11 = 20 vueltas; Ana: 10+8 = 18.
  assert.deepEqual(d.standings.map(x => [x.pos, x.name, x.laps]), [[1, 'Luis', 20], [2, 'Ana', 18]]);
  assert.equal(d.standings[1].bestLapMs, 7900);
  assert.deepEqual(d.heats.map(h => [h.heat, h.lanes.length]), [[1, 2], [2, 2]]);
  assert.deepEqual(d.heats[0].lanes[0], { lane: 1, name: 'Ana', bestLapMs: 7900, avgLapMs: 8000, laps: 10 });
});

test('una sesión inexistente da 404', () => {
  const { status, cuerpo } = llamarConId(MobileController.competitionTrainingShow, 'no-existe');
  assert.equal(status, 404);
  assert.equal(cuerpo.error, 'session_not_found');
});

test('la sesión montada ahora no sale en la lista hasta que se cierre', () => {
  CompetitionTrainingResult.saveHeat('ct-en-curso', 1, [
    { lane: 1, participantName: 'Ana', bestLapMs: 7900, avgLapMs: 8000, lapCount: 5 },
  ]);
  const restaurar = simular(CompetitionTrainingService, { isReady: true, sessionId: 'ct-en-curso' });
  try {
    const ids = llamar(MobileController.competitionTrainings).sessions.map(x => x.id);
    assert.ok(!ids.includes('ct-en-curso'));
    assert.ok(ids.includes('ct-prueba-1'));
  } finally {
    restaurar();
  }
});
