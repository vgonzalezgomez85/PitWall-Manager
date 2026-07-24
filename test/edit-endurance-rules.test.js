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
// Editar carrera de resistencia: las reglas de turnos por piloto y los
// neumáticos por equipo se pueden ajustar desde /races/:id/edit MIENTRAS no
// se haya corrido ninguna manga. Rodada una manga, quedan bloqueadas.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db             = require('../src/config/database');
const Race           = require('../src/models/Race');
const RaceController = require('../src/controllers/RaceController');

function nuevaCarrera(extra) {
  return Race.create(Object.assign({
    name: 'Resis', type: 'championship', format: 'team',
    lanes_count: 8, lane_sequence: [1,2,3,4,5,6,7,8], manga_duration_minutes: 20,
    driver_min_total_ms: 0, driver_max_total_ms: 0,
    driver_change_lockout_ms: 120000, driver_max_runs: 0,
    tire_pairs_per_team: 0,
  }, extra || {}));
}
function nuevaTanda(raceId, number) {
  return db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, number).lastInsertRowid;
}
function nuevaManga(raceId, tandaId, number, status, dur) {
  return db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, actual_duration_ms) VALUES (?, ?, ?, ?, ?)')
    .run(tandaId, raceId, number, status || 'pending', dur == null ? null : dur).lastInsertRowid;
}
function fakeReq(id, body) { return { params: { id: String(id) }, body: body || {}, t: (k) => k }; }
function fakeRes() {
  const r = { statusCode: 200, redirectedTo: null, rendered: null };
  r.status   = (c) => { r.statusCode = c; return r; };
  r.redirect = (u) => { r.redirectedTo = u; return r; };
  r.render   = (v, locals) => { r.rendered = { view: v, locals }; return r; };
  return r;
}

// ── hasRunAnyManga ───────────────────────────────────────────────────────────

test('hasRunAnyManga: falso sin mangas / con mangas pendientes', () => {
  const race = nuevaCarrera();
  assert.equal(Race.hasRunAnyManga(race), false);
  const t = nuevaTanda(race, 1);
  nuevaManga(race, t, 1, 'pending');
  assert.equal(Race.hasRunAnyManga(race), false);
});

test('hasRunAnyManga: cierto con manga activa, finalizada o con duración real', () => {
  const rA = nuevaCarrera(); nuevaManga(rA, nuevaTanda(rA, 1), 1, 'active');
  assert.equal(Race.hasRunAnyManga(rA), true);
  const rB = nuevaCarrera(); nuevaManga(rB, nuevaTanda(rB, 1), 1, 'finished');
  assert.equal(Race.hasRunAnyManga(rB), true);
  const rC = nuevaCarrera(); nuevaManga(rC, nuevaTanda(rC, 1), 1, 'pending', 120000);
  assert.equal(Race.hasRunAnyManga(rC), true);
});

// ── Edición permitida antes de correr ────────────────────────────────────────

test('update guarda turnos y neumáticos cuando no se ha corrido ninguna manga', () => {
  const race = nuevaCarrera();
  const res  = fakeRes();
  RaceController.update(fakeReq(race, {
    name: 'Resis 24h',
    driver_min_total_min: '30', driver_max_total_min: '90',
    driver_max_runs: '5', driver_change_lockout_s: '60',
    tire_pairs_per_team: '4',
  }), res);
  assert.equal(res.redirectedTo, `/races/${race}`);
  const r = Race.findById(race);
  assert.equal(r.name, 'Resis 24h');
  assert.equal(r.driver_min_total_ms, 30 * 60000);
  assert.equal(r.driver_max_total_ms, 90 * 60000);
  assert.equal(r.driver_max_runs, 5);
  assert.equal(r.driver_change_lockout_ms, 60000);
  assert.equal(r.tire_pairs_per_team, 4);
});

test('update rechaza max < min (no guarda) y re-renderiza con el error', () => {
  const race = nuevaCarrera({ tire_pairs_per_team: 3 });
  const res  = fakeRes();
  RaceController.update(fakeReq(race, {
    name: 'Resis', driver_min_total_min: '90', driver_max_total_min: '30',
  }), res);
  assert.equal(res.redirectedTo, null);
  assert.ok(res.rendered.locals.errors.includes('driver_max_below_min'));
  // No se persiste ningún cambio de reglas.
  const r = Race.findById(race);
  assert.equal(r.driver_min_total_ms, 0);
  assert.equal(r.tire_pairs_per_team, 3);
});

// ── Bloqueo tras correr una manga ────────────────────────────────────────────

test('update ignora turnos/neumáticos una vez corrida una manga (name sí cambia)', () => {
  const race = nuevaCarrera({ driver_max_runs: 2, tire_pairs_per_team: 6 });
  nuevaManga(race, nuevaTanda(race, 1), 1, 'finished');
  const res = fakeRes();
  RaceController.update(fakeReq(race, {
    name: 'Renombrada', driver_max_runs: '9', tire_pairs_per_team: '99',
  }), res);
  assert.equal(res.redirectedTo, `/races/${race}`);
  const r = Race.findById(race);
  assert.equal(r.name, 'Renombrada');       // el nombre sí es editable siempre
  assert.equal(r.driver_max_runs, 2);        // las reglas quedan bloqueadas
  assert.equal(r.tire_pairs_per_team, 6);
});

test('editForm expone hasRunManga a la vista', () => {
  const race = nuevaCarrera();
  const res1 = fakeRes();
  RaceController.editForm(fakeReq(race, {}), res1);
  assert.equal(res1.rendered.locals.hasRunManga, false);

  nuevaManga(race, nuevaTanda(race, 1), 1, 'active');
  const res2 = fakeRes();
  RaceController.editForm(fakeReq(race, {}), res2);
  assert.equal(res2.rendered.locals.hasRunManga, true);
});
