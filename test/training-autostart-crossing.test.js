// Entreno libre con un DS: si el GO se dio en la caja antes de abrir PitWall, el
// primer cruce con tiempo arranca el entreno. No tras un fin o STOP reciente de
// la caja (cruces por inercia), ni en pausa, ni con fuentes en las que el GO lo
// da PitWall.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SerialService = require('../src/services/SerialService');
const TrainingService = require('../src/services/TrainingService');

after(() => { TrainingService.stop(); limpiarBdTemporal(); });
beforeEach(() => {
  TrainingService.stop();
  TrainingService._boxEndedAt = 0;
  TrainingService._boxPaused  = false;
  SerialService._simRunning   = false;
});

const cruce = (lane, lapTimeMs, extra = {}) =>
  SerialService.emit('lane_crossing', { lane, lapTimeMs, circuit: 0, ...extra });
const carril = (n) => TrainingService.getLanes().find(l => l.lane === n);

test('la caja ya corre: el primer cruce con tiempo arranca el entreno y cuenta', () => {
  cruce(1, 10_500);
  assert.equal(TrainingService.isActive, true);
  assert.equal(TrainingService.durationMs, null, 'sin duración: cuenta hacia arriba');
  assert.equal(carril(1).count, 1);
  assert.equal(carril(1).bestMs, 10_500);
  cruce(1, 10_200);
  assert.equal(carril(1).count, 2);
});

test('un cruce sin tiempo (primer paso por meta) no arranca nada', () => {
  cruce(1, null);
  assert.equal(TrainingService.isActive, false);
});

test('una vuelta repuesta no arranca el entreno', () => {
  cruce(1, 10_000, { missed: true });
  assert.equal(TrainingService.isActive, false);
});

test('tras el fin de la caja, los cruces por inercia no lo arrancan', () => {
  SerialService.emit('race_finished');
  cruce(1, 10_000);
  assert.equal(TrainingService.isActive, false);
  TrainingService._boxEndedAt = Date.now() - 31_000;
  cruce(1, 10_000);
  assert.equal(TrainingService.isActive, true, 'pasado el margen, sí');
});

test('con la caja en pausa no arranca', () => {
  SerialService.emit('race_paused', { circuit: 0 });
  cruce(1, 10_000);
  assert.equal(TrainingService.isActive, false);
  SerialService.emit('race_resumed', { circuit: 0 });
  cruce(1, 10_000);
  assert.equal(TrainingService.isActive, true);
});

test('con una fuente en la que PitWall da el GO (simulación) no arranca solo', () => {
  SerialService._simRunning = true;
  cruce(1, 10_000);
  assert.equal(TrainingService.isActive, false);
});

test('el fin de la caja cierra el entreno arrancado por un cruce', () => {
  cruce(2, 11_000);
  SerialService.emit('race_finished');
  assert.equal(TrainingService.isStandby, true);
  assert.equal(carril(2).count, 1, 'los datos siguen a la vista');
});
