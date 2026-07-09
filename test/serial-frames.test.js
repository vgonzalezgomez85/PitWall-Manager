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
// El parser de tramas DS-300 es la puerta por la que entran los ~200.000 cruces de
// una 24 h. Un frame partido por un tirón de cable no puede tumbar el circuito.
//
// Auditoría 2026-07-09, D1: `ds300Byte(frame[12])` con frame de 12 bytes lanza
// TypeError (undefined.toString). Como el buffer se resetea DESPUÉS de procesar,
// quedaba envenenado: esa caja (8 carriles) dejaba de registrar cruces y nadie se
// enteraba, porque el uncaughtException global mantiene vivo el proceso.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { CircuitConnection } = require('../src/services/SerialService');

after(limpiarBdTemporal);

/** Un circuito sin puerto: solo el parser. Registra los cruces que emite. */
function circuito() {
  const cruces = [];
  const c = new CircuitConnection(
    0,                                  // índice de circuito
    0,                                  // laneOffset
    (cruce) => cruces.push(cruce),      // onCrossing
  );
  c._setConnected = () => {};           // sin sockets
  return { c, cruces };
}

/**
 * Frame de cruce válido del DS-300: 21 bytes, con el carril en el bit `bit` del
 * byte 10. OJO con el mapa de bits: 0x80 es el carril 1 y 0x01 el carril 8
 * (LANE_MAP, SerialService.js:69).
 */
function frameCruce({ bit = 0x80, lapCounter = 0x05, min = 0x00, seg = 0x09, cent = 0x50, dmil = 0x00 } = {}) {
  const f = new Array(21).fill(0);
  f[0]  = 0xe0;
  f[10] = bit;          // laneByte
  f[12] = lapCounter;   // contador de vueltas (BCD)
  f[14] = min;
  f[15] = seg;
  f[16] = cent;
  f[17] = dmil;
  return f;
}

const MIN_CROSSING_MS = 500;   // el filtro de cruces del propio SerialService

beforeEach(() => {});

// ── D1: frames truncados ───────────────────────────────────────────────────

test('un frame de cruce truncado NO lanza', () => {
  const { c } = circuito();
  // 12 bytes: hay laneByte (frame[10]) pero frame[12] no existe.
  const corto = [0xe0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0, 0x80, 0];
  assert.doesNotThrow(() => c._processFrame(corto, 1000),
    'un tirón de cable parte un frame; no puede tumbar el parser');
});

test('un frame truncado se descarta y NO produce un cruce fantasma', () => {
  const { c, cruces } = circuito();
  c._processFrame([0xe0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0, 0x80, 0], 1000);
  assert.equal(cruces.length, 0, 'un frame incompleto no es un cruce');
});

test('tras un frame truncado, el siguiente frame VÁLIDO se procesa', () => {
  // El corazón de D1: el buffer no puede quedar envenenado.
  const { c, cruces } = circuito();
  c._processFrame([0xe0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0, 0x80, 0], 1000);
  c._processFrame(frameCruce(), 1000 + MIN_CROSSING_MS + 100);
  assert.equal(cruces.length, 1, 'el circuito sigue registrando cruces tras el frame roto');
  assert.equal(cruces[0].lane, 1);
});

test('_onData deja el buffer limpio aunque el frame que vacía lance', () => {
  // Reproduce el camino real: bytes -> buffer -> flush. Si _processFrame lanzara,
  // el buffer se quedaba con la basura y se reprocesaba en bucle.
  const { c } = circuito();
  c._onData(Buffer.from([0xe0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0, 0x80, 0]));
  // Fuerza el flush por silencio sin esperar al temporizador.
  if (c._flushTimer) { clearTimeout(c._flushTimer); c._flushTimer = null; }
  assert.doesNotThrow(() => c._flushFrameBuf());
  assert.deepEqual(c._frameBuf, [], 'el buffer queda vacío pase lo que pase');
});

test('un frame de longitud 0 o 1 no rompe nada', () => {
  const { c, cruces } = circuito();
  assert.doesNotThrow(() => c._processFrame([], 1000));
  assert.doesNotThrow(() => c._processFrame([0xe0], 1000));
  assert.equal(cruces.length, 0);
});

test('un frame de cruce completo sí produce el cruce, con su tiempo de vuelta', () => {
  const { c, cruces } = circuito();
  c._processFrame(frameCruce({ min: 0x00, seg: 0x09, cent: 0x50, dmil: 0x00 }), 5000);
  assert.equal(cruces.length, 1);
  assert.equal(cruces[0].lane, 1);
  assert.equal(cruces[0].lapTimeMs, 9500, '0 min 09 s 50 cent = 9,500 s');
});

test('el laneOffset sitúa el carril en su circuito', () => {
  const cruces = [];
  const c = new CircuitConnection(2, 16, (x) => cruces.push(x));   // caja 3: carriles 17-24
  c._setConnected = () => {};
  c._processFrame(frameCruce({ bit: 0x80 }), 5000);
  assert.equal(cruces[0].lane, 17, 'el carril 1 de la caja 3 es el 17 global');
});

// ── D2: el watchdog del latido ─────────────────────────────────────────────

test('el watchdog marca el enlace CAÍDO si cesan los latidos con la manga corriendo', () => {
  const { c } = circuito();
  const estados = [];
  c._setConnected = (v) => { c._connected = v; estados.push(v); };
  c._connected = true;
  c._raceState = 'running';

  c._onHeartbeatTimeout();

  assert.deepEqual(estados, [false],
    'el DS emite latido cada 60 s mientras corre: 75 s de silencio = enlace muerto');
});

test('el watchdog NO marca caído el enlace si la manga no está corriendo', () => {
  // Es deliberado: una manga parada puede estar legítimamente en silencio.
  const { c } = circuito();
  const estados = [];
  c._setConnected = (v) => { c._connected = v; estados.push(v); };
  c._connected = true;

  c._raceState = null;
  c._onHeartbeatTimeout();
  c._raceState = 'stopped';
  c._onHeartbeatTimeout();
  c._raceState = 'finished';
  c._onHeartbeatTimeout();
  c._raceState = 'paused';
  c._onHeartbeatTimeout();

  assert.deepEqual(estados, [], 'silencio con la manga parada no es una avería');
});

test('el watchdog también vigila una manga reanudada', () => {
  const { c } = circuito();
  const estados = [];
  c._setConnected = (v) => { c._connected = v; estados.push(v); };
  c._connected = true;
  c._raceState = 'resumed';
  c._onHeartbeatTimeout();
  assert.deepEqual(estados, [false]);
});

test('_pingAlive rearma el watchdog y revive el enlace', () => {
  const { c } = circuito();
  c._connected = false;
  const estados = [];
  c._setConnected = (v) => { c._connected = v; estados.push(v); };

  c._pingAlive();
  assert.deepEqual(estados, [true], 'una trama del DS prueba que el enlace vive');
  assert.ok(c._watchdogTimer, 'y rearma el watchdog');
  clearTimeout(c._watchdogTimer);
});
