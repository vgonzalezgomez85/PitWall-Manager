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
// Reposición de vueltas perdidas con el interface TicTac. Del aparato solo se conoce la
// hora de dos cruces recibidos, no el tiempo de cada vuelta perdida, así que se repone
// con TRES pruebas a la vez (salto del nº de vuelta + trama perdida según el contador de
// secuencia + tiempo plausible) y las vueltas repuestas salen como estimadas.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TicTacConnection = require('../src/services/TicTacConnection');

after(limpiarBdTemporal);

function conexion() {
  const cruces = [];
  const noop = () => {};
  const c = new TicTacConnection(0, 0, x => cruces.push(x), noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  return { c, cruces };
}

function trama({ seq, lane = 1, lap, min = 0, ms }) {
  const b = Buffer.alloc(16);
  b[0] = 0xc0; b[1] = seq & 0xff; b[2] = 0x1b; b[4] = lane;
  b.writeUInt16BE(lap, 5); b.writeUInt16BE(min, 7); b.writeUInt16BE(ms, 9);
  return b;
}
const pasa = (c, o) => c._onData(trama(o));

test('sin pérdidas (secuencia y vueltas seguidas) no se repone nada', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });
  pasa(c, { seq: 3, lap: 3, ms: 25000 });
  assert.deepEqual(cruces.map(x => [x.lapTimeMs, !!x.missed]), [[null, false], [12000, false], [12000, false]]);
});

test('un cruce perdido (vuelta y secuencia saltan) se repone: TODAS las vueltas del tramo, estimadas a la media', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });             // vuelta real de 12 s → media 12 s
  pasa(c, { seq: 4, lap: 4, ms: 37000 });             // faltan la vuelta 3 (trama seq 3): 24 s = 2 vueltas
  assert.equal(cruces.length, 4);
  assert.deepEqual(cruces.slice(2).map(x => [x.lapTimeMs, x.missed]), [[12000, true], [12000, true]]);
});

test('el ritmo de las estimadas sale de las vueltas REALES; las repuestas no lo deforman', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 0 });
  pasa(c, { seq: 2, lap: 2, ms: 10000 });             // 10 s
  pasa(c, { seq: 3, lap: 3, ms: 22000 });             // 12 s → media 11 s
  pasa(c, { seq: 5, lap: 5, ms: 44000 });             // 22 s = 2 vueltas, falta la 4
  assert.deepEqual(cruces.slice(3).map(x => x.lapTimeMs), [11000, 11000]);
  pasa(c, { seq: 6, lap: 6, ms: 56000 });             // 12 s reales
  assert.equal(cruces[5].lapTimeMs, 12000);
  assert.equal(!!cruces[5].missed, false);
  // las estimadas no entran en el ritmo: solo las 3 reales (10, 12, 12)
  assert.deepEqual(c._recentByLane.get(1), [10000, 12000, 12000]);
});

test('un salto de vuelta SIN trama perdida es un reinicio del contador: no se repone', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });
  pasa(c, { seq: 3, lap: 9, ms: 25000 });             // el contador saltó pero no falta ninguna trama
  assert.equal(cruces.length, 3);
  assert.equal(cruces[2].missed, undefined);
  assert.equal(cruces[2].lapTimeMs, 12000);
});

test('un tiempo que no cuadra con las vueltas que faltan no se repone', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });             // media 12 s
  pasa(c, { seq: 4, lap: 4, min: 1, ms: 43000 });     // 90 s para 2 vueltas = 45 s/vuelta: no es un cruce perdido
  assert.equal(cruces.length, 3);
  assert.equal(cruces[2].missed, undefined);
});

test('un salto de más de 50 vueltas es un reinicio, aunque falten tramas', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });
  pasa(c, { seq: 100, lap: 70, min: 12, ms: 0 });
  assert.equal(cruces.filter(x => x.missed).length, 0);
});

test('sin vueltas reales todavía, se reparte lo transcurrido entre las vueltas del tramo', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });              // primer cruce: sin tiempo, sin media
  pasa(c, { seq: 3, lap: 3, ms: 25000 });             // 24 s para 2 vueltas
  assert.deepEqual(cruces.slice(1).map(x => [x.lapTimeMs, x.missed]), [[12000, true], [12000, true]]);
});

test('la secuencia da la vuelta en 0xFF → 0x00 sin contarlo como pérdida', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 254, lap: 1, ms: 1000 });
  pasa(c, { seq: 255, lap: 2, ms: 13000 });
  pasa(c, { seq: 0,   lap: 3, ms: 25000 });
  pasa(c, { seq: 1,   lap: 4, ms: 37000 });
  assert.equal(cruces.filter(x => x.missed).length, 0);
  assert.equal(c._lostFrames, 0);
});

test('una pérdida a través del desbordamiento de la secuencia también se detecta', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 254, lap: 1, ms: 1000 });
  pasa(c, { seq: 255, lap: 2, ms: 13000 });
  pasa(c, { seq: 1,   lap: 4, ms: 37000 });           // falta seq 0 (vuelta 3)
  assert.equal(c._lostFrames, 1);
  assert.equal(cruces.filter(x => x.missed).length, 2);
});

test('una trama repetida (misma secuencia) no cuenta como pérdida ni como vuelta', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });             // la misma trama otra vez
  assert.equal(c._lostFrames, 0);
  assert.equal(cruces.length, 2);
});

test('la pérdida es POR CARRIL: las vueltas seguidas de otro carril no cuentan como hueco', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lane: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lane: 2, lap: 1, ms: 1500 });
  pasa(c, { seq: 3, lane: 1, lap: 2, ms: 13000 });
  pasa(c, { seq: 4, lane: 2, lap: 2, ms: 13500 });
  assert.equal(cruces.filter(x => x.missed).length, 0);
});

test('el GO borra el estado de reposición: tras él el primer cruce no es un hueco', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 1000 });
  pasa(c, { seq: 2, lap: 2, ms: 13000 });
  c.sendStart();
  pasa(c, { seq: 3, lap: 7, ms: 20000 });             // el aparato sigue contando: no es un salto
  pasa(c, { seq: 4, lap: 8, ms: 32000 });
  assert.deepEqual(cruces.slice(2).map(x => [x.lapTimeMs, !!x.missed]), [[null, false], [12000, false]]);
});

test('tras reconectar (exportar/importar) la secuencia sigue y se detecta lo perdido durante el corte', () => {
  const a = conexion();
  pasa(a.c, { seq: 1, lap: 1, ms: 1000 });
  pasa(a.c, { seq: 2, lap: 2, ms: 13000 });
  const b = conexion();
  b.c.importLaneState(a.c.exportLaneState());
  pasa(b.c, { seq: 4, lap: 4, ms: 37000 });           // durante el corte se perdió el cruce 3
  assert.equal(b.cruces.filter(x => x.missed).length, 2);
});

test('una vuelta atípica (parada, salida) no desvirtúa el ritmo: mediana, no media', () => {
  const { c, cruces } = conexion();
  pasa(c, { seq: 1, lap: 1, ms: 0 });
  pasa(c, { seq: 2, lap: 2, ms: 12000 });
  pasa(c, { seq: 3, lap: 3, ms: 24000 });
  pasa(c, { seq: 4, lap: 4, min: 1, ms: 4000 });      // 40 s: una parada
  pasa(c, { seq: 5, lap: 5, min: 1, ms: 16000 });
  pasa(c, { seq: 7, lap: 7, min: 1, ms: 40000 });     // falta el cruce 6: 24 s para 2 vueltas
  assert.deepEqual(cruces.slice(5).map(x => [x.lapTimeMs, x.missed]), [[12000, true], [12000, true]],
    'con una media (16 s) esto no habría cuadrado; la mediana es 12 s');
});

// La captura REAL del club (2026-10-09): 20 cruces de los carriles 1, 2, 3 y 6. Su contador de
// secuencia no salta nunca y los nº de vuelta de cada carril empiezan donde quieren: ni una
// reposición falsa. Quitando una trama, sí se detecta el hueco.
const CAPTURA = `
C0 09 1B 00 03 00 08 00 02 55 2B 00 00 00 00 00
C0 0A 1B 00 02 00 03 00 02 55 85 00 00 00 00 00
C0 0B 1B 00 02 00 04 00 02 86 DD 00 00 00 00 00
C0 0C 1B 00 03 00 09 00 02 87 CC 00 00 00 00 00
C0 0D 1B 00 02 00 05 00 02 B8 30 00 00 00 00 00
C0 0E 1B 00 03 00 0A 00 03 3B 3E 00 00 00 00 00
C0 0F 1B 00 03 00 0B 00 03 6D 58 00 00 00 00 00
C0 10 1B 00 03 00 0C 00 03 9F 15 00 00 00 00 00
C0 11 1B 00 03 00 0D 00 03 DB AB 00 00 00 00 00
C0 12 1B 00 06 00 01 00 04 8C D9 00 00 00 00 00
C0 13 1B 00 06 00 02 00 04 C0 3A 00 00 00 00 00
C0 14 1B 00 06 00 03 00 05 08 1C 00 00 00 00 00
C0 15 1B 00 06 00 04 00 05 3A 45 00 00 00 00 00
C0 16 1B 00 01 00 01 00 05 A5 08 00 00 00 00 00
C0 17 1B 00 01 00 02 00 05 D8 D6 00 00 00 00 00
C0 18 1B 00 01 00 03 00 06 22 88 00 00 00 00 00
C0 19 1B 00 01 00 04 00 06 57 75 00 00 00 00 00
C0 1A 1B 00 01 00 05 00 06 8C 1B 00 00 00 00 00
C0 1B 1B 00 01 00 06 00 06 BF FF 00 00 00 00 00
C0 1C 1B 00 02 00 06 00 07 3C CD 00 00 00 00 00`.trim().split('\n').map(l => Buffer.from(l.replace(/\s+/g, ''), 'hex'));

test('captura real del club: ni una vuelta repuesta de más', () => {
  const { c, cruces } = conexion();
  for (const f of CAPTURA) c._onData(f);
  assert.equal(cruces.length, 20);
  assert.equal(cruces.filter(x => x.missed).length, 0);
  assert.equal(c._lostFrames, 0, 'la secuencia de la captura no salta nunca');
});

test('captura real sin una trama (la 0x19, carril 1 vuelta 4): se detecta y se repone el tramo', () => {
  const { c, cruces } = conexion();
  for (const f of CAPTURA) if (f[1] !== 0x19) c._onData(f);
  const repuestas = cruces.filter(x => x.missed);
  assert.equal(repuestas.length, 2, 'las vueltas 4 y 5 del carril 1 salen como estimadas');
  assert.ok(repuestas.every(x => x.lane === 1));
  assert.ok(repuestas.every(x => x.lapTimeMs >= 13200 && x.lapTimeMs <= 13400), 'ritmo típico del carril 1 (~13,3 s)');
  assert.equal(cruces.length, 19 + 1, 'las 19 tramas recibidas, con 2 vueltas estimadas en lugar de 1 real');
});

test('captura real sin la 0x0F (carril 3): con solo dos vueltas de referencia y una de 40 s, por prudencia no se repone', () => {
  const { c, cruces } = conexion();
  for (const f of CAPTURA) if (f[1] !== 0x0f) c._onData(f);
  assert.equal(cruces.filter(x => x.missed).length, 0);
});
