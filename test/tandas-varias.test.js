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
// Pantalla de tandas: varias tandas a la vez (todas o ninguna, por el mismo
// camino que una sola) y la preferencia «cómo se apuntan los participantes».

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db                 = require('../src/config/database');
const Race               = require('../src/models/Race');
const Tanda              = require('../src/models/Tanda');
const Settings           = require('../src/models/Settings');
const TeamCatalog        = require('../src/models/TeamCatalog');
const TandaController    = require('../src/controllers/TandaController');
const SettingsController = require('../src/controllers/SettingsController');
const TandaBatch         = require('../src/services/TandaBatch');
const EntryMode          = require('../src/utils/tandaEntryMode');

after(() => limpiarBdTemporal());
beforeEach(() => {
  for (const t of ['manga_lanes', 'laps', 'mangas', 'drivers', 'teams', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'settings']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

const fakeRes = () => ({
  code: 200, redirectTo: null, view: null, data: null, json_: null,
  status(c) { this.code = c; return this; },
  redirect(u) { this.redirectTo = u; return this; },
  render(v, d) { this.view = v; this.data = d; return this; },
  json(d) { this.json_ = d; return this; },
});
const carrera = (format = 'individual', lanes = 4) => Race.create({
  name: 'R', type: format === 'team' ? 'championship' : 'club', format, lanes_count: lanes,
  lane_sequence: Array.from({ length: lanes }, (_, i) => i + 1), circuits: [lanes],
});
const crear = (raceId, payload) => {
  const res = fakeRes();
  TandaController.create({ params: { id: String(raceId) }, t: k => k, body: { payload: JSON.stringify(payload) } }, res);
  return res;
};
const tandasDe = (raceId) => db.prepare('SELECT COUNT(*) n FROM tandas WHERE race_id = ?').get(raceId).n;
const sl = (...names) => ({ slots: names.map(n => (n ? { name: n } : null)) });
const mangasDe = (raceId) => db.prepare(`
  SELECT t.number AS tanda, m.number AS manga, ml.lane, d.name
  FROM mangas m JOIN tandas t ON t.id = m.tanda_id
  JOIN manga_lanes ml ON ml.manga_id = m.id JOIN drivers d ON d.id = ml.driver_id
  WHERE m.race_id = ? AND ml.is_rest = 0 ORDER BY t.number, m.number, ml.lane`).all(raceId)
  .map(r => `${r.tanda}/${r.manga}/${r.lane}/${r.name}`);

// ── Varias tandas de golpe ───────────────────────────────────────────────────

test('3 tandas en un solo envío: se crean todas, numeradas y con sus mangas', () => {
  const id = carrera();
  const res = crear(id, { mode: 'rotate', tandas: [sl('A', 'B', 'C', 'D'), sl('E', 'F', null, 'H'), sl('I', 'J')] });
  assert.equal(res.redirectTo, `/races/${id}`);
  const tandas = Tanda.findByRace(id);
  assert.deepEqual(tandas.map(t => t.number), [1, 2, 3]);
  assert.deepEqual(tandas.map(t => t.driver_count), [4, 3, 2]);
  assert.ok(tandas.every(t => t.manga_count > 0));
  assert.equal(Race.findById(id).status, 'active');
});

test('si una tanda no vale no se crea ninguna y se vuelve con los datos y la tanda señalada', () => {
  const id = carrera();
  const res = crear(id, { mode: 'rotate', tandas: [sl('A', 'B'), sl(null, null, null, null), sl('C')] });
  assert.equal(res.redirectTo, null);
  assert.equal(res.view, 'races/tandas');
  assert.deepEqual(res.data.errorDetail, [{ key: 'no_participants', tanda: 2 }]);
  assert.deepEqual(res.data.errors, ['no_participants']);
  assert.equal(res.data.config.tandas.length, 3, 'no se pierde lo escrito');
  assert.equal(res.data.config.tandas[0].slots[0].name, 'A');
  assert.equal(tandasDe(id), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drivers').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mangas').get().n, 0);
});

test('un nombre repetido dentro de una tanda la señala y no crea nada; repetido entre tandas se permite', () => {
  const id = carrera();
  const mal = crear(id, { tandas: [sl('A', 'B'), sl('C', 'c')] });
  assert.deepEqual(mal.data.errorDetail, [{ key: 'duplicate_participant_form', tanda: 2 }]);
  assert.equal(tandasDe(id), 0);

  const bien = crear(id, { tandas: [sl('A', 'B'), sl('A', 'C')] });
  assert.equal(bien.redirectTo, `/races/${id}`);
  assert.equal(tandasDe(id), 2);
});

test('el número de tanda del error cuenta las que ya había', () => {
  const id = carrera();
  crear(id, { tandas: [sl('A')] });
  const res = crear(id, { tandas: [sl('B'), sl()] });
  assert.deepEqual(res.data.errorDetail, [{ key: 'no_participants', tanda: 3 }]);
  assert.equal(tandasDe(id), 1);
});

test('varias a la vez dejan las mismas mangas que crearlas una a una', () => {
  const specs = [sl('A', 'B', 'C', 'D'), sl('E', null, 'G', 'H'), sl('I', 'J')];
  const a = carrera();
  crear(a, { mode: 'rotate', tandas: specs });
  const b = carrera();
  specs.forEach(s => crear(b, { mode: 'rotate', tandas: [s] }));
  const norm = (rows) => rows.map(r => r.replace(/^\d+\//, ''));
  assert.deepEqual(norm(mangasDe(a)), norm(mangasDe(b)));
  assert.equal(mangasDe(a).length, mangasDe(b).length);
});

test('el modo de carriles vacíos del envío se guarda en cada tanda (y por defecto, rotate)', () => {
  const id = carrera();
  crear(id, { mode: 'skip', tandas: [sl('A', 'B'), sl('C', 'D')] });
  assert.deepEqual(Tanda.findByRace(id).map(t => t.empty_lane_mode), ['skip', 'skip']);
  const id2 = carrera();
  crear(id2, { tandas: [sl('A', 'B')] });
  assert.equal(Tanda.findByRace(id2)[0].empty_lane_mode, 'rotate');
});

test('con equipos: catálogo con su copa, coche y miembros; también equipo escrito a mano', () => {
  const id = carrera('team');
  const cat = TeamCatalog.create({ name: 'Rojo', color: '#f00', categoria: 'GT3', coche: 'Ferrari' });
  db.prepare('INSERT INTO teams_catalog_members (team_id, name, position) VALUES (?, ?, 0)').run(cat, 'Ana');
  const res = crear(id, { tandas: [
    { slots: [{ name: 'Rojo', catalogId: cat }, { name: 'Libre FC', members: ['Beto', 'Carla'], categoria: 'LMP' }] },
    { slots: [{ name: 'Rojo', catalogId: cat }] },
  ] });
  assert.equal(res.redirectTo, `/races/${id}`);
  const teams = db.prepare('SELECT * FROM teams WHERE race_id = ? ORDER BY id').all(id);
  assert.deepEqual(teams.map(t => t.name), ['Rojo', 'Libre FC', 'Rojo']);
  assert.equal(teams[0].categoria, 'GT3');
  assert.equal(teams[0].coche, 'Ferrari');
  assert.equal(teams[1].categoria, 'LMP');
  const miembros = (teamId) => db.prepare('SELECT name FROM drivers WHERE team_id = ? ORDER BY id').all(teamId).map(d => d.name);
  assert.deepEqual(miembros(teams[0].id), ['Ana']);
  assert.deepEqual(miembros(teams[1].id), ['Beto', 'Carla']);
});

test('«Crear y apuntar otra» sigue llevando el número de la última creada', () => {
  const id = carrera();
  const res = fakeRes();
  TandaController.create({ params: { id: String(id) }, t: k => k,
    body: { after: 'another', payload: JSON.stringify({ tandas: [sl('A')] }) } }, res);
  assert.equal(res.redirectTo, `/races/${id}/tandas/new?created=1`);
});

// ── La pantalla ──────────────────────────────────────────────────────────────

test('sin tandas la pantalla es la de crear todas; con tandas, una sola', () => {
  const id = carrera();
  const a = fakeRes();
  TandaController.newForm({ params: { id: String(id) }, query: {}, t: k => k }, a);
  assert.equal(a.view, 'races/tandas');
  assert.equal(a.data.config.createAll, true);
  assert.equal(a.data.config.tandas.length, 1);
  assert.equal(a.data.config.mode, 'write');

  crear(id, { tandas: [sl('A')] });
  const b = fakeRes();
  TandaController.newForm({ params: { id: String(id) }, query: { created: '1' }, t: k => k }, b);
  assert.equal(b.data.config.createAll, false);
  assert.equal(b.data.config.baseNumber, 2);
  assert.equal(b.data.createdNumber, 1);
});

test('editar: cada participante vuelve a su carril y guardar respeta los huecos', () => {
  const id = carrera('individual', 6);
  crear(id, { mode: 'skip', tandas: [sl(null, 'A', 'B', 'C', 'D', null)] });
  const tanda = Tanda.findByRace(id)[0];

  const ed = fakeRes();
  TandaController.editTanda({ params: { id: String(id), tandaId: String(tanda.id) }, t: k => k }, ed);
  const slots = ed.data.config.tandas[0].slots;
  assert.deepEqual(slots.map(s => s && s.name), [null, 'A', 'B', 'C', 'D', null]);
  assert.equal(ed.data.config.emptyMode, 'skip');

  const res = fakeRes();
  TandaController.updateTanda({ params: { id: String(id), tandaId: String(tanda.id) }, t: k => k,
    body: { payload: JSON.stringify({ mode: 'rotate', tandas: [sl('A', null, 'B', 'C', 'D', 'E')] }) } }, res);
  assert.equal(res.redirectTo, `/races/${id}`);
  assert.equal(Tanda.findById(tanda.id).empty_lane_mode, 'rotate');
  assert.equal(Tanda.findByRace(id)[0].driver_count, 5);
});

test('la tanda vacía al editar es un error y no toca la guardada', () => {
  const id = carrera();
  crear(id, { tandas: [sl('A', 'B')] });
  const tanda = Tanda.findByRace(id)[0];
  const res = fakeRes();
  TandaController.updateTanda({ params: { id: String(id), tandaId: String(tanda.id) }, t: k => k,
    body: { payload: JSON.stringify({ tandas: [sl()] }) } }, res);
  assert.equal(res.view, 'races/tandas');
  assert.deepEqual(res.data.errors, ['no_participants']);
  assert.equal(Tanda.findByRace(id)[0].driver_count, 2);
});

test('createTandas rechaza una lista vacía de tandas', () => {
  const id = carrera();
  assert.throws(() => TandaBatch.createTandas(Race.findById(id), [], 'rotate'), TandaBatch.TandaBatchError);
});

// ── Preferencia ──────────────────────────────────────────────────────────────

test('«cómo se apuntan los participantes»: por defecto escribir en el carril', () => {
  assert.equal(EntryMode.get(), 'write');
  Settings.set('tanda_entry_mode', 'cualquier cosa');
  assert.equal(EntryMode.get(), 'write');
});

test('se guarda con savePrefs y solo acepta write | drag; la pantalla lo usa', () => {
  const pref = (value) => {
    const res = fakeRes();
    SettingsController.savePrefs({ body: { key: 'tanda_entry_mode', value }, t: k => k }, res);
    return res;
  };
  assert.equal(pref('drag').json_.ok, true);
  assert.equal(EntryMode.get(), 'drag');
  assert.equal(pref('tap').code, 400);
  assert.equal(EntryMode.get(), 'drag');

  const id = carrera();
  const res = fakeRes();
  TandaController.newForm({ params: { id: String(id) }, query: {}, t: k => k }, res);
  assert.equal(res.data.config.mode, 'drag');
  assert.equal(pref('write').json_.value, 'write');
  assert.equal(EntryMode.get(), 'write');
});

test('editar una tanda con mangas ya corridas (solo renombrar): llegan todos los participantes con sus datos y guardar renombra', () => {
  const id = Race.create({ name: 'R', type: 'club', format: 'individual', lanes_count: 4,
    lane_sequence: [1, 2, 3, 4], circuits: [4], has_categoria: 1, has_coche: 1 });
  crear(id, { tandas: [{ slots: [{ name: 'A', categoria: 'GT', coche: 'Audi' }, { name: 'B', categoria: 'LMP' }] }] });
  const tanda = Tanda.findByRace(id)[0];
  db.prepare("UPDATE mangas SET status = 'finished' WHERE tanda_id = ?").run(tanda.id);

  const ed = fakeRes();
  TandaController.editTanda({ params: { id: String(id), tandaId: String(tanda.id) }, t: k => k }, ed);
  assert.equal(ed.data.config.canRestructure, false);
  const slots = ed.data.config.tandas[0].slots.filter(Boolean);
  assert.deepEqual(slots.map(s => [s.name, s.categoria, s.coche]), [['A', 'GT', 'Audi'], ['B', 'LMP', '']]);
  assert.ok(slots.every(s => s.id));

  const res = fakeRes();
  TandaController.updateTanda({ params: { id: String(id), tandaId: String(tanda.id) }, t: k => k,
    body: { payload: JSON.stringify({ tandas: [{ slots: [{ id: slots[0].id, name: 'A2', categoria: 'GT3', coche: 'Audi' }, { id: slots[1].id, name: 'B' }] }] }) } }, res);
  assert.equal(res.redirectTo, `/races/${id}`);
  const d = db.prepare('SELECT name, categoria FROM drivers WHERE id = ?').get(slots[0].id);
  assert.deepEqual(d, { name: 'A2', categoria: 'GT3' });
});

test('tandas.js no deja ningún elemento opcional sin proteger (en renombrar no hay botón de vista previa)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/tandas.js'), 'utf8');
  assert.match(src, /if \(previewBtn\) previewBtn\.addEventListener/);
  assert.doesNotMatch(src, /\n\s*previewBtn\.addEventListener/);
});
