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
// Nombres repetidos al crear/editar una tanda (utils/participantNames).
//  · Dos veces en la misma tanda → no se guarda (error `duplicate_participant_form`).
//  · Ya en otra tanda de la carrera → se guarda (el aviso es del navegador):
//    repetir equipos entre tandas es legítimo (entrenos en varias sesiones).

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db              = require('../src/config/database');
const Race            = require('../src/models/Race');
const Team            = require('../src/models/Team');
const TeamCatalog     = require('../src/models/TeamCatalog');
const TandaController = require('../src/controllers/TandaController');
const Names           = require('../src/utils/participantNames');

after(() => limpiarBdTemporal());
beforeEach(() => {
  for (const t of ['manga_lanes', 'laps', 'mangas', 'drivers', 'teams', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

const fakeRes = () => ({
  code: 200, redirectTo: null, view: null, data: null,
  status(c) { this.code = c; return this; },
  redirect(u) { this.redirectTo = u; return this; },
  render(v, d) { this.view = v; this.data = d; return this; },
});
const crear = (raceId, body) => { const res = fakeRes(); TandaController.create({ params: { id: String(raceId) }, body, t: k => k }, res); return res; };
const carrera = (format = 'individual') =>
  Race.create({ name: 'R', type: format === 'team' ? 'championship' : 'club', format, lanes_count: 4, lane_sequence: [1, 2, 3, 4], circuits: [4] });
const tandas = (raceId) => db.prepare('SELECT COUNT(*) n FROM tandas WHERE race_id = ?').get(raceId).n;

// ── La regla ─────────────────────────────────────────────────────────────────

test('normName ignora mayúsculas, acentos y espacios de más', () => {
  assert.equal(Names.normName('  José   Pérez '), 'jose perez');
  assert.equal(Names.normName('JOSE PEREZ'), Names.normName('josé pérez'));
  assert.notEqual(Names.normName('Jose Perez'), Names.normName('Jose Perez 2'));
});

test('duplicatesIn devuelve cada repetido una vez y salta los vacíos', () => {
  assert.deepEqual(Names.duplicatesIn(['Ana', 'Beto', 'ana', ' ANA ', '', null, 'Beto']), ['Ana', 'Beto']);
  assert.deepEqual(Names.duplicatesIn(['Ana', 'Beto']), []);
});

// ── Misma tanda: error ───────────────────────────────────────────────────────

test('tanda nueva con un piloto repetido: no se crea y vuelve el formulario con lo escrito', () => {
  const raceId = carrera();
  const res = crear(raceId, { drivers: { 0: { name: 'Ana' }, 1: { name: 'Beto' }, 2: { name: 'ANA ' } } });
  assert.equal(res.view, 'races/tanda-new');
  assert.deepEqual(res.data.errors, ['duplicate_participant_form']);
  assert.equal(res.data.body.drivers[2].name, 'ANA ', 'no se pierde lo escrito');
  assert.equal(tandas(raceId), 0, 'ni rastro de la tanda');
});

test('editar una tanda dejando dos equipos con el mismo nombre: no se guarda', () => {
  const raceId = carrera('team');
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const a = Team.create({ race_id: raceId, tanda_id: tandaId, name: 'Rojo', lane: 0, color: '#f00' });
  const b = Team.create({ race_id: raceId, tanda_id: tandaId, name: 'Azul', lane: 0, color: '#00f' });
  const res = fakeRes();
  TandaController.updateTanda({ params: { id: String(raceId), tandaId: String(tandaId) }, t: k => k,
    body: { teams: { 0: { id: String(a), name: 'Rojo' }, 1: { id: String(b), name: 'rojo' } } } }, res);
  assert.equal(res.view, 'races/tanda-edit');
  assert.deepEqual(res.data.errors, ['duplicate_participant_form']);
  assert.equal(db.prepare('SELECT name FROM teams WHERE id = ?').get(b).name, 'Azul', 'no se ha tocado');
});

// ── Otra tanda: se permite y el formulario recibe la lista para avisar ───────

test('el mismo piloto en otra tanda se guarda y sale en otherNames', () => {
  const raceId = carrera();
  crear(raceId, { drivers: { 0: { name: 'Ana' }, 1: { name: 'Beto' } } });
  const res = crear(raceId, { drivers: { 0: { name: 'ana' }, 1: { name: 'Carla' } } });
  assert.equal(res.redirectTo, `/races/${raceId}`);
  assert.equal(tandas(raceId), 2);

  const form = fakeRes();
  TandaController.newForm({ params: { id: String(raceId) }, t: k => k }, form);
  const ana = form.data.otherNames.find(o => o.key === 'ana');
  assert.equal(ana.name, 'Ana');
  assert.deepEqual(ana.tandas, [1, 2]);
});

test('otherNames excluye la propia tanda al editar y, en equipos, mira equipos', () => {
  const raceId = carrera('team');
  const cat = TeamCatalog.create({ name: 'Rojo', color: '#f00' });
  crear(raceId, { team_catalog_ids: [String(cat)] });
  crear(raceId, { team_catalog_ids: [String(cat)] });
  const [t1, t2] = db.prepare('SELECT id FROM tandas WHERE race_id = ? ORDER BY number').all(raceId).map(r => r.id);
  const race = Race.findById(raceId);
  assert.deepEqual(Names.inOtherTandas(race, t1).map(o => [o.name, o.tandas]), [['Rojo', [2]]]);
  assert.deepEqual(Names.inOtherTandas(race, t2).map(o => [o.name, o.tandas]), [['Rojo', [1]]]);

  const res = fakeRes();
  TandaController.editTanda({ params: { id: String(raceId), tandaId: String(t1) }, t: k => k }, res);
  assert.deepEqual(res.data.otherNames.map(o => o.name), ['Rojo']);
});
