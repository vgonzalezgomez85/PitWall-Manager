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
// Registro de sucesos: cada tanda numera sus mangas desde 1, así que el
// agrupado tiene que ser por manga concreta (manga_id), no por número —
// antes «Manga 1» mezclaba las mangas 1 de todas las tandas.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db        = require('../src/config/database');
const RaceEvent = require('../src/models/RaceEvent');

function crearCarrera() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES ('ev', 'championship', 'team', 'finished', 2, '[1,2]', '[2]', 10)
  `).run().lastInsertRowid;
  const mangas = {};
  [[1, '2026-10-01T19:00:00.000Z'], [2, '2026-10-02T19:00:00.000Z']].forEach(([tanda, base]) => {
    const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, tanda).lastInsertRowid;
    [1, 2].forEach(n => {
      const startedAt = new Date(Date.parse(base) + (n - 1) * 15 * 60000).toISOString();
      mangas[`${tanda}.${n}`] = db.prepare(
        "INSERT INTO mangas (tanda_id, race_id, number, status, started_at) VALUES (?, ?, ?, 'finished', ?)"
      ).run(tandaId, raceId, n, startedAt).lastInsertRowid;
    });
  });
  return { raceId, mangas };
}

test('mismas mangas numeradas en tandas distintas → grupos separados, más reciente arriba', () => {
  const { raceId, mangas } = crearCarrera();
  const ev = (key, n, ms) => RaceEvent.create({ raceId, mangaId: mangas[key], mangaNumber: n, type: 'stop', createdAtMs: ms });
  ev('1.1', 1, Date.parse('2026-10-01T19:10:00Z'));
  ev('1.2', 2, Date.parse('2026-10-01T19:25:00Z'));
  ev('2.1', 1, Date.parse('2026-10-02T19:10:00Z'));
  ev('2.2', 2, Date.parse('2026-10-02T19:25:00Z'));
  RaceEvent.create({ raceId, type: 'stop', createdAtMs: Date.parse('2026-10-02T20:00:00Z') });

  const log = RaceEvent.groupedByRace(raceId);
  assert.equal(log.totalEvents, 5);
  assert.equal(log.multiTanda, true);
  assert.deepEqual(
    log.groups.map(g => [g.tandaNumber, g.mangaNumber, g.items.length]),
    [[2, 2, 1], [2, 1, 1], [1, 2, 1], [1, 1, 1], [null, null, 1]]
  );
  assert.equal(log.groups[0].mangaId, mangas['2.2']);
  assert.equal(log.groups[0].startedAtMs, Date.parse('2026-10-02T19:15:00.000Z'));
});

test('suceso cuya manga se borró → grupo sin manga, no se pierde', () => {
  const { raceId, mangas } = crearCarrera();
  RaceEvent.create({ raceId, mangaId: mangas['1.1'], mangaNumber: 1, type: 'stop', createdAtMs: 1 });
  db.prepare('DELETE FROM mangas WHERE id = ?').run(mangas['1.1']);

  const log = RaceEvent.groupedByRace(raceId);
  assert.equal(log.groups.length, 1);
  assert.equal(log.groups[0].mangaId, null);
  assert.equal(log.groups[0].items.length, 1);
});
