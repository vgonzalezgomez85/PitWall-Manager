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
// Los equipos de una carrera de resistencia con pole se crean YA al confirmar
// el asistente (con su PIN de Lap), en vez de esperar a asignar carriles al
// terminar la pole — así el cliente Lap funciona DURANTE la propia pole.
// assignLanes debe REUTILIZAR esa misma fila (mismo id → el PIN repartido
// sigue valiendo) en vez de duplicarla.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db              = require('../src/config/database');
const Race            = require('../src/models/Race');
const Team            = require('../src/models/Team');
const PoleSession     = require('../src/models/PoleSession');
const RaceController  = require('../src/controllers/RaceController');
const PoleController  = require('../src/controllers/PoleController');
const LapController   = require('../src/controllers/LapController');

function crearCarreraConPole(participants) {
  let redirectedTo = null;
  const req = {
    session: {
      wizard: {
        name: 'Test resistencia', type: 'club', format: 'team',
        lanes_count: 6, lane_sequence: [1, 2, 3, 4, 5, 6],
        manga_duration_minutes: 5, has_pole: 1,
        participants,
      },
    },
  };
  const res = { redirect: (url) => { redirectedTo = url; } };
  RaceController.create(req, res);
  const raceId = parseInt(redirectedTo.split('/').pop(), 10);
  return raceId;
}

test('los equipos con pole se crean YA al confirmar, con PIN listo, sin tanda', () => {
  const raceId = crearCarreraConPole([{ name: 'Equipo A' }, { name: 'Equipo B' }]);
  const teams = db.prepare('SELECT * FROM teams WHERE race_id = ? ORDER BY id ASC').all(raceId);
  assert.equal(teams.length, 2);
  teams.forEach(t => {
    assert.equal(t.tanda_id, null);
    assert.ok(t.lap_pin && /^\d{4}$/.test(t.lap_pin));
  });
  assert.deepEqual(teams.map(t => t.name).sort(), ['Equipo A', 'Equipo B']);
});

test('el cliente Lap ya lista el equipo (con PIN) mientras la pole está en marcha', () => {
  const raceId = crearCarreraConPole([{ name: 'Equipo A' }, { name: 'Equipo B' }]);
  const teams = Team.withLapPins(raceId);
  assert.equal(teams.length, 2);
  assert.ok(teams.every(t => t.lap_pin));
});

test('assignLanes REUTILIZA la fila maestra (mismo id, mismo PIN) al asignar carriles', () => {
  const raceId = crearCarreraConPole([{ name: 'Equipo A' }, { name: 'Equipo B' }]);
  const before = db.prepare('SELECT id, lap_pin FROM teams WHERE race_id = ? ORDER BY name ASC').all(raceId);

  const session = PoleSession.findByRace(raceId);
  const entries = PoleSession.getEntriesOrdered(session.id);
  // Da tiempo a los dos para que assignLanes tenga con qué ordenar.
  PoleSession.submitTime(session.id, entries[0].id, 11000);
  PoleSession.submitTime(session.id, entries[1].id, 12000);

  const req = { params: { id: String(raceId) }, body: { order: ['Equipo A', 'Equipo B'] } };
  const res = { redirect: () => {}, status: () => res, render: () => {} };
  PoleController.assignLanes(req, res);

  const after = db.prepare('SELECT id, lap_pin, tanda_id, lane FROM teams WHERE race_id = ? ORDER BY name ASC').all(raceId);
  assert.equal(after.length, 2, 'no debe duplicar filas');
  assert.deepEqual(after.map(t => t.id), before.map(t => t.id), 'mismo id de equipo antes y después');
  assert.deepEqual(after.map(t => t.lap_pin), before.map(t => t.lap_pin), 'mismo PIN antes y después');
  after.forEach(t => assert.notEqual(t.tanda_id, null));
});

test('LapController._buildPoleLive refleja el turno y la clasificación parcial durante la pole', () => {
  const raceId = crearCarreraConPole([{ name: 'Equipo A' }, { name: 'Equipo B' }]);
  const race = Race.findById(raceId);
  const session = PoleSession.findByRace(raceId);
  PoleSession.startPole(session.id, 1, null);   // → in_progress, current_idx 0

  const teamA = Team.findById(Team.withLapPins(raceId).find(t => t.name === 'Equipo A').id);
  const teamB = Team.findById(Team.withLapPins(raceId).find(t => t.name === 'Equipo B').id);

  const liveA = LapController._buildPoleLive(race, teamA);
  assert.equal(liveA.myTurn, true);
  assert.equal(liveA.myPosition, 1);
  assert.equal(liveA.myTurnRunning, false, 'PoleTimingService no está corriendo de verdad en este test');

  const liveB = LapController._buildPoleLive(race, teamB);
  assert.equal(liveB.myTurn, false);
  assert.equal(liveB.myPosition, 2);

  const entries = PoleSession.getEntriesOrdered(session.id);
  PoleSession.submitTime(session.id, entries[0].id, 11000);   // A termina, pasa a B

  const liveA2 = LapController._buildPoleLive(race, teamA);
  assert.equal(liveA2.myTurn, false);
  assert.equal(liveA2.myLapTimeMs, 11000);
  const liveB2 = LapController._buildPoleLive(race, teamB);
  assert.equal(liveB2.myTurn, true);
});

test('LapController._buildPoleResult solo aparece cuando la pole termina', () => {
  const raceId = crearCarreraConPole([{ name: 'Equipo A' }, { name: 'Equipo B' }]);
  const race = Race.findById(raceId);
  const session = PoleSession.findByRace(raceId);
  PoleSession.startPole(session.id, 1, null);

  const teamA = Team.findById(Team.withLapPins(raceId).find(t => t.name === 'Equipo A').id);
  assert.equal(LapController._buildPoleResult(race, teamA), null, 'aún en marcha → sin resultado');

  const entries = PoleSession.getEntriesOrdered(session.id);
  PoleSession.submitTime(session.id, entries[0].id, 12000);
  PoleSession.submitTime(session.id, entries[1].id, 11000);   // B más rápido → pole

  const res = LapController._buildPoleResult(race, teamA);
  assert.equal(res.position, 2);
  assert.equal(res.lapTimeMs, 12000);
  assert.equal(LapController._buildPoleLive(race, teamA), null, 'ya no está en marcha → sin poleLive');
});
