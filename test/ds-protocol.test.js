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
// Lector común de la familia DS (dsProtocol): separa las tramas del flujo de
// bytes como TicTacSlot — 0xE0, 0xEB 20 bytes después y checksum — sin depender
// de los silencios del cable. Y la integración con SerialService: retransmisiones
// por caja, sea cual sea el corte con el que lleguen.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { createFrameSplitter, decodeFrame } = require('../src/lib/dsProtocol');
const { CircuitConnection } = require('../src/services/SerialService');
const { sellar } = require('./helpers/dsFrame');

after(limpiarBdTemporal);

const hex = (s) => s.trim().split(/\s+/).map(h => parseInt(h, 16));

function cruce({ seq = 0x10, carril = 0x80, vuelta = 0x02, seg = 0x08, caja = 0 } = {}) {
  const f = new Array(21).fill(0);
  f[0] = 0xe0; f[1] = seq; f[4] = caja; f[7] = 0x1b; f[10] = carril; f[12] = vuelta; f[15] = seg; f[16] = 0x12;
  return sellar(f);
}

function circuito({ boxes = 1 } = {}) {
  const cruces = [];
  const noop = () => {};
  const c = new CircuitConnection(0, 0, x => cruces.push(x), noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  c._setConnected = () => {};
  c._boxesPerPort = boxes;
  return { c, cruces };
}

// ── El separador ────────────────────────────────────────────────────────────

test('una trama entera sale tal cual, con la hora de su 0xE0', () => {
  const sp = createFrameSplitter();
  const { frames, discarded } = sp.push(cruce(), 500);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].ts, 500);
  assert.deepEqual(discarded, []);
});

test('tramas pegadas se separan; una partida espera a su resto', () => {
  const sp = createFrameSplitter();
  const a = cruce({ seq: 1 }), b = cruce({ seq: 2, carril: 0x40 });
  const todo = [...a, ...b];
  const r1 = sp.push(todo.slice(0, 30), 100);
  assert.equal(r1.frames.length, 1);
  assert.equal(sp.pending(), 9, 'los 9 primeros bytes de la 2ª esperan');
  const r2 = sp.push(todo.slice(30), 140);
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].ts, 100, 'su 0xE0 llegó en la primera lectura');
  assert.equal(sp.pending(), 0);
});

test('byte a byte también funciona', () => {
  const sp = createFrameSplitter();
  let n = 0;
  cruce().forEach((x, i) => { n += sp.push([x], i).frames.length; });
  assert.equal(n, 1);
});

test('la cola de una trama partida se descarta y la siguiente se lee entera', () => {
  // Bloque real de RESISLEMANS 1: empieza por la cola de una retransmisión.
  const sp = createFrameSplitter();
  const r = sp.push(hex('1b a9 00 04 00 01 00 aa ab aa aa 54 00 eb e0 7b 15 03 00 04 4c 1b 00 00 80 00 01 00 aa ab aa aa 28 00 eb'), 0);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].frame[10], 0x80);
  assert.deepEqual(r.discarded.map(d => d.bytes.length), [14]);
});

test('una trama con el checksum mal no se acepta y no tapa a la siguiente', () => {
  const sp = createFrameSplitter();
  const mala = cruce({ seq: 1 }); mala[18] ^= 0x01;
  const r = sp.push([...mala, ...cruce({ seq: 2 })], 0);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].frame[1], 2);
  assert.equal(r.discarded.reduce((n, d) => n + d.bytes.length, 0), 21);
});

test('un 0xE0 dentro de los datos no abre una trama falsa', () => {
  const sp = createFrameSplitter();
  const r = sp.push([0x00, 0xe0, 0x11, 0x22, ...cruce()], 0);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].frame[0], 0xe0);
  assert.equal(r.frames[0].frame[7], 0x1b);
});

test('la cola pendiente nunca pasa de una trama', () => {
  const sp = createFrameSplitter();
  for (let i = 0; i < 500; i++) sp.push([0xe0, 0x01, 0x02], i);
  assert.ok(sp.pending() < 21);
});

test('decodeFrame: GO, fin, latido y cruce', () => {
  assert.deepEqual(decodeFrame('ds300', hex('e0 12 15 03 00 04 4c 3e a1 00 57 00 00 00 00 00 00 00 b0 00 eb')),
    { type: 'go', durationMs: 57 * 60000 });
  assert.equal(decodeFrame('ds300', hex('e0 22 15 03 00 04 4c 00 a4 00 00 00 00 00 00 00 00 00 2d 00 eb')).type, 'finish');
  assert.deepEqual(decodeFrame('ds300', hex('e0 42 15 03 00 04 4c 00 c0 00 00 00 00 00 49 00 00 00 b3 00 eb')),
    { type: 'heartbeat', minute: 0x49 });
  const c = decodeFrame('ds300', hex('e0 b5 15 03 00 04 4c 1b 00 00 01 03 08 00 00 09 66 00 b3 00 eb'));
  assert.equal(c.type, 'crossing');
  assert.deepEqual(c.lanes, [8]);
  assert.equal(c.lapMs, 9660);
  assert.equal(c.counter, 8);
});

// ── Retransmisiones en SerialService ────────────────────────────────────────

test('las 3 copias de una trama cuentan una vez, lleguen juntas o separadas', () => {
  const { c, cruces } = circuito();
  const f = cruce();
  c._processFrame([...f, ...f.slice(0, 10)], 1000);
  c._processFrame([...f.slice(10), ...f], 1030);
  assert.equal(cruces.length, 1);
});

test('dos tramas distintas con la misma secuencia no se confunden', () => {
  // El número de secuencia da la vuelta; solo es copia si los bytes son iguales.
  const { c, cruces } = circuito();
  c._processFrame(cruce({ seq: 0x20, carril: 0x80 }), 1000);
  c._processFrame(cruce({ seq: 0x20, carril: 0x40 }), 2000);
  assert.deepEqual(cruces.map(x => x.lane), [1, 2]);
});

test('agrupador: la retransmisión se mira por caja', () => {
  const { c, cruces } = circuito({ boxes: 2 });
  const c1 = cruce({ seq: 5, caja: 1 }), c2 = cruce({ seq: 9, caja: 2 });
  c._processFrame([...c1, ...c2, ...c1, ...c2], 1000);
  assert.deepEqual(cruces.map(x => x.lane), [1, 9]);
});

test('un bloqueo del hilo principal no parte tramas: los bytes acumulados se leen enteros', () => {
  // Antes, 75 ms sin procesar bytes partían la trama por el corte de silencio.
  const { c, cruces } = circuito();
  const tres = [...cruce({ seq: 1, carril: 0x80 }), ...cruce({ seq: 2, carril: 0x40 }), ...cruce({ seq: 3, carril: 0x20 })];
  c._processFrame(tres.slice(0, 5), 0);
  c._processFrame(tres.slice(5), 400);
  assert.deepEqual(cruces.map(x => x.lane), [1, 2, 3]);
});
