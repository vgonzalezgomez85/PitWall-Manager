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
// Reloj de la carrera simulada. Los cruces simulados llegan con la hora de su
// trama; si arranque, pausas y fin usaban el reloj de pared, la resta salía con
// relojes distintos (elapsed_ms ≈ −1,8·10¹², coma 0.99 y last_cross_ms 0 en
// todos los carriles).

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TimingService = require('../src/services/TimingService');
const SerialService = require('../src/services/SerialService');

after(limpiarBdTemporal);
beforeEach(() => { SerialService._simReplay = true; });
afterEach(() => { TimingService.simClearClock(); SerialService._simReplay = false; });

const realNow = Date.now;
function conReloj(ms, fn) {
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

test('sin simulación el reloj es el de pared', () => {
  conReloj(1234, () => assert.equal(TimingService.now(), 1234));
});

test('una simulación que se quedó sin «Parar» no se lleva el reloj al volver al DS', () => {
  TimingService.simSetClock(40_000_000);
  SerialService._simReplay = false;
  conReloj(1234, () => assert.equal(TimingService.now(), 1234));
});

test('va a ×rate desde la hora de la trama y no pasa de la siguiente', () => {
  conReloj(1_000_000, () => TimingService.simSetClock(40_000_000, 10, 40_005_000));
  conReloj(1_000_200, () => assert.equal(TimingService.now(), 40_002_000));
  conReloj(1_009_000, () => assert.equal(TimingService.now(), 40_005_000));
});

test('rate 0 lo congela y simSetRate no lo mueve', () => {
  conReloj(1_000_000, () => TimingService.simSetClock(5_000, 4, 9_000));
  conReloj(1_000_500, () => TimingService.simSetRate(0));
  conReloj(1_060_000, () => assert.equal(TimingService.now(), 7_000));
  conReloj(1_060_000, () => TimingService.simSetRate(2));
  conReloj(1_060_500, () => assert.equal(TimingService.now(), 8_000));
});

test('una pausa mide tiempo de trama: la del panel (reloj parado) dura 0', () => {
  TimingService.session = {
    startTime: 0, durationMs: 60_000,
    circuits: { 0: { index: 0, status: 'running', startTime: 10_000, durationMs: 60_000 } },
  };
  try {
    TimingService.simSetClock(30_000);
    assert.equal(TimingService._circuitElapsedMs(0), 20_000);
    const c = TimingService.session.circuits[0];
    c.status = 'paused'; c.pauseStart = TimingService.now();
    conReloj(realNow() + 120_000, () => assert.equal(TimingService._circuitElapsedMs(0), 20_000));
  } finally {
    TimingService.session = null;
  }
});
