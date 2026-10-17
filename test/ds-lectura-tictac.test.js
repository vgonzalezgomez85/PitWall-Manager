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
// Lectura de la familia DS como TicTacSlot, que lee bien todas las cajas: cruce
// o evento por byte[7], GO con cualquier clase, duración por formato, verde sin
// aviso previo, checksum y carril 0xAC. Tramas reales del DS antiguo a 4800
// baudios (entreno del 13-oct-2026) donde las hay.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { CircuitConnection } = require('../src/services/SerialService');
const { goDurationMs, checksumOk } = require('../src/lib/dsModels');
const { sellar } = require('./helpers/dsFrame');

after(limpiarBdTemporal);

const hex = (s) => s.trim().split(/\s+/).map(h => parseInt(h, 16));

function circuito() {
  const cruces = [], eventos = [], gos = [];
  const noop = () => {};
  const c = new CircuitConnection(
    0, 0,
    cruce => cruces.push(cruce),
    () => eventos.push('go'), () => eventos.push('stop'), () => eventos.push('pause'), () => eventos.push('resume'),
    ms => gos.push(ms), () => eventos.push('finish'), noop, noop, noop, noop,
  );
  c._setConnected = () => {};
  c._model = 'ds030';
  return { c, cruces, eventos, gos };
}

function evento(clase, codigo, extra = {}) {
  const f = new Array(21).fill(0);
  f[0] = 0xe0; f[7] = clase; f[8] = codigo;
  for (const [i, v] of Object.entries(extra)) f[+i] = v;
  return sellar(f);
}

function cruce({ carril = 0x80, vuelta = 0x02, min = 0x00, seg = 0x08, cent = 0x12 } = {}) {
  const f = new Array(21).fill(0);
  f[0] = 0xe0; f[7] = 0x1b; f[10] = carril; f[12] = vuelta;
  f[14] = min; f[15] = seg; f[16] = cent;
  return sellar(f);
}

// Tramas reales del DS antiguo (13-oct-2026).
const GO_CLUB    = hex('e0 21 15 03 00 04 4c 3a a1 01 00 00 00 00 00 00 00 00 65 00 eb');
const VERDE_CLUB = hex('e0 23 15 03 00 04 4c 00 a3 00 00 00 00 00 00 00 00 00 2e 00 eb');

test('las tramas reales del DS antiguo pasan el checksum', () => {
  assert.ok(checksumOk(GO_CLUB));
  assert.ok(checksumOk(VERDE_CLUB));
  assert.ok(checksumOk(hex('e0 1f 15 03 00 04 4c 1b a9 00 80 00 28 00 00 08 27 65 87 00 eb')));
});

test('duración del GO 0x3A: «01 00» son 10 min (las mangas reales duraron 600 s)', () => {
  assert.equal(goDurationMs(GO_CLUB), 600000);
  assert.equal(goDurationMs(evento(0x3a, 0xa1, { 10: 0x60 })), 360000, '00 60 = 6 min, no 60');
  assert.equal(goDurationMs(evento(0x3a, 0xa1, { 9: 0x12, 10: 0x34 })), (3600 + 2 * 600 + 3 * 60 + 40) * 1000);
});

test('duración del GO 0x3E: igual que antes por debajo de la hora; [9] son horas', () => {
  assert.equal(goDurationMs(evento(0x3e, 0xa1, { 10: 0x57 })), 57 * 60000, 'el GO real del DS-300 de Italia');
  assert.equal(goDurationMs(evento(0x3e, 0xa1, { 9: 0x01, 10: 0x05 })), 65 * 60000);
});

test('el GO real del DS antiguo arranca la manga con su duración', () => {
  const { c, eventos, gos } = circuito();
  c._processFrame(GO_CLUB, 1000);
  c._processFrame(VERDE_CLUB, 4000);
  assert.deepEqual(gos, [600000]);
  assert.deepEqual(eventos, ['go']);
});

test('el GO por vueltas (0x3B) también arranca, sin duración', () => {
  const { c, cruces, eventos, gos } = circuito();
  c._processFrame(evento(0x3b, 0xa1, { 9: 0x40, 10: 0x12 }), 1000);
  c._processFrame(evento(0x00, 0xa3), 4000);
  assert.deepEqual(gos, [0], 'sin duración: la pone la carrera');
  assert.deepEqual(eventos, ['go']);
  assert.equal(cruces.length, 0, 'byte[10]=0x12 no son los carriles 4 y 7');
});

test('el verde sin GO previo arranca la manga y reinicia los contadores', () => {
  const { c, cruces, eventos } = circuito();
  c._processFrame(cruce({ vuelta: 0x50 }), 1000);
  c._processFrame(evento(0x00, 0xa4), 2000);
  c._processFrame(evento(0x00, 0xa3), 3000);            // el GO se perdió
  assert.deepEqual(eventos, ['finish', 'go']);
  const antes = cruces.length;
  c._processFrame(cruce({ vuelta: 0x01 }), 11000);
  assert.equal(cruces.slice(antes).filter(x => x.missed).length, 0,
    'el contador de la caja vuelve a 1: no hay ~50 vueltas que reponer');
});

test('el verde tras una pausa reanuda aunque la caja no mande 0xA6', () => {
  const { c, eventos } = circuito();
  c._processFrame(GO_CLUB, 1000);
  c._processFrame(VERDE_CLUB, 4000);
  c._processFrame(evento(0x00, 0xa5), 10000);
  c._processFrame(evento(0x00, 0xa3), 20000);
  assert.deepEqual(eventos, ['go', 'pause', 'resume']);
});

test('con la manga en marcha, un verde suelto no la vuelve a arrancar', () => {
  const { c, eventos } = circuito();
  c._processFrame(GO_CLUB, 1000);
  c._processFrame(VERDE_CLUB, 4000);
  c._processFrame(VERDE_CLUB, 5000);
  assert.deepEqual(eventos, ['go']);
});

test('una trama con el checksum mal se descarta', () => {
  const { c, cruces } = circuito();
  const f = cruce();
  f[18] = (f[18] + 1) & 0xff;
  c._processFrame(f, 1000);
  assert.equal(cruces.length, 0);
});

test('un evento con datos en byte[10] no es un cruce', () => {
  const { c, cruces } = circuito();
  c._processFrame(evento(0x3a, 0xa1, { 10: 0x60 }), 1000);
  clearTimeout(c._goFallbackTimer);
  assert.equal(cruces.length, 0, 'antes salían cruces de los carriles 2 y 3');
});

test('0xAC en byte[10] es el carril 1', () => {
  const { c, cruces } = circuito();
  c._processFrame(cruce({ carril: 0xac }), 1000);
  assert.deepEqual(cruces.map(x => x.lane), [1]);
});

test('una vuelta de más de 4 minutos se cuenta (la caja la cuenta)', () => {
  const { c, cruces } = circuito();
  c._processFrame(cruce({ vuelta: 0x02, min: 0x04, seg: 0x30, cent: 0x00 }), 1000);
  assert.equal(cruces.length, 1);
  assert.equal(cruces[0].lapTimeMs, 270000);
});
