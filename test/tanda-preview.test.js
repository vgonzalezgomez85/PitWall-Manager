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
// Vista previa de las mangas al crear una tanda (POST /races/:id/tandas/preview)
// y «Crear y apuntar otra tanda». La vista previa tiene que salir igual que las
// mangas que se guardan al crear la tanda de verdad.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db              = require('../src/config/database');
const Race            = require('../src/models/Race');
const TandaController = require('../src/controllers/TandaController');

after(() => limpiarBdTemporal());
beforeEach(() => {
  for (const t of ['manga_lanes', 'laps', 'mangas', 'drivers', 'teams', 'tandas', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

const fakeRes = () => ({
  code: 200, redirectTo: null, json_: null,
  status(c) { this.code = c; return this; },
  redirect(u) { this.redirectTo = u; return this; },
  render() { return this; },
  json(d) { this.json_ = d; return this; },
});
const carrera = () => Race.create({
  name: 'R', type: 'club', format: 'individual', lanes_count: 6,
  lane_sequence: [1, 3, 5, 6, 4, 2], circuits: [6],
});
const preview = (raceId, body) => {
  const res = fakeRes();
  TandaController.preview({ params: { id: String(raceId) }, body }, res);
  return res.json_;
};

test('con todos los carriles llenos: 6 mangas y cada piloto pasa por los 6', () => {
  const id = carrera();
  const d = preview(id, { slots: ['A', 'B', 'C', 'D', 'E', 'F'], mode: 'rotate' });
  assert.deepEqual(d.lanes, [1, 2, 3, 4, 5, 6]);
  assert.equal(d.mangas.length, 6);
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const lanes = d.mangas.map(m => Object.keys(m.byLane).find(l => m.byLane[l] === name));
    assert.equal(new Set(lanes).size, 6, `${name} pasa por todos los carriles`);
  }
});

test('con carriles libres: «que vayan cambiando» usa los 6, «no usarlos» los apaga', () => {
  const id = carrera();
  const rotate = preview(id, { slots: ['A', 'B', 'C', 'D', null, null], mode: 'rotate' });
  assert.equal(rotate.mangas.length, 6);
  assert.deepEqual(rotate.usedLanes.sort(), [1, 2, 3, 4, 5, 6]);

  const skip = preview(id, { slots: ['A', 'B', 'C', 'D', null, null], mode: 'skip' });
  assert.equal(skip.mangas.length, 4);
  assert.equal(skip.usedLanes.length, 4);
  for (const m of skip.mangas) assert.equal(Object.keys(m.byLane).length, 4);
});

test('con más pilotos que carriles salen los que descansan en cada manga', () => {
  const id = carrera();
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const d = preview(id, { slots: names, mode: 'rotate' });
  assert.equal(d.mangas.length, 9);
  for (const m of d.mangas) {
    assert.equal(m.rests.length, 3);
    assert.equal(Object.keys(m.byLane).length, 6);
  }
});

test('la vista previa coincide con las mangas que se guardan al crear la tanda', () => {
  const id = carrera();
  const names = ['A', 'B', 'C', 'D', null, 'F'];
  const d = preview(id, { slots: names, mode: 'rotate' });

  const res = fakeRes();
  TandaController.create({
    params: { id: String(id) }, t: k => k,
    body: { empty_lane_mode: 'rotate', drivers: Object.fromEntries(names.map((n, i) => [i, { name: n || '' }])) },
  }, res);
  const rows = db.prepare(`
    SELECT m.number, ml.lane, d.name FROM mangas m
    JOIN manga_lanes ml ON ml.manga_id = m.id
    JOIN drivers d ON d.id = ml.driver_id
    WHERE m.race_id = ? AND ml.is_rest = 0 ORDER BY m.number, ml.lane`).all(id);
  const saved = {};
  rows.forEach(r => { (saved[r.number] = saved[r.number] || {})[r.lane] = r.name; });
  const savedList = Object.keys(saved).sort((a, b) => a - b).map(k => saved[k]);
  assert.deepEqual(savedList, d.mangas.map(m => m.byLane));
});

test('nada que enseñar sin participantes y sin carrera', () => {
  const id = carrera();
  assert.equal(preview(id, { slots: [null, '  '], mode: 'rotate' }).mangas.length, 0);
  const res = fakeRes();
  TandaController.preview({ params: { id: '999999' }, body: {} }, res);
  assert.equal(res.code, 404);
});

test('«Crear y apuntar otra tanda» vuelve al formulario con el número de la creada', () => {
  const id = carrera();
  const res = fakeRes();
  TandaController.create({
    params: { id: String(id) }, t: k => k,
    body: { after: 'another', drivers: { 0: { name: 'A' }, 1: { name: 'B' } } },
  }, res);
  assert.equal(res.redirectTo, `/races/${id}/tandas/new?created=1`);

  const res2 = fakeRes();
  TandaController.create({ params: { id: String(id) }, t: k => k, body: { drivers: { 0: { name: 'C' } } } }, res2);
  assert.equal(res2.redirectTo, `/races/${id}`);
});
