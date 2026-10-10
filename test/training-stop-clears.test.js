// Entreno libre: tras un STOP forzado, el siguiente GO empieza de cero igual que
// tras acabarse el tiempo. El récord de cada carril se conserva.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SerialService = require('../src/services/SerialService');
const TrainingService = require('../src/services/TrainingService');

after(() => { TrainingService.stop(); limpiarBdTemporal(); });
beforeEach(() => TrainingService.resetSession());

function rodar(cruces) {
  for (const [lane, lapTimeMs] of cruces) SerialService.emit('lane_crossing', { lane, lapTimeMs, circuit: 0 });
}
const carril = (n) => TrainingService.getLanes().find(l => l.lane === n);

test('STOP forzado: los datos siguen a la vista hasta el siguiente GO', () => {
  TrainingService.prepare(2);
  TrainingService.activate();
  rodar([[1, 10_000], [1, 11_000], [2, 12_000]]);
  TrainingService.stopToStandby();

  assert.equal(carril(1).count, 2, 'tras el STOP todavía se ven');
  TrainingService.activate();
  assert.equal(carril(1).count, 0);
  assert.equal(carril(1).bestMs, null);
  assert.deepEqual(carril(1).laps, []);
  assert.deepEqual(carril(2).pace, []);
  assert.deepEqual(TrainingService.getSessionRecords(), { 1: 10_000, 2: 12_000 }, 'el récord se queda');
});

test('el STOP del DS (race_stopped) hace lo mismo', () => {
  TrainingService.prepare(1);
  TrainingService.activate();
  rodar([[1, 9_500]]);
  SerialService.emit('race_stopped');
  assert.equal(TrainingService.isStandby, true);
  TrainingService.activate();
  assert.equal(carril(1).count, 0);
  assert.equal(TrainingService.getSessionRecords()[1], 9_500);
});
