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
// Colores de carril personalizables: circuito → globales → fábrica.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Settings   = require('../src/models/Settings');
const Circuit    = require('../src/models/Circuit');
const LaneColors = require('../src/services/LaneColors');

const F = LaneColors.DEFAULT_LANE_COLORS;

after(limpiarBdTemporal);
beforeEach(() => Settings.set('lane_colors', ''));

test('sin nada guardado, la paleta global es la de fábrica', () => {
  assert.deepEqual(LaneColors.global(), [...F]);
  assert.deepEqual(LaneColors.forRace({ circuit_id: null }), [...F]);
});

test('la global solo guarda lo que difiere y hereda el resto', () => {
  const cols = [...F]; cols[1] = '#FFFF00';
  const stored = LaneColors.toStored(cols, F);
  assert.equal(stored, JSON.stringify([null, '#ffff00']));
  Settings.set('lane_colors', stored);
  const g = LaneColors.global();
  assert.equal(g[0], F[0]);
  assert.equal(g[1], '#ffff00');
  assert.equal(g.length, F.length);
  assert.equal(LaneColors.toStored([...F], F), null);
});

test('el circuito pisa a la global; sin colores propios hereda la global', () => {
  Settings.set('lane_colors', JSON.stringify([null, '#111111']));
  const own = Circuit.create({ name: 'Propia', circuits_count: 1, circuits_config: [6], lanes_count: 6,
    lane_colors: LaneColors.toStored(['#ffffff'], LaneColors.global()) });
  const inherit = Circuit.create({ name: 'Hereda', circuits_count: 1, circuits_config: [6], lanes_count: 6 });

  const a = LaneColors.forRace({ circuit_id: own });
  assert.equal(a[0], '#ffffff');
  assert.equal(a[1], '#111111');
  assert.equal(a[2], F[2]);

  const b = LaneColors.forCircuit(inherit);
  assert.equal(b[0], F[0]);
  assert.equal(b[1], '#111111');
});

test('valores no válidos se ignoran', () => {
  Settings.set('lane_colors', JSON.stringify(['rojo', '#12345', null, '#ABCDEF']));
  const g = LaneColors.global();
  assert.equal(g[0], F[0]);
  assert.equal(g[1], F[1]);
  assert.equal(g[3], '#abcdef');
  Settings.set('lane_colors', 'no-es-json');
  assert.deepEqual(LaneColors.global(), [...F]);
});

test('el texto encima es negro en colores claros y blanco en oscuros', () => {
  assert.equal(LaneColors.ink('#ffffff'), '#000');
  assert.equal(LaneColors.ink('#ffc107'), '#000');
  assert.equal(LaneColors.ink('#1a237e'), '#fff');
  assert.equal(LaneColors.ink('#e63946'), '#fff');
});
