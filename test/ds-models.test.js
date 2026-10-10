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
// Familia DS (DS-300, DS-200, DS-030, DS-080): el carril se codifica distinto y
// el DS-080 lleva dos circuitos por un puerto. Las tramas de ejemplo salen de
// TicTacSlot-cuentavueltas-protocolos.md, no de un aparato real.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { CircuitConnection } = require('../src/services/SerialService');
const { createDecoder } = require('../src/lib/frameDecoder');
const { normalizeModel, modelInfo, isControlFrame, crossingLanes } = require('../src/lib/dsModels');

after(limpiarBdTemporal);

function circuito(model, { boxes = 1 } = {}) {
  const cruces = [], eventos = [];
  const noop = () => {};
  const c = new CircuitConnection(
    0, 0,
    cruce => cruces.push(cruce),
    () => eventos.push('go'), () => eventos.push('stop'), () => eventos.push('pause'), () => eventos.push('resume'),
    noop, () => eventos.push('finish'), noop, noop, noop, noop,
  );
  c._setConnected = () => {};
  c._model = model;
  c._boxesPerPort = boxes;
  return { c, cruces, eventos };
}

function trama({ tipo = 0x1b, evento = 0x00, carril = 0x00, caja = 0x00, vuelta = 0x05, seg = 0x12, cent = 0x34 } = {}) {
  const f = new Array(21).fill(0);
  f[0] = 0xe0; f[4] = caja; f[7] = tipo; f[8] = evento; f[10] = carril;
  f[12] = vuelta; f[14] = 0x00; f[15] = seg; f[16] = cent; f[17] = 0x00;
  f[20] = 0xeb;
  return f;
}

test('modelo desconocido o ausente → DS-300', () => {
  assert.equal(normalizeModel(undefined), 'ds300');
  assert.equal(normalizeModel('xx'), 'ds300');
  assert.equal(normalizeModel('ds200'), 'ds200');
  assert.equal(normalizeModel('toString'), 'ds300', 'no debe colarse una propiedad heredada');
});

test('velocidad y carriles por defecto de cada modelo', () => {
  assert.equal(modelInfo('ds300').baud, 56000);
  for (const m of ['ds200', 'ds030', 'ds080']) assert.equal(modelInfo(m).baud, 4800);
  assert.equal(modelInfo('ds200').lanes, 2);
  assert.equal(modelInfo('ds080').boxes, 2);
});

test('DS-300/030/080: el carril es una máscara de bits (puede haber varios)', () => {
  for (const m of ['ds300', 'ds030', 'ds080']) {
    assert.deepEqual(crossingLanes(m, trama({ carril: 0x80 })), [1]);
    assert.deepEqual(crossingLanes(m, trama({ carril: 0x01 })), [8]);
    assert.deepEqual(crossingLanes(m, trama({ carril: 0xa0 })), [1, 3]);
  }
});

test('DS-200: 0x00 y 0x01 son el carril 1, 0x02 el carril 2, el resto no vale', () => {
  assert.deepEqual(crossingLanes('ds200', trama({ carril: 0x00 })), [1]);
  assert.deepEqual(crossingLanes('ds200', trama({ carril: 0x01 })), [1]);
  assert.deepEqual(crossingLanes('ds200', trama({ carril: 0x02 })), [2]);
  assert.deepEqual(crossingLanes('ds200', trama({ carril: 0x04 })), []);
});

test('DS-200 distingue cruce de control por byte[7]; el resto por byte[10]', () => {
  assert.equal(isControlFrame('ds200', trama({ tipo: 0x1b, carril: 0x00 })), false);
  assert.equal(isControlFrame('ds200', trama({ tipo: 0x00, evento: 0xa5, carril: 0x00 })), true);
  assert.equal(isControlFrame('ds300', trama({ tipo: 0x00, carril: 0x00 })), true);
  assert.equal(isControlFrame('ds300', trama({ tipo: 0x00, carril: 0x80 })), false);
});

test('DS-200: un cruce en el carril 1 con byte[10]=0x00 se registra', () => {
  const { c, cruces } = circuito('ds200');
  c._processFrame(trama({ carril: 0x00 }), 1000);
  assert.equal(cruces.length, 1);
  assert.equal(cruces[0].lane, 1);
  assert.equal(cruces[0].lapTimeMs, 12340);
});

test('DS-200: carril 2 y vuelta siguiente', () => {
  const { c, cruces } = circuito('ds200');
  c._processFrame(trama({ carril: 0x02, vuelta: 0x01 }), 1000);
  c._processFrame(trama({ carril: 0x02, vuelta: 0x02, seg: 0x13 }), 14000);
  assert.deepEqual(cruces.map(x => x.lane), [2, 2]);
});

test('DS-200: un byte de carril inválido se descarta sin lanzar ni inventar cruces', () => {
  const { c, cruces } = circuito('ds200');
  assert.doesNotThrow(() => c._processFrame(trama({ carril: 0x04 }), 1000));
  assert.equal(cruces.length, 0);
});

test('DS-200: las tramas de evento (pausa, fin) siguen siendo control aunque byte[10] valga 0', () => {
  const { c, cruces, eventos } = circuito('ds200');
  c._processFrame(trama({ tipo: 0x00, evento: 0xa5 }), 1000);
  c._processFrame(trama({ tipo: 0x00, evento: 0xa4 }), 2000);
  assert.deepEqual(eventos, ['pause', 'finish']);
  assert.equal(cruces.length, 0);
});

test('DS-080: byte[4]=2 es el circuito 2 (carriles 9-16); otro valor, el circuito 1', () => {
  const { c, cruces } = circuito('ds080', { boxes: 2 });
  c._processFrame(trama({ carril: 0x80, caja: 0x02, vuelta: 0x01 }), 1000);
  c._processFrame(trama({ carril: 0x80, caja: 0x00, vuelta: 0x01 }), 1100);
  c._processFrame(trama({ carril: 0x80, caja: 0x01, vuelta: 0x02, seg: 0x15 }), 14000);
  assert.deepEqual(cruces.map(x => x.lane), [9, 1, 1]);
});

test('el DS-300 sigue igual: una trama con byte[10]=0 y byte[7]=0x1B es control, no cruce', () => {
  const { c, cruces } = circuito('ds300');
  c._processFrame(trama({ tipo: 0x1b, carril: 0x00 }), 1000);
  assert.equal(cruces.length, 0);
  c._disarmWatchdog();
});

test('el latido de 60 s solo se vigila en el DS-300', () => {
  const dos = circuito('ds200').c;
  dos._armWatchdog();
  assert.equal(dos._watchdogTimer, null, 'un silencio legítimo no puede cerrar el puerto');

  const tres = circuito('ds300').c;
  tres._armWatchdog();
  assert.notEqual(tres._watchdogTimer, null);
  tres._disarmWatchdog();
});

test('visor de tramas: el DS-200 etiqueta el carril 1 con byte[10]=0 como cruce', () => {
  const dec = createDecoder();
  const f = dec.ds(trama({ carril: 0x00 }), { model: 'ds200' });
  assert.equal(f.kind, 'crossing');
  assert.deepEqual(f.lanes, [1]);
});

test('visor de tramas: sin modelo se comporta como el DS-300', () => {
  const dec = createDecoder();
  const f = dec.ds(trama({ tipo: 0x1b, carril: 0x80 }));
  assert.equal(f.kind, 'crossing');
  assert.deepEqual(f.lanes, [1]);
});
