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
// Historial «Las 10 mejores» de los entrenos: de mejor a peor, con su número de
// vuelta, y sin pasar de 10.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pushBest, BEST_MAX } = require('../src/utils/bestLaps');

test('ordena de mejor a peor y guarda el número de vuelta', () => {
  const top = [];
  [9300, 9100, 9500, 9000].forEach((ms, i) => pushBest(top, i + 1, ms));
  assert.deepEqual(top, [{ n: 4, ms: 9000 }, { n: 2, ms: 9100 }, { n: 1, ms: 9300 }, { n: 3, ms: 9500 }]);
});

test('se queda con las 10 mejores', () => {
  const top = [];
  for (let n = 1; n <= 25; n++) pushBest(top, n, 10000 - n * 10);
  assert.equal(top.length, BEST_MAX);
  assert.equal(top[0].n, 25);
  assert.equal(top[9].n, 16);
});

test('a igualdad de tiempo va antes la vuelta más antigua', () => {
  const top = [];
  pushBest(top, 1, 9000);
  pushBest(top, 2, 9000);
  assert.deepEqual(top.map(v => v.n), [1, 2]);
});
