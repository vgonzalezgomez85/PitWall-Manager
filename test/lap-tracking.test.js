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
// Seguimiento de rivales en Lap web: lista por equipo (máx. 5, por nombre) y
// números por carril SOLO de mangas terminadas.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db            = require('../src/config/database');
const Race          = require('../src/models/Race');
const Lap           = require('../src/models/Lap');
const LapTracking   = require('../src/models/LapTracking');
const LapController = require('../src/controllers/LapController');

function carrera(nombres) {
  const raceId = Race.create({
    name: 'Resis', type: 'championship', format: 'team',
    lanes_count: 4, lane_sequence: [1,2,3,4], manga_duration_minutes: 5,
  });
  const ids = {};
  for (const n of nombres) {
    ids[n] = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, NULL, ?, 0, ?)')
      .run(raceId, n, '#abc').lastInsertRowid;
  }
  return { raceId, ids };
}
function manga(raceId, number, status) {
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, number).lastInsertRowid;
  return db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, ?, ?)')
    .run(tandaId, raceId, number, status).lastInsertRowid;
}
function vueltas(raceId, mangaId, teamId, lane, tiempos, extra = {}) {
  tiempos.forEach((ms, i) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: teamId, lane,
    lap_number: i + 1, lap_time_ms: ms, is_warmup: i === 0 ? 1 : 0,
    ...(extra[i] || {}),
  }));
}

test('setFor: máx. 5, sin el propio equipo, sin duplicados ni nombres ajenos', () => {
  const { raceId } = carrera(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  const saved = LapTracking.setFor(raceId, 'A', ['A', 'B', 'B', 'X', 'C', 'D', 'E', 'F', 'G']);
  assert.deepEqual(saved, ['B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(LapTracking.listFor(raceId, 'A'), ['B', 'C', 'D', 'E', 'F']);
  LapTracking.setFor(raceId, 'A', ['G']);
  assert.deepEqual(LapTracking.listFor(raceId, 'A'), ['G']);
  assert.deepEqual(LapTracking.listFor(raceId, 'B'), []);
});

test('por carril: solo mangas terminadas; rápida sin warmup ni salidas; las dos medias', () => {
  LapTracking._resetCache();
  const { raceId, ids } = carrera(['A', 'B']);
  const m1 = manga(raceId, 1, 'finished');
  const m2 = manga(raceId, 2, 'active');
  // carril 1: warmup 20000, 10000, 12000 (salida), 11000
  vueltas(raceId, m1, ids.A, 1, [20000, 10000, 12000, 11000], { 2: { is_exit: 1 } });
  vueltas(raceId, m1, ids.A, 2, [9000, 9500]);
  Lap.create({ race_id: raceId, manga_id: m1, team_id: ids.A, lane: 2, lap_number: 3, lap_time_ms: 3000, is_ghost: 1 });
  vueltas(raceId, m2, ids.A, 3, [8000, 8000, 8000]);   // manga viva: no cuenta

  const s = LapTracking.laneStatsByName(raceId).A;
  assert.equal(s.laps, 6);
  assert.deepEqual(s.lanes.map(l => l.lane), [1, 2]);
  const c1 = s.lanes[0];
  assert.equal(c1.laps, 4);
  assert.equal(c1.bestMs, 10000);
  assert.equal(c1.avgAllMs, 11000);     // (10000+12000+11000)/3
  assert.equal(c1.avgCleanMs, 10500);   // (10000+11000)/2
  assert.equal(s.lanes[1].bestMs, 9500);
  assert.equal(s.bestMs, 9500);
  assert.equal(s.avgCleanMs, Math.round((10000 + 11000 + 9500) / 3));
});

test('caché: cruces de la manga viva no invalidan; cerrar la manga sí', () => {
  LapTracking._resetCache();
  const { raceId, ids } = carrera(['A']);
  const m1 = manga(raceId, 1, 'finished');
  const m2 = manga(raceId, 2, 'active');
  vueltas(raceId, m1, ids.A, 1, [20000, 10000]);
  const antes = LapTracking.laneStatsByName(raceId);
  vueltas(raceId, m2, ids.A, 2, [20000, 9000]);
  assert.equal(LapTracking.laneStatsByName(raceId), antes);
  db.prepare("UPDATE mangas SET status = 'finished' WHERE id = ?").run(m2);
  const despues = LapTracking.laneStatsByName(raceId);
  assert.notEqual(despues, antes);
  assert.equal(despues.A.laps, 4);
});

test('_buildTracking: el propio equipo primero, luego los seguidos en orden', () => {
  LapTracking._resetCache();
  const { raceId, ids } = carrera(['A', 'B', 'C']);
  const m1 = manga(raceId, 1, 'finished');
  vueltas(raceId, m1, ids.B, 1, [20000, 10000]);
  LapTracking.setFor(raceId, 'A', ['C', 'B']);
  const out = LapController._buildTracking(Race.findById(raceId), { id: ids.A, name: 'A' });
  assert.deepEqual(out.teams.map(t => [t.name, t.isMe]), [['A', true], ['C', false], ['B', false]]);
  assert.equal(out.teams[0].laps, 0);
  assert.equal(out.teams[2].laps, 2);
  assert.deepEqual(out.candidates.map(c => c.name), ['B', 'C']);
  assert.equal(out.max, 5);
});

test('equipos duplicados por tanda se agrupan por nombre', () => {
  LapTracking._resetCache();
  const { raceId, ids } = carrera(['A']);
  const dup = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, NULL, ?, 0, ?)')
    .run(raceId, 'A', '#abc').lastInsertRowid;
  const m1 = manga(raceId, 1, 'finished');
  vueltas(raceId, m1, ids.A, 1, [20000, 10000]);
  vueltas(raceId, m1, dup, 1, [20000, 11000]);
  const s = LapTracking.laneStatsByName(raceId).A;
  assert.equal(s.lanes.length, 1);
  assert.equal(s.lanes[0].laps, 4);
});

// ── API móvil (app PitWall Lap) ────────────────────────────────────────────
const MobileController = require('../src/controllers/MobileController');
const Team = require('../src/models/Team');

function llamar(method, raceId, { query = {}, body = {} } = {}) {
  let status = 200, json = null;
  const res = { status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  MobileController.racesTracking({ method, params: { id: String(raceId) }, query, body }, res);
  return { status, json };
}

test('móvil: GET devuelve el seguimiento; POST pide el PIN de la hoja (fila canónica)', () => {
  LapTracking._resetCache();
  const { raceId, ids } = carrera(['A', 'B']);
  // Fila de tanda del mismo equipo, con otro PIN: el que vale es el de la maestra.
  const tandaRow = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, NULL, ?, 0, ?)')
    .run(raceId, 'A', '#abc').lastInsertRowid;
  Team.ensureLapPins(raceId);
  const pinMaestra = db.prepare('SELECT lap_pin FROM teams WHERE id = ?').get(ids.A).lap_pin;

  const g = llamar('GET', raceId, { query: { team: String(tandaRow) } });
  assert.equal(g.status, 200);
  assert.equal(g.json.teams[0].name, 'A');
  assert.equal(g.json.pinRequired, true);

  assert.equal(llamar('POST', raceId, { body: { team: tandaRow, names: ['B'], pin: '0000' } }).status, 403);
  const ok = llamar('POST', raceId, { body: { team: tandaRow, names: ['B'], pin: pinMaestra } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.tracked, ['B']);

  Race.setLapPinRequired(raceId, false);
  assert.equal(llamar('POST', raceId, { body: { team: ids.A, names: [] } }).status, 200);
  assert.equal(llamar('GET', raceId, { query: { team: '99999' } }).status, 404);
});
