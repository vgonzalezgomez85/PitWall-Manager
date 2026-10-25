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
// Borrar una tanda se lleva todo lo suyo: mangas, pilotos, equipos y vueltas.
// Antes solo borraba la tanda y sus pilotos/equipos se quedaban sueltos en la
// carrera (la FK es ON DELETE SET NULL).
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db     = require('../src/config/database');
const Race   = require('../src/models/Race');
const Tanda  = require('../src/models/Tanda');
const Manga  = require('../src/models/Manga');
const Driver = require('../src/models/Driver');
const Team   = require('../src/models/Team');
const Lap    = require('../src/models/Lap');

const count = (sql, ...a) => db.prepare(sql).get(...a).c;

function tandaConPilotos(raceId, n, prefijo) {
  const tandaId = Tanda.create(raceId);
  const ents = Array.from({ length: n }, (_, i) => {
    const id = Driver.create({ race_id: raceId, tanda_id: tandaId, team_id: null, name: prefijo + (i + 1), lane: i + 1, car_number: i + 1 });
    return { id, type: 'driver', name: prefijo + (i + 1) };
  });
  Manga.persistSchedule(tandaId, raceId, Manga.buildSchedule(Race.getLaneSequence(Race.findById(raceId)), ents, 1, 1, 'fixed'));
  return { tandaId, ents };
}

test('individual: borra mangas, pilotos y vueltas de la tanda y deja intacta la otra', () => {
  const raceId = Race.create({
    name: 'borrar', type: 'club', format: 'individual',
    lanes_count: 4, lane_sequence: [1, 2, 3, 4], manga_duration_minutes: 5,
  });
  const a = tandaConPilotos(raceId, 4, 'a');
  const b = tandaConPilotos(raceId, 4, 'b');
  for (const t of [a, b]) {
    const m = Manga.findByTanda(t.tandaId)[0];
    Lap.create({ race_id: raceId, manga_id: m.id, driver_id: t.ents[0].id, team_id: null, lane: 1, lap_number: 1, lap_time_ms: 8000, elapsed_ms: 8000 });
  }

  Tanda.delete(a.tandaId);

  assert.equal(count('SELECT COUNT(*) c FROM tandas WHERE id = ?', a.tandaId), 0);
  assert.equal(count('SELECT COUNT(*) c FROM mangas WHERE tanda_id = ?', a.tandaId), 0);
  assert.equal(count('SELECT COUNT(*) c FROM drivers WHERE race_id = ? AND tanda_id IS NULL', raceId), 0);
  assert.equal(count('SELECT COUNT(*) c FROM laps WHERE race_id = ? AND manga_id IS NULL', raceId), 0);
  assert.equal(count('SELECT COUNT(*) c FROM drivers WHERE tanda_id = ?', b.tandaId), 4);
  assert.equal(count('SELECT COUNT(*) c FROM laps WHERE race_id = ?', raceId), 1);
});

test('equipos: borra los equipos de la tanda y sus pilotos', () => {
  const raceId = Race.create({
    name: 'borrar equipos', type: 'championship', format: 'team',
    lanes_count: 2, lane_sequence: [1, 2], manga_duration_minutes: 5,
  });
  const tandaId = Tanda.create(raceId);
  for (let i = 0; i < 2; i++) {
    const teamId = Team.create({ race_id: raceId, tanda_id: tandaId, name: 'eq' + i, lane: 0, color: '#fff' });
    Driver.create({ race_id: raceId, tanda_id: tandaId, team_id: teamId, name: 'p' + i });
  }

  Tanda.delete(tandaId);

  assert.equal(count('SELECT COUNT(*) c FROM teams WHERE race_id = ?', raceId), 0);
  assert.equal(count('SELECT COUNT(*) c FROM drivers WHERE race_id = ?', raceId), 0);
});
