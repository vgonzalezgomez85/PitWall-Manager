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
// Exposición del control de neumáticos a la app móvil:
//   • el detalle de carrera lleva `tirePairsPerTeam` (dotación por equipo).
//   • GET /api/mobile/races/:id/tires devuelve dotación + historial por equipo
//     (canónico) con nº de juego, manga y minuto:segundo.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db               = require('../src/config/database');
const Race             = require('../src/models/Race');
const TireChange       = require('../src/models/TireChange');
const MobileController  = require('../src/controllers/MobileController');

// ── Utilidades de montaje (idénticas a tires-control) ───────────────────────
function nuevaCarrera(tirePairs) {
  return Race.create({
    name: 'Resis', type: 'championship', format: 'team',
    lanes_count: 8, lane_sequence: [1,2,3,4,5,6,7,8], manga_duration_minutes: 20,
    tire_pairs_per_team: tirePairs,
  });
}
function nuevaTanda(raceId, number) {
  return db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, number).lastInsertRowid;
}
function nuevoEquipo(raceId, tandaId, name, lane) {
  return db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, ?, ?)')
    .run(raceId, tandaId, name, lane, '#abc').lastInsertRowid;
}
function fakeReq(params) { return { params: params || {}, t: (k) => k }; }
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (o) => { r.body = o; return r; };
  return r;
}

// ── Detalle de carrera lleva la dotación ────────────────────────────────────
test('racesShow: el objeto race incluye tirePairsPerTeam', () => {
  const raceId = nuevaCarrera(4);
  const tanda  = nuevaTanda(raceId, 1);
  nuevoEquipo(raceId, tanda, 'Alfa', 1);

  const res = fakeRes();
  MobileController.racesShow(fakeReq({ id: String(raceId) }), res);
  assert.equal(res.body.race.tirePairsPerTeam, 4);
});

test('racesShow: sin control (0) la dotación llega como 0', () => {
  const raceId = nuevaCarrera(0);
  const res = fakeRes();
  MobileController.racesShow(fakeReq({ id: String(raceId) }), res);
  assert.equal(res.body.race.tirePairsPerTeam, 0);
});

// ── Endpoint de neumáticos ──────────────────────────────────────────────────
test('racesTires: dotación intacta y equipos sin cambios', () => {
  const raceId = nuevaCarrera(5);
  const tanda  = nuevaTanda(raceId, 1);
  nuevoEquipo(raceId, tanda, 'Alfa', 1);
  nuevoEquipo(raceId, tanda, 'Beta', 2);

  const res = fakeRes();
  MobileController.racesTires(fakeReq({ id: String(raceId) }), res);
  assert.equal(res.body.allowance, 5);
  assert.equal(res.body.teams.length, 2);
  res.body.teams.forEach(t => {
    assert.equal(t.used, 0);
    assert.equal(t.available, 5);
    assert.deepEqual(t.changes, []);
  });
});

test('racesTires: cambios en orden cronológico con nº de juego, manga y elapsed', () => {
  const raceId = nuevaCarrera(4);
  const tanda  = nuevaTanda(raceId, 1);
  const alfa   = nuevoEquipo(raceId, tanda, 'Alfa', 1);
  // Dos entregas: juego 1 (manga 1) y juego 2 (manga 2). createdAtMs crece.
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 1, raceElapsedMs: 60000, createdAtMs: 1000 });
  TireChange.add({ raceId, teamId: alfa, mangaNumber: 2, raceElapsedMs: 90000, createdAtMs: 2000 });

  const res = fakeRes();
  MobileController.racesTires(fakeReq({ id: String(raceId) }), res);

  const alfaOut = res.body.teams.find(t => t.name === 'Alfa');
  assert.equal(alfaOut.used, 2);
  assert.equal(alfaOut.available, 2);
  assert.equal(alfaOut.changes.length, 2);
  // Cronológico: el más antiguo primero, numerado 1, 2.
  assert.deepEqual(alfaOut.changes.map(c => c.setNumber), [1, 2]);
  assert.deepEqual(alfaOut.changes.map(c => c.mangaNumber), [1, 2]);
  assert.deepEqual(alfaOut.changes.map(c => c.raceElapsedMs), [60000, 90000]);
});

test('racesTires: un equipo con tandas cuenta como uno (canónico por nombre)', () => {
  const raceId = nuevaCarrera(6);
  const t1 = nuevaTanda(raceId, 1);
  const t2 = nuevaTanda(raceId, 2);
  const alfa1 = nuevoEquipo(raceId, t1, 'Alfa', 1);   // canónico
  const alfa2 = nuevoEquipo(raceId, t2, 'Alfa', 1);
  const canon = TireChange.canonicalTeamId(raceId, alfa2);
  TireChange.add({ raceId, teamId: canon, mangaNumber: 1, createdAtMs: 1 });

  const res = fakeRes();
  MobileController.racesTires(fakeReq({ id: String(raceId) }), res);
  assert.equal(res.body.teams.length, 1);
  assert.equal(res.body.teams[0].id, alfa1);
  assert.equal(res.body.teams[0].used, 1);
  assert.equal(res.body.teams[0].changes[0].setNumber, 1);
});

test('racesTires: 404 si la carrera no existe', () => {
  const res = fakeRes();
  MobileController.racesTires(fakeReq({ id: '999999' }), res);
  assert.equal(res.statusCode, 404);
});
