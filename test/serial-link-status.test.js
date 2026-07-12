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
// En Llinars hay 3 cajas DS-300. Si se cae UNA, sus 8 carriles dejan de contar
// vueltas mientras las otras 16 siguen rodando: el aviso tiene que salir y tiene
// que decir QUÉ caja. El defecto histórico: `serial:status` se emitía con dos
// formas distintas (una por caja, otra global) y el `connected` global es el OR
// de todas las fuentes, así que con 2 de 3 vivas seguía siendo `true` y el
// banner se ocultaba solo.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const SerialService = require('../src/services/SerialService');

// Conexión de pega con la misma superficie que lee getLinkStatus().
function conexionFalsa(path, connected, lastHeartbeatTs = null) {
  return { path, connected, lastHeartbeatTs, isBart: false };
}

function conEstas(conexiones, extra = {}) {
  const prev = {
    conns:     SerialService._connections,
    simRun:    SerialService._simRunning,
    simReplay: SerialService._simReplay,
  };
  SerialService._connections = conexiones;
  SerialService._simRunning  = extra.simRunning  || false;
  SerialService._simReplay   = extra.simReplay   || false;
  try { return SerialService.getLinkStatus(); }
  finally {
    SerialService._connections = prev.conns;
    SerialService._simRunning  = prev.simRun;
    SerialService._simReplay   = prev.simReplay;
  }
}

test('getLinkStatus informa del estado de CADA caja, no solo del global', () => {
  const st = conEstas([
    conexionFalsa('/dev/ttys010', true),
    conexionFalsa('/dev/ttys011', false, 1_700_000_000_000),
    conexionFalsa('/dev/ttys012', true),
  ]);

  assert.equal(st.circuits.length, 3);
  assert.deepEqual(st.circuits.map(c => c.connected), [true, false, true]);
  assert.deepEqual(st.circuits.map(c => c.circuit),   [1, 2, 3]);
});

test('la caja 2 caída sale en `down` aunque el `connected` global siga en true', () => {
  const st = conEstas([
    conexionFalsa('/dev/ttys010', true),
    conexionFalsa('/dev/ttys011', false),
    conexionFalsa('/dev/ttys012', true),
  ]);

  // Esta es la trampa: `connected` es el OR de las fuentes. Sigue siendo true
  // porque quedan 2 cajas vivas. Un aviso que se guíe por él NO salta nunca.
  assert.equal(st.connected, true, 'quedan fuentes vivas → global sigue conectado');

  // …y esta es la señal por la que sí se debe avisar.
  assert.deepEqual(st.down, [2], 'la caja caída se identifica por número (1-based)');
});

test('sin cajas caídas, `down` va vacío', () => {
  const st = conEstas([conexionFalsa('/dev/ttys010', true), conexionFalsa('/dev/ttys011', true)]);
  assert.deepEqual(st.down, []);
});

test('las 3 cajas caídas se listan todas', () => {
  const st = conEstas([
    conexionFalsa('/dev/ttys010', false),
    conexionFalsa('/dev/ttys011', false),
    conexionFalsa('/dev/ttys012', false),
  ]);
  assert.deepEqual(st.down, [1, 2, 3]);
  assert.equal(st.connected, false);
});

test('cada caja conserva su lastHeartbeatTs (el aviso mide desde el último latido)', () => {
  const t = 1_700_000_123_456;
  const st = conEstas([conexionFalsa('/dev/ttys010', true), conexionFalsa('/dev/ttys011', false, t)]);
  assert.equal(st.circuits[1].lastHeartbeatTs, t);
});

test('en simulación no hay puerto, pero ninguna caja cuenta como caída', () => {
  // Los circuitos virtuales de startSimMode nunca abren puerto: `connected` es
  // falso en la conexión. Si eso llegara a `down`, el aviso saltaría durante toda
  // una carrera simulada.
  const st = conEstas(
    [conexionFalsa(null, false), conexionFalsa(null, false)],
    { simReplay: true },
  );
  assert.equal(st.simulating, true);
  assert.deepEqual(st.down, [], 'una carrera simulada no debe disparar el aviso de cable');
  assert.equal(st.connected, true);
});

test('tras rehidratar, una caja muda se detecta aunque no haya llegado ninguna trama de GO', (t) => {
  // `_raceState` solo lo fijan las tramas del DS. Si PitWall reinicia a mitad de
  // manga, no vuelve a llegar un GO: la guarda de `_onHeartbeatTimeout` salía por
  // la puerta de atrás y la caja caída no se detectaba NUNCA. En el banco eso se
  // vio como un servidor muerto por falta de memoria (el puerto huérfano nunca se
  // cerraba y serialport crecía ~25 MB/s), no como un aviso.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { CircuitConnection } = require('../src/services/SerialService');
  const noop = () => {};
  const cambios = [];
  const conn = new CircuitConnection(0, 0, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
    (ci, up) => cambios.push(up));

  // Estado justo después de rehidratar: sin trama de GO vista.
  assert.equal(conn._raceState, null);
  conn._onHeartbeatTimeout();
  assert.deepEqual(cambios, [], 'sin estado de carrera, el watchdog no puede opinar');

  // TimingService anuncia que hay manga en marcha → arma el watchdog.
  conn.setExternalRaceState(true);
  assert.equal(conn._raceState, null, 'NO toca el estado que leen las tramas');

  // 75 s de silencio: la caja está muda.
  t.mock.timers.tick(75_000);
  assert.deepEqual(cambios, [false], 'el enlace se marca caído');
});

test('setExternalRaceState no se come el GO escalonado de las demás cajas', () => {
  // En Llinars las 3 cajas mandan su GO por separado. `_setRaceState` hace
  // cortocircuito si el estado no cambia: si `setExternalRaceState` pusiera
  // `_raceState = 'running'`, el GO de las cajas 2 y 3 no dispararía `onGo()` y
  // sus relojes se quedarían a cero. Solo arrancaría la primera en mandar el GO.
  const { CircuitConnection } = require('../src/services/SerialService');
  const noop = () => {};

  const arranques = [];
  const conn = new CircuitConnection(1, 8,
    noop,
    () => arranques.push('go'),   // onGo
    noop, noop, noop, noop, noop, noop, noop, noop, noop);

  // TimingService armó el watchdog cuando otra caja mandó SU go.
  conn.setExternalRaceState(true);

  // Ahora llega el GO de ESTA caja.
  conn._setRaceState('running');

  assert.deepEqual(arranques, ['go'], 'la caja arranca su reloj con su propio GO');
});

test('parar la manga desarma el watchdog (el silencio del DS deja de ser un fallo)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { CircuitConnection } = require('../src/services/SerialService');
  const noop = () => {};
  const cambios = [];
  const conn = new CircuitConnection(0, 0, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
    (ci, up) => cambios.push(up));

  conn.setExternalRaceState(true);
  conn.setExternalRaceState(false);
  t.mock.timers.tick(200_000);
  assert.deepEqual(cambios, [], 'entre mangas, callarse es lo normal: ningún aviso');
});

test('reconectar a mitad de manga conserva los contadores de vuelta por carril', () => {
  // Los contadores viven en el CircuitConnection. `connectMultiple` (cable repuesto,
  // ajustes guardados) construye objetos NUEVOS: sin trasplante empiezan a cero, no
  // hay `prevAbs` contra el que medir el salto del contador del DS y las vueltas del
  // corte se pierden en silencio. Medido en el banco: la caja desconectada acabó con
  // ~22 vueltas por carril frente a ~31 de las otras dos, y 0 marcadas como repuestas.
  const { CircuitConnection } = require('../src/services/SerialService');
  const noop = () => {};

  const vieja = new CircuitConnection(0, 0, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  vieja._lastLapAbsByLane.set(3, 147);
  vieja._lastCrossTsByLane.set(3, 1_700_000_000_000);
  vieja._lapStatsByLane.set(3, { sum: 90_000, count: 10 });
  vieja._raceState = 'running';

  const nueva = new CircuitConnection(0, 0, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  assert.equal(nueva._lastLapAbsByLane.get(3), undefined, 'nace vacía');

  nueva.importLaneState(vieja.exportLaneState());

  assert.equal(nueva._lastLapAbsByLane.get(3), 147, 'hereda el contador absoluto');
  assert.equal(nueva._lastCrossTsByLane.get(3), 1_700_000_000_000, 'y la marca de tiempo');
  assert.deepEqual(nueva._lapStatsByLane.get(3), { sum: 90_000, count: 10 }, 'y la media del carril');
  assert.equal(nueva._raceState, 'running', 'y que la manga seguía corriendo');

  // Copia, no alias: tocar la nueva no debe alterar la vieja.
  nueva._lastLapAbsByLane.set(3, 999);
  assert.equal(vieja._lastLapAbsByLane.get(3), 147);
});

test('_setConnected avisa al servicio con el índice de la caja, sin emitir por socket', () => {
  const { CircuitConnection } = require('../src/services/SerialService');

  const vistos = [];
  const noop = () => {};
  // Posición 13 del constructor = onLinkChange. Si alguien reordena los callbacks,
  // este test cae.
  const conn = new CircuitConnection(
    1, 8, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
    (ci, up) => vistos.push([ci, up]),
  );

  conn._setConnected(false);
  conn._setConnected(false);   // sin cambio → no reavisa
  conn._setConnected(true);

  assert.deepEqual(vistos, [[1, false], [1, true]], 'avisa solo en los cambios, con el índice 0-based');
});
