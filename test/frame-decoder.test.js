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
 */
// Decodificador de presentación del visor de tramas (/diagnostico/tramas).
//
// Lo que de verdad se clava aquí es la FIDELIDAD con SerialService._processFrame:
// el visor es una segunda implementación del mismo parseo, así que puede
// divergir en silencio y mentirle a quien esté depurando hardware. Los casos
// que más fácilmente divergen —y por eso están cubiertos— son el latch de
// GO/resume (0xA2/0xA3 solo significan algo con un GO pendiente), que el cruce
// se identifica por b[10] y NO por b[7], y el filtro de tiempos fuera de rango.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDecoder } = require('../src/lib/frameDecoder');

// Constructor de tramas de 21 bytes: e0 … eb con los bytes que interesen.
function frame(over = {}) {
  const b = Array(21).fill(0);
  b[0] = 0xe0; b[20] = 0xeb;
  for (const [i, v] of Object.entries(over)) b[+i] = v;
  return b;
}

const GO   = frame({ 7: 0x3e, 8: 0xa1, 10: 0x99 });   // 99 min en BCD
const A2   = frame({ 7: 0x00, 8: 0xa2 });
const A3   = frame({ 7: 0x00, 8: 0xa3 });
const A6   = frame({ 7: 0x00, 8: 0xa6 });
// Cruce: carril 3 (bit 0x20), 00:08:43:20 BCD = 8,432 s, contador 7.
const CRUCE = frame({ 10: 0x20, 12: 0x07, 14: 0x00, 15: 0x08, 16: 0x43, 17: 0x20 });

test('GO: etiqueta y duración en BCD', () => {
  const d = createDecoder();
  const r = d.ds(GO);
  assert.equal(r.kind, 'go');
  assert.deepEqual(r.fields, [{ k: 'duración', v: '99 min' }]);
});

test('el verde 0xA3 solo cuenta si hay un GO pendiente', () => {
  const d = createDecoder();
  d.ds(GO);
  assert.equal(d.ds(A3).kind, 'started', 'con GO pendiente → arranque');
  // Sin latch, SerialService.js:604 la ignora. Si el visor la marcara como
  // arranque, enseñaría un evento que el cronometraje nunca produjo.
  assert.equal(d.ds(A3).kind, 'ignored', 'sin GO pendiente → ignorada');
});

test('0xA6 arma el resume y el verde posterior lo resuelve', () => {
  const d = createDecoder();
  assert.equal(d.ds(A6).kind, 'resume_signal');
  assert.equal(d.ds(A3).kind, 'resumed');
});

test('el semáforo intermedio 0xA2 sin latch no es un paso de semáforo', () => {
  const d = createDecoder();
  assert.equal(d.ds(A2).kind, 'ignored');
  d.ds(GO);
  assert.equal(d.ds(A2).kind, 'semaphore');
});

test('control: stop, fin de manga y pausa', () => {
  const d = createDecoder();
  assert.equal(d.ds(frame({ 8: 0xa7 })).kind, 'stopped');
  assert.equal(d.ds(frame({ 8: 0xa4 })).kind, 'finished');
  assert.equal(d.ds(frame({ 8: 0xa5 })).kind, 'paused');
});

test('cruce: carril, tiempo BCD y contador', () => {
  const r = createDecoder().ds(CRUCE);
  assert.equal(r.kind, 'crossing');
  assert.deepEqual(r.lanes, [3]);
  assert.deepEqual(r.fields, [
    { k: 'carril',   v: '3' },
    { k: 'tiempo',   v: '8.432 s' },
    { k: 'contador', v: '7' },
  ]);
});

test('el cruce se identifica por b[10], no por b[7]', () => {
  // b[7] arbitrario: mientras haya carril y ≥18 bytes, es un cruce. Clasificar
  // por b[7]==0x1B (como sugiere el log) haría que el visor perdiera cruces.
  const r = createDecoder().ds(frame({ 7: 0x55, 10: 0x20, 15: 0x08, 16: 0x43, 17: 0x20 }));
  assert.equal(r.kind, 'crossing');
});

test('un b[10] con varios bits reporta varios carriles', () => {
  const r = createDecoder().ds(frame({ 10: 0xa0, 15: 0x08, 16: 0x43, 17: 0x20 }));
  assert.deepEqual(r.lanes, [1, 3], '0xa0 = bits 0x80 y 0x20');
});

test('primer cruce de la manga: BCD inválido → sin tiempo, no error', () => {
  const r = createDecoder().ds(frame({ 10: 0x20, 15: 0xff }));
  assert.equal(r.kind, 'crossing');
  assert.equal(r.fields.find(f => f.k === 'tiempo').v, 'primera vuelta');
});

test('tiempo fuera de rango se marca como filtrado', () => {
  // SerialService descarta <500 ms o >240 s EN SILENCIO. El visor debe decirlo
  // o queda un hueco inexplicable entre la trama y el evento que no llega.
  const r = createDecoder().ds(frame({ 10: 0x20, 17: 0x10 }));   // 1 ms
  assert.equal(r.kind, 'crossing_filtered');
});

test('ráfaga del PL2303: colapsa duplicadas consecutivas', () => {
  const r = createDecoder().ds([...CRUCE, ...CRUCE, ...CRUCE]);
  assert.equal(r.kind, 'burst');
  assert.equal(r.subs.length, 1, 'las 3 son idénticas → queda 1');
  assert.deepEqual(r.fields, [{ k: 'sub-tramas', v: '3' }, { k: 'descartadas', v: '2' }]);
});

test('ráfaga con carriles distintos NO se colapsa', () => {
  const otro = frame({ 10: 0x10, 12: 0x07, 15: 0x08, 16: 0x43, 17: 0x20 });   // carril 4
  const r = createDecoder().ds([...CRUCE, ...otro]);
  assert.equal(r.subs.length, 2, 'cruces simultáneos de carriles distintos son reales');
});

test('modo agrupador: b[4] desplaza el carril global', () => {
  // Caja 2 (b[4]=0x02) con 4 cajas por puerto → carril 3 local = global 11.
  const r = createDecoder().ds(frame({ 4: 0x02, 10: 0x20, 15: 0x08, 16: 0x43, 17: 0x20 }),
                               { boxesPerPort: 4 });
  assert.deepEqual(r.lanes, [11]);
});

test('laneOffset de multi-circuito se suma al carril', () => {
  const r = createDecoder().ds(CRUCE, { laneOffset: 8 });
  assert.deepEqual(r.lanes, [11]);
});

test('los bytes sin interpretar se listan para pintarlos atenuados', () => {
  const r = createDecoder().ds(CRUCE);
  assert.deepEqual(r.unknown, [1, 2, 3, 5, 6, 9, 11, 13, 18, 19]);
});

test('heartbeat: el minuto es el byte crudo, no BCD', () => {
  // b[14]=0x12 → 18, no 12. SerialService.js:547 lo lee sin pasar por ds300Byte.
  const r = createDecoder().ds(frame({ 7: 0x00, 8: 0xc0, 14: 0x12 }));
  assert.equal(r.kind, 'heartbeat');
  assert.deepEqual(r.fields, [{ k: 'minuto', v: '18' }]);
});

// ── BART ────────────────────────────────────────────────────────────────────
// Protocolo distinto: tramas A5, tipo explícito en b[1], sin latch de estado.

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

test('BART LAP: desempaqueta el carril del nibble y lee el tiempo', () => {
  // b[3]=0x11 → dispositivo 1, carril 1 → local (1*4)+1 = 5
  const lap = [0xa5, 0x01, 0x01, 0x11, ...u16(12), ...u16(8432), ...u16(0), ...u16(0), 7, 0x00];
  const r = createDecoder().bart(lap);
  assert.equal(r.kind, 'crossing');
  assert.deepEqual(r.lanes, [5]);
  assert.deepEqual(r.fields, [
    { k: 'carril',  v: '5' },
    { k: 'tiempo',  v: '8.432 s' },
    { k: 'vueltas', v: '12' },
    { k: 'seq',     v: '7' },
  ]);
});

test('BART LAP: 0xFFFF es desborde, no un tiempo de 65 s', () => {
  const lap = [0xa5, 0x01, 0x01, 0x01, ...u16(1), ...u16(0xffff), ...u16(0), ...u16(0), 1, 0x00];
  const r = createDecoder().bart(lap);
  assert.equal(r.kind, 'crossing');
  assert.match(r.fields.find(f => f.k === 'tiempo').v, /desborde/);
});

test('BART LAP: rebote por debajo de 500 ms se marca como filtrado', () => {
  const lap = [0xa5, 0x01, 0x01, 0x01, ...u16(1), ...u16(120), ...u16(0), ...u16(0), 1, 0x00];
  const r = createDecoder().bart(lap);
  assert.equal(r.kind, 'crossing_filtered');
  assert.match(r.label, /rebote/);
});

test('BART STATUS: expone minlap, uptime y carriles que el timing tira', () => {
  const st = [0xa5, 0x20, 0x01, 0x01, ...u16(1500), ...u16(432), 8, ...u16(0), 0x00];
  const r = createDecoder().bart(st);
  assert.equal(r.kind, 'started');
  assert.deepEqual(r.fields, [
    { k: 'min-lap',  v: '1500 ms' },
    { k: 'uptime',   v: '43.2 s' },
    { k: 'carriles', v: '8' },
  ]);
});

test('BART ACK: distingue OK de error', () => {
  const d = createDecoder();
  assert.equal(d.bart([0xa5, 0x7f, 0x01, 0x00, 0x00]).kind, 'ack');
  const err = d.bart([0xa5, 0x7f, 0x10, 0x03, 0x00]);
  assert.equal(err.kind, 'ack_error');
  assert.match(err.label, /SET_MINLAP.*op desconocido/);
});

test('BART CMD: comandos salientes con su parámetro', () => {
  const d = createDecoder();
  assert.match(d.bart([0xa5, 0x90, 0x01, 0x00]).label, /GO \/ START/);
  assert.match(d.bart([0xa5, 0x90, 0x10, ...u16(1500), 0x00]).label, /MIN-LAP = 1500 ms/);
  assert.match(d.bart([0xa5, 0x90, 0x30, 0x01, 0x00]).label, /NOTIFICACIONES ON/);
});

test('BART: laneOffset multi-circuito', () => {
  const lap = [0xa5, 0x01, 0x01, 0x02, ...u16(1), ...u16(8000), ...u16(0), ...u16(0), 1, 0x00];
  const r = createDecoder().bart(lap, { laneOffset: 8 });
  assert.deepEqual(r.lanes, [10]);
});

test('trama real capturada del DS por el PL2303', () => {
  const bytes = 'e0 0c 15 03 00 04 4c 00 a7 00 00 00 00 00 00 00 00 00 1b 00 eb'
    .split(' ').map(h => parseInt(h, 16));
  const r = createDecoder().ds(bytes);
  assert.equal(r.kind, 'stopped');
  assert.equal(r.len, 21);
});
