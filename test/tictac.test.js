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
// Interface TicTacSlot: trama HID de 16 bytes con reloj de minutos + ms. Las tramas
// de los primeros tests son de la captura REAL del club (2026-10-09); en ella los
// tiempos de vuelta cuadran con la hora de llegada al PC a ±2 ms, y es lo que
// demostró que el reloj no es un contador lineal de 24 bits.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/lib/tictacProtocol');
const TicTacConnection = require('../src/services/TicTacConnection');
const { createDecoder } = require('../src/lib/frameDecoder');

after(limpiarBdTemporal);

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// Captura real: carril 3, vueltas 8, 9 y 10 (la 9→10 cruza un cambio de minuto).
const L3_V8  = hex('C0 09 1B 00 03 00 08 00 02 55 2B 00 00 00 00 00');
const L3_V9  = hex('C0 0C 1B 00 03 00 09 00 02 87 CC 00 00 00 00 00');
const L3_V10 = hex('C0 0E 1B 00 03 00 0A 00 03 3B 3E 00 00 00 00 00');
// Captura real: carril 2, vueltas 3 y 4.
const L2_V3  = hex('C0 0A 1B 00 02 00 03 00 02 55 85 00 00 00 00 00');
const L2_V4  = hex('C0 0B 1B 00 02 00 04 00 02 86 DD 00 00 00 00 00');

function conexion(laneOffset = 0) {
  const cruces = [];
  const noop = () => {};
  const c = new TicTacConnection(0, laneOffset, x => cruces.push(x), noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  return { c, cruces };
}

// Trama de cruce sintética con el reloj ya en (minutos, ms, décimas).
function cruce({ lane = 1, lap = 1, min = 0, ms = 0, dec = 0, seq = 0 }) {
  const b = Buffer.alloc(16);
  b[0] = 0xc0; b[1] = seq; b[2] = 0x1b; b[4] = lane;
  b.writeUInt16BE(lap, 5);
  b.writeUInt16BE(min, 7);
  b.writeUInt16BE(ms, 9);
  b[11] = dec;
  return b;
}

test('el reloj son minutos + ms: la vuelta que cruza un minuto cuadra con la hora de llegada', () => {
  const v8  = P.decodificar(L3_V8),  v9 = P.decodificar(L3_V9), v10 = P.decodificar(L3_V10);
  assert.equal(v8.lane, 3);
  assert.equal(v8.lap, 8);
  assert.equal(P.deltaReloj(v8.clockMs, v9.clockMs), 12961);    // PC: 22.859 → 35.819 = 12.960
  assert.equal(P.deltaReloj(v9.clockMs, v10.clockMs), 40402);   // PC: 35.819 → 16.223 = 40.404
  // Leído como 24 bits lineales daría 45938: el salto falso de 5536 ms.
  const lineal = (b) => (b[8] << 16) | (b[9] << 8) | b[10];
  assert.equal(lineal(L3_V10) - lineal(L3_V9), 45938);
});

test('deltaReloj da la vuelta al reloj', () => {
  assert.equal(P.deltaReloj(P.CLOCK_MOD - 1000, 500), 1500);
});

test('un cruce lleva carril, nº de vuelta de 16 bits y décimas de ms', () => {
  const d = P.decodificar(cruce({ lane: 5, lap: 300, min: 12, ms: 34321, dec: 5 }));
  assert.deepEqual([d.tipo, d.lane, d.lap, d.clockMs], ['cruce', 5, 300, 12 * 60000 + 34321 + 0.5]);
});

test('una trama de evento se decodifica con su nombre', () => {
  const ev = Buffer.alloc(16); ev[0] = 0xc0; ev[2] = 0x1c; ev[3] = 0xa5;
  const d = P.decodificar(ev);
  assert.deepEqual([d.tipo, d.nombre], ['evento', 'pausa']);
});

test('extraerTramas: basura delante, dos tramas juntas y una a medias', () => {
  const flujo = Buffer.concat([Buffer.from([0x00, 0x7f]), L3_V8, L3_V9, L3_V10.subarray(0, 7)]);
  const { frames, rest } = P.extraerTramas(flujo);
  assert.equal(frames.length, 2);
  assert.deepEqual(Buffer.from(frames[1]), L3_V9);
  assert.equal(rest.length, 7, 'la cola se conserva para completarla con el siguiente trozo');
});

test('extraerTramas: un 0xC0 suelto con tipo desconocido no es sincronismo', () => {
  const falso = Buffer.alloc(16); falso[0] = 0xc0; falso[2] = 0x55;
  const { frames } = P.extraerTramas(Buffer.concat([falso, L3_V8]));
  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0]), L3_V8);
});

test('conexión: el primer cruce no trae tiempo; el siguiente, la resta de relojes', () => {
  const { c, cruces } = conexion();
  c._onData(L3_V8);
  c._onData(L3_V9);
  c._onData(L3_V10);
  assert.deepEqual(cruces.map(x => x.lapTimeMs), [null, 12961, 40402]);
  assert.ok(cruces.every(x => x.lane === 3));
});

test('conexión: cada carril lleva su propia referencia, aunque lleguen mezclados', () => {
  const { c, cruces } = conexion();
  for (const t of [L3_V8, L2_V3, L2_V4, L3_V9]) c._onData(t);
  assert.deepEqual(cruces.map(x => [x.lane, x.lapTimeMs]), [[3, null], [2, null], [2, 12632], [3, 12961]]);
});

test('conexión: el offset del circuito se suma al carril', () => {
  const { c, cruces } = conexion(8);
  c._onData(L3_V8);
  assert.equal(cruces[0].lane, 11);
});

test('conexión: tramas partidas byte a byte se recomponen igual', () => {
  const { c, cruces } = conexion();
  for (const t of [L3_V8, L3_V9]) for (const byte of t) c._onData(Buffer.from([byte]));
  assert.deepEqual(cruces.map(x => x.lapTimeMs), [null, 12961]);
});

test('conexión: un rebote se descarta y NO acorta la vuelta real siguiente', () => {
  const { c, cruces } = conexion();
  c._onData(cruce({ lap: 1, ms: 1000 }));
  c._onData(cruce({ lap: 2, ms: 1300 }));      // 300 ms después: rebote
  c._onData(cruce({ lap: 2, ms: 13000 }));     // la vuelta real, medida desde el cruce de 1000
  assert.deepEqual(cruces.map(x => x.lapTimeMs), [null, 12000]);
});

test('conexión: tras un silencio de > 240 s el cruce es un «primero» y fija la referencia nueva', () => {
  const { c, cruces } = conexion();
  c._onData(cruce({ lap: 1, min: 0, ms: 5000 }));
  c._onData(cruce({ lap: 2, min: 10, ms: 0 }));          // manga nueva, 10 min después
  c._onData(cruce({ lap: 3, min: 10, ms: 13000 }));
  assert.deepEqual(cruces.map(x => x.lapTimeMs), [null, null, 13000]);
});

test('conexión: carril fuera de 1-8 se descarta sin lanzar', () => {
  const { c, cruces } = conexion();
  assert.doesNotThrow(() => c._onData(cruce({ lane: 0 })));
  assert.doesNotThrow(() => c._onData(cruce({ lane: 9 })));
  assert.equal(cruces.length, 0);
});

test('conexión: los eventos del aparato se ignoran (la carrera la manda PitWall)', () => {
  const { c, cruces } = conexion();
  const ev = Buffer.alloc(16); ev[0] = 0xc0; ev[2] = 0x1c; ev[3] = 0xa3;
  c._onData(ev);
  assert.equal(cruces.length, 0);
});

test('conexión: basura sin sincronismo no hace crecer el buffer', () => {
  const { c } = conexion();
  c._onData(Buffer.alloc(100000, 0x42));
  assert.ok(c._buf.length < 16);
});

test('conexión: tras exportar/importar el estado, el primer cruce ya trae tiempo', () => {
  const a = conexion();
  a.c._onData(L3_V8);
  const b = conexion();
  b.c.importLaneState(a.c.exportLaneState());
  b.c._onData(L3_V9);
  assert.equal(b.cruces[0].lapTimeMs, 12961);
});

test('visor de tramas: etiqueta cruces con su tiempo y ignora los eventos', () => {
  const dec = createDecoder();
  const a = dec.tictac(L3_V8, {});
  const b = dec.tictac(L3_V9, {});
  assert.equal(a.kind, 'crossing');
  assert.equal(a.fields.find(f => f.k === 'tiempo').v, 'primera vuelta');
  assert.match(b.fields.find(f => f.k === 'tiempo').v, /12,?\.?961/);
  const ev = Buffer.alloc(16); ev[0] = 0xc0; ev[2] = 0x1c; ev[3] = 0xa5;
  assert.equal(dec.tictac(ev, {}).kind, 'ignored');
});

// ── USB (HID): autodetección por VID/PID, enganche y reenganche ──────────────

const EventEmitter = require('node:events');

function hidFalso({ presente = false } = {}) {
  const estado = { presente, abiertos: [], listados: 0 };
  class HID extends EventEmitter {
    constructor(path) { super(); this.path = path; this.cerrado = false; estado.abiertos.push(this); }
    close() { this.cerrado = true; }
  }
  const info = (extra = {}) => ({ vendorId: 0x04d8, productId: 0x0001, path: 'IOService:/tictac', usagePage: 0xffa0, product: 'TicTac', ...extra });
  const modulo = {
    HID,
    devices() {
      estado.listados++;
      const otros = [{ vendorId: 0x046d, productId: 0xc52b, path: 'raton' }];   // un ratón cualquiera
      return estado.presente ? [...otros, info()] : otros;
    },
  };
  return { modulo, estado };
}

function conexionUsb(fake) {
  TicTacConnection.setHidLoader(() => fake.modulo);
  const r = conexion();
  r.c._startUsbScan = () => {};          // los tests llaman a _scanUsbOnce a mano, sin temporizadores
  return r;
}

test('USB: sin aparato conectado arranca sin error y queda a la espera', async () => {
  const fake = hidFalso({ presente: false });
  const { c } = conexionUsb(fake);
  await c.connectUsb();
  assert.equal(c.connected, false);
  assert.equal(c.path, null);
  assert.equal(c.usbError, null);
});

test('USB: al enchufarlo lo detecta por VID/PID, ignora otros HID y lee cruces', async () => {
  const fake = hidFalso({ presente: false });
  const { c, cruces } = conexionUsb(fake);
  await c.connectUsb();
  fake.estado.presente = true;
  c._scanUsbOnce();
  assert.equal(c.connected, true);
  assert.equal(c.path, 'hid://04d8:0001');
  assert.equal(fake.estado.abiertos.length, 1);
  assert.equal(fake.estado.abiertos[0].path, 'IOService:/tictac', 'abre el TicTacSlot, no el ratón');

  const dev = fake.estado.abiertos[0];
  dev.emit('data', L3_V8);
  dev.emit('data', L3_V9);
  assert.deepEqual(cruces.map(x => x.lapTimeMs), [null, 12961]);
});

test('USB: Windows antepone el ID de informe 0x00 y la trama se lee igual', async () => {
  const fake = hidFalso({ presente: true });
  const { c, cruces } = conexionUsb(fake);
  await c.connectUsb();
  const dev = fake.estado.abiertos[0];
  dev.emit('data', Buffer.concat([Buffer.from([0x00]), L3_V8]));
  dev.emit('data', Buffer.concat([Buffer.from([0x00]), L3_V9]));
  assert.deepEqual(cruces.map(x => x.lapTimeMs), [null, 12961]);
});

test('USB: al desenchufarlo se marca caído y, al volver, se reengancha conservando la referencia', async () => {
  const fake = hidFalso({ presente: true });
  const { c, cruces } = conexionUsb(fake);
  await c.connectUsb();
  const primero = fake.estado.abiertos[0];
  primero.emit('data', L3_V8);

  fake.estado.presente = false;
  primero.emit('error', new Error('could not read from HID device'));
  assert.equal(c.connected, false, 'el desenchufado se detecta (no queda «conectado» en falso)');
  assert.equal(primero.cerrado, true);

  c._scanUsbOnce();                       // sigue sin estar: no pasa nada
  assert.equal(c.connected, false);

  fake.estado.presente = true;
  c._scanUsbOnce();
  assert.equal(c.connected, true);
  assert.equal(fake.estado.abiertos.length, 2);
  fake.estado.abiertos[1].emit('data', L3_V9);
  assert.equal(cruces[1].lapTimeMs, 12961, 'la referencia de reloj sobrevive al corte');
});

test('USB: un error de un dispositivo ya descartado no afecta al nuevo', async () => {
  const fake = hidFalso({ presente: true });
  const { c } = conexionUsb(fake);
  await c.connectUsb();
  const viejo = fake.estado.abiertos[0];
  viejo.emit('error', new Error('perdido'));
  c._scanUsbOnce();
  assert.equal(c.connected, true);
  viejo.emit('error', new Error('eco tardío'));
  assert.equal(c.connected, true);
});

test('USB: sin el módulo node-hid no lanza y deja el motivo', async () => {
  TicTacConnection.setHidLoader(() => { throw new Error('Cannot find module node-hid'); });
  const { c } = conexion();
  c._startUsbScan = () => {};
  await assert.doesNotReject(() => c.connectUsb());
  assert.equal(c.connected, false);
  assert.match(c.usbError, /node-hid/);
  assert.equal(TicTacConnection.listDevices().available, false);
});

test('USB: close() suelta el dispositivo y no se reengancha', async () => {
  const fake = hidFalso({ presente: true });
  const { c } = conexionUsb(fake);
  await c.connectUsb();
  const dev = fake.estado.abiertos[0];
  await c.close();
  assert.equal(dev.cerrado, true);
  c._scanUsbOnce();
  assert.equal(fake.estado.abiertos.length, 1);
});

test('listDevices informa de si el aparato está conectado', () => {
  const fake = hidFalso({ presente: true });
  TicTacConnection.setHidLoader(() => fake.modulo);
  const r = TicTacConnection.listDevices();
  assert.equal(r.available, true);
  assert.equal(r.devices.length, 1);
  assert.equal(r.devices[0].product, 'TicTac');
  fake.estado.presente = false;
  assert.equal(TicTacConnection.listDevices().devices.length, 0);
});

test('con el módulo real node-hid listDevices no lanza (aquí no hay aparato)', () => {
  TicTacConnection.setHidLoader();
  const r = TicTacConnection.listDevices();
  assert.equal(typeof r.available, 'boolean');
  assert.ok(Array.isArray(r.devices));
});
