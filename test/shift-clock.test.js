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
// El contador de turnos DERIVA del reloj efectivo de cada circuito; no acumula
// ticks. Aquí se clava esa propiedad y los cuatro estados de circuito, montando
// la sesión a mano: no hace falta hardware ni esperar tiempo real, basta con
// colocar startTime/pauseStart/endTime en el pasado.
//
// Con 24 carriles en 3 cajas (Llinars) los casos "GO escalonado" y "un circuito
// termina antes que otro" dejan de ser teóricos, así que están aquí abajo.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TimingService = require('../src/services/TimingService');

after(limpiarBdTemporal);

const MIN = 60000;

/**
 * Sesión mínima con 3 circuitos de 8 carriles (24 en total, como Llinars).
 * `estados`: uno por circuito, p.ej.
 *   { status:'running',  desdeMs: 30*MIN }                       → arrancó hace 30'
 *   { status:'paused',   desdeMs: 30*MIN, pausadoHaceMs: 5*MIN } → pausado hace 5'
 *   { status:'finished', desdeMs: 30*MIN, finHaceMs: 5*MIN }     → terminó hace 5'
 *   { status:'pending' }                                          → aún sin su GO
 */
function montarSesion(estados) {
  const now = Date.now();
  const circuits = {};
  const laneToCircuit = {};
  estados.forEach((e, ci) => {
    for (let l = ci * 8 + 1; l <= ci * 8 + 8; l++) laneToCircuit[l] = ci;
    circuits[ci] = {
      index: ci,
      status: e.status,
      startTime:  e.status === 'pending' ? null : now - e.desdeMs,
      pauseStart: e.pausadoHaceMs != null ? now - e.pausadoHaceMs : null,
      endTime:    e.finHaceMs     != null ? now - e.finHaceMs     : null,
      durationMs: 24 * 60 * MIN,
      autoStopTimer: null,
      laneCount: 8,
    };
  });
  TimingService.session = { manga: { id: 1 }, race: { id: 1 }, circuits, laneToCircuit };
  TimingService._isChampionship = true;
  TimingService._activeShiftsByLane = {};
  return TimingService;
}

/** Turno abierto en `lane` que empezó a contar con el circuito en `openElapsedMs`. */
function turnoAbierto(lane, { openElapsedMs = 0, baseMs = 0, ci } = {}) {
  const entry = {
    shiftId: lane, baseMs, openElapsedMs, drivingMs: baseMs,
    ci: ci !== undefined ? ci : TimingService._laneCircuit(lane),
  };
  TimingService._activeShiftsByLane[lane] = entry;
  return entry;
}

/** Igualdad con holgura: el reloj de pared avanza entre montar y medir. */
function casiIgual(real, esperado, tol = 200) {
  assert.ok(Math.abs(real - esperado) <= tol,
    `esperaba ~${esperado} ms, obtuve ${real} ms (Δ ${real - esperado} ms)`);
}

beforeEach(() => { TimingService.session = null; TimingService._activeShiftsByLane = {}; });

test('un turno abierto desde el GO acumula el elapsed del circuito', () => {
  const ts = montarSesion([{ status: 'running', desdeMs: 30 * MIN }]);
  const e = turnoAbierto(1);
  casiIgual(ts._drivingMsOf(e), 30 * MIN);
});

test('un turno abierto a mitad de manga solo cuenta desde su relevo', () => {
  const ts = montarSesion([{ status: 'running', desdeMs: 30 * MIN }]);
  const e = turnoAbierto(1, { openElapsedMs: 10 * MIN });   // entró en el minuto 10
  casiIgual(ts._drivingMsOf(e), 20 * MIN);
});

test('el tiempo NO se trunca a segundos: la fracción cuenta', () => {
  const ts = montarSesion([{ status: 'running', desdeMs: 30 * MIN + 750 }]);
  const e = turnoAbierto(1);
  const ms = ts._drivingMsOf(e);
  assert.ok(ms % 1000 !== 0, `el contador está cuantizado a segundos: ${ms} ms`);
  casiIgual(ms, 30 * MIN + 750);
});

test('un circuito PENDING (GO escalonado) no suma tiempo a sus pilotos', () => {
  // Caja 1 lleva 30' rodando; la caja 2 aún no ha recibido su GO.
  const ts = montarSesion([{ status: 'running', desdeMs: 30 * MIN }, { status: 'pending' }]);
  casiIgual(ts._drivingMsOf(turnoAbierto(1)), 30 * MIN);   // carril de la caja 1
  assert.equal(ts._drivingMsOf(turnoAbierto(9)), 0);       // carril de la caja 2
});

test('un circuito PAUSADO congela a sus pilotos en el instante de la pausa', () => {
  // Arrancó hace 30', se pausó hace 5' → sus pilotos llevan 25'.
  const ts = montarSesion([{ status: 'paused', desdeMs: 30 * MIN, pausadoHaceMs: 5 * MIN }]);
  const e = turnoAbierto(1);
  assert.equal(ts._drivingMsOf(e), 25 * MIN);   // exacto: no depende de Date.now()
});

test('la pausa de una caja no congela a los pilotos de las otras', () => {
  const ts = montarSesion([
    { status: 'paused',  desdeMs: 30 * MIN, pausadoHaceMs: 5 * MIN },
    { status: 'running', desdeMs: 30 * MIN },
  ]);
  assert.equal(ts._drivingMsOf(turnoAbierto(1)), 25 * MIN);   // caja 1, pausada
  casiIgual(ts._drivingMsOf(turnoAbierto(9)), 30 * MIN);      // caja 2, rodando
});

test('un circuito FINALIZADO deja de sumar aunque los demás sigan', () => {
  // La caja 1 terminó hace 5'; la caja 2 sigue. Sin endTime, la 1 seguiría creciendo.
  const ts = montarSesion([
    { status: 'finished', desdeMs: 30 * MIN, finHaceMs: 5 * MIN },
    { status: 'running',  desdeMs: 30 * MIN },
  ]);
  assert.equal(ts._drivingMsOf(turnoAbierto(1)), 25 * MIN);
  casiIgual(ts._drivingMsOf(turnoAbierto(9)), 30 * MIN);
});

test('un carril sin circuito conocido NO suma (fail-closed)', () => {
  const ts = montarSesion([{ status: 'running', desdeMs: 30 * MIN }]);
  const e = turnoAbierto(99, { ci: null });   // carril fuera de toda caja
  assert.equal(ts._drivingMsOf(e), 0);
});

test('un turno recuperado de BD conserva su tiempo previo y sigue sumando', () => {
  const ts = montarSesion([{ status: 'running', desdeMs: 10 * MIN }]);
  const e = turnoAbierto(1, { baseMs: 7 * MIN, openElapsedMs: 0 });
  casiIgual(ts._drivingMsOf(e), 17 * MIN);
});

test('el tiempo de un turno nunca retrocede por debajo de lo ya acumulado', () => {
  // simSetClock() re-ancla startTime en carreras simuladas y puede dejar el
  // elapsed por detrás del openElapsedMs del turno. El contador no puede bajar.
  const ts = montarSesion([{ status: 'running', desdeMs: 1 * MIN }]);
  const e = turnoAbierto(1, { baseMs: 5 * MIN, openElapsedMs: 20 * MIN });
  assert.equal(ts._drivingMsOf(e), 5 * MIN);
});

test('_circuitElapsedMs devuelve null para un circuito inexistente', () => {
  const ts = montarSesion([{ status: 'running', desdeMs: 1 * MIN }]);
  assert.equal(ts._circuitElapsedMs(7), null);
  assert.equal(ts._circuitElapsedMs(null), null);
});

test('reanudar desplaza el ancla: la pausa no se cobra al piloto', () => {
  // Simula lo que hace resumeCircuit(): startTime += pausedMs. El turno abierto
  // mantiene su openElapsedMs (elapsed, no wall-clock), así que la pausa se cae sola.
  const ts = montarSesion([{ status: 'paused', desdeMs: 30 * MIN, pausadoHaceMs: 5 * MIN }]);
  const e = turnoAbierto(1);
  assert.equal(ts._drivingMsOf(e), 25 * MIN);

  const c = ts.session.circuits[0];
  const pausedMs = Date.now() - c.pauseStart;   // los 5' de pausa
  c.startTime += pausedMs;
  c.status = 'running';
  c.pauseStart = null;

  // Justo tras el resume sigue en 25': la pausa no ha sumado nada.
  casiIgual(ts._drivingMsOf(e), 25 * MIN);
});

test('el snapshot de shifts mantiene el contrato { shiftId, drivingMs }', () => {
  // shifts-live.ejs lee data.active[lane].drivingMs por socket: no puede cambiar.
  const ts = montarSesion([{ status: 'running', desdeMs: 3 * MIN }]);
  turnoAbierto(1);
  const snap = ts.getActiveShifts();
  assert.ok(snap['1'] || snap[1], 'el snapshot debe indexarse por carril');
  const entry = snap['1'] || snap[1];
  assert.equal(entry.shiftId, 1);
  casiIgual(entry.drivingMs, 3 * MIN);
});
