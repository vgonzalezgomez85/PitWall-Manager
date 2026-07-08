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
// Panel de pre-arme: qué equipos faltan por fichar antes del GO, agrupados por
// caja. Es lo que el operador mira en el box, así que no puede equivocarse ni
// contar de más: un carril en descanso NO ficha.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const ControlController = require('../src/controllers/ControlController');

after(limpiarBdTemporal);

const prearme = (race, lanes, openByLane) => ControlController._prearmeBoxes(race, lanes, openByLane);

/** 24 carriles activos, ninguno en descanso. */
const carriles24 = () => Array.from({ length: 24 }, (_, i) => ({ lane: i + 1, team_name: `Equipo ${i + 1}` }));
const LLINARS = { circuits_config: '[8,8,8]', lanes_count: 24 };

test('reparte los 24 carriles en 3 cajas de 8, como en Llinars', () => {
  const p = prearme(LLINARS, carriles24(), {});
  assert.equal(p.boxes.length, 3);
  assert.deepEqual(p.boxes.map(b => b.cells.length), [8, 8, 8]);
  assert.deepEqual(p.boxes[0].cells.map(c => c.lane), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(p.boxes[1].cells.map(c => c.lane), [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(p.boxes[2].cells.map(c => c.lane), [17, 18, 19, 20, 21, 22, 23, 24]);
});

test('sin nadie fichado, faltan los 24 y no está completo', () => {
  const p = prearme(LLINARS, carriles24(), {});
  assert.equal(p.total, 24);
  assert.equal(p.scanned, 0);
  assert.equal(p.missing.length, 24);
  assert.equal(p.complete, false);
});

test('marca fichados y pendientes, y nombra al equipo que falta', () => {
  const open = {};
  for (let l = 1; l <= 24; l++) if (l !== 5 && l !== 11 && l !== 20) open[l] = { id: l };
  const p = prearme(LLINARS, carriles24(), open);

  assert.equal(p.scanned, 21);
  assert.equal(p.complete, false);
  assert.deepEqual(p.missing.map(m => m.lane), [5, 11, 20]);
  assert.deepEqual(p.missing.map(m => m.teamName), ['Equipo 5', 'Equipo 11', 'Equipo 20']);

  // Cada caja tiene exactamente uno pendiente.
  p.boxes.forEach(b => assert.equal(b.cells.filter(c => c.active && !c.scanned).length, 1));
  assert.equal(p.boxes[0].cells.find(c => c.lane === 5).scanned, false);
  assert.equal(p.boxes[0].cells.find(c => c.lane === 4).scanned, true);
});

test('con todos fichados queda completo y sin pendientes', () => {
  const open = {};
  for (let l = 1; l <= 24; l++) open[l] = { id: l };
  const p = prearme(LLINARS, carriles24(), open);
  assert.equal(p.scanned, 24);
  assert.equal(p.missing.length, 0);
  assert.equal(p.complete, true);
});

test('un carril en DESCANSO no ficha: ni suma al total ni sale como pendiente', () => {
  // Los carriles de descanso no llegan en `lanes` (ControlController ya los filtra).
  const lanes = carriles24().filter(l => l.lane !== 7 && l.lane !== 19);
  const p = prearme(LLINARS, lanes, {});

  assert.equal(p.total, 22, 'solo cuentan los que corren');
  assert.equal(p.missing.length, 22);
  assert.equal(p.missing.some(m => m.lane === 7 || m.lane === 19), false);

  // Pero la casilla sigue dibujándose, apagada, para no descuadrar la rejilla.
  const c7 = p.boxes[0].cells.find(c => c.lane === 7);
  assert.equal(c7.active, false);
  assert.equal(p.boxes[0].cells.length, 8, 'la caja 1 sigue enseñando sus 8 casillas');
});

test('descansando todos los que faltaban, el panel se da por completo', () => {
  const lanes = carriles24().filter(l => l.lane !== 5);
  const open = {};
  lanes.forEach(l => { open[l.lane] = { id: l.lane }; });
  const p = prearme(LLINARS, lanes, open);
  assert.equal(p.complete, true);
  assert.equal(p.total, 23);
});

test('una sola caja (club de 8 carriles) también funciona', () => {
  const lanes = Array.from({ length: 8 }, (_, i) => ({ lane: i + 1, team_name: `E${i + 1}` }));
  const p = prearme({ circuits_config: '[8]', lanes_count: 8 }, lanes, { 1: {}, 2: {} });
  assert.equal(p.boxes.length, 1);
  assert.equal(p.total, 8);
  assert.equal(p.scanned, 2);
});

test('cajas desiguales (8+8+6) reparten bien los carriles', () => {
  const lanes = Array.from({ length: 22 }, (_, i) => ({ lane: i + 1, team_name: `E${i + 1}` }));
  const p = prearme({ circuits_config: '[8,8,6]', lanes_count: 22 }, lanes, {});
  assert.deepEqual(p.boxes.map(b => b.cells.length), [8, 8, 6]);
  assert.deepEqual(p.boxes[2].cells.map(c => c.lane), [17, 18, 19, 20, 21, 22]);
  assert.equal(p.total, 22);
});

test('sin circuits_config cae a una sola caja con todos los carriles', () => {
  const p = prearme({ circuits_config: '', lanes_count: 6 },
    Array.from({ length: 6 }, (_, i) => ({ lane: i + 1, team_name: `E${i + 1}` })), {});
  assert.equal(p.boxes.length, 1);
  assert.equal(p.boxes[0].cells.length, 6);
});

test('circuits_config corrupto no rompe la pantalla', () => {
  const p = prearme({ circuits_config: '{esto no es json', lanes_count: 4 },
    Array.from({ length: 4 }, (_, i) => ({ lane: i + 1, team_name: `E${i + 1}` })), {});
  assert.equal(p.boxes.length, 1);
  assert.equal(p.total, 4);
});

test('sin carriles no se da por completo (no hay nada que fichar)', () => {
  const p = prearme(LLINARS, [], {});
  assert.equal(p.total, 0);
  assert.equal(p.complete, false, 'un panel vacío no puede decir "listos para el GO"');
});

test('cae al nombre del piloto cuando la carrera no es por equipos', () => {
  const lanes = [{ lane: 1, driver_name: 'Ana' }, { lane: 2 }];
  const p = prearme({ circuits_config: '[2]', lanes_count: 2 }, lanes, {});
  assert.equal(p.missing[0].teamName, 'Ana');
  assert.equal(p.missing[1].teamName, '—');
});
