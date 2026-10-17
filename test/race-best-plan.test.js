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
// RESISLEMANS 2 (2026-10-16): `Lap.raceBestByLane` corre en el arranque de cada
// manga y al abrir el directo. Con las estadísticas que PitWall recoge al
// arrancar (carrera aún vacía), SQLite ponía `laps` fuera del JOIN y recalculaba
// la mejor por carril por cada vuelta: 6 s → 20 s de servidor congelado en el
// PC del club, creciendo en cada manga hasta reiniciar. Estas son las
// estadísticas reales de la reproducción con las tramas del club.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');

after(limpiarBdTemporal);

const STATS_DEL_ARRANQUE = {
  idx_laps_race_ghost_entity_manga: '23033 7678 5759 5759 339 58 1',
  idx_laps_source:                  '23033 11517',
  idx_laps_manga_lane_elapsed:      '23033 344 58 1',
  idx_laps_race_team_driver:        '23033 7678 7678 344',
  idx_laps_race_flags:              '23033 7678 5759 3291 70',
  idx_laps_manga:                   '23033 344',
  idx_laps_race_lane:               '23033 7678 1280',
};

function seed() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes, min_lap_ms)
    VALUES ('rb', 'club', 'individual', 'active', 2, '[1,2]', '[2]', 10, 5000)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  const ana  = db.prepare('INSERT INTO drivers (race_id, tanda_id, name) VALUES (?, ?, ?)').run(raceId, tandaId, 'Ana').lastInsertRowid;
  const beto = db.prepare('INSERT INTO drivers (race_id, tanda_id, name) VALUES (?, ?, ?)').run(raceId, tandaId, 'Beto').lastInsertRowid;
  const vuelta = (driver, lane, n, ms, extra = {}) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: null, driver_id: driver, lane,
    lap_number: n, lap_time_ms: ms, elapsed_ms: n * ms, ...extra,
  });
  vuelta(ana, 1, 1, 6000);                      // 1ª vuelta: no cuenta
  vuelta(ana, 1, 2, 4000);                      // por debajo del Pt: fantasma
  vuelta(ana, 1, 3, 7600, { is_exit: 1 });
  vuelta(ana, 1, 4, 7700);
  vuelta(ana, 1, 5, 7800);
  vuelta(beto, 2, 1, 6500);
  vuelta(beto, 2, 2, 7900);
  vuelta(beto, 2, 3, 7950, { is_ghost: 1 });
  return raceId;
}

function conEstadisticasDelArranque() {
  db.exec('ANALYZE');
  const put = db.prepare("INSERT OR REPLACE INTO sqlite_stat1 (tbl, idx, stat) VALUES ('laps', ?, ?)");
  for (const [idx, stat] of Object.entries(STATS_DEL_ARRANQUE)) put.run(idx, stat);
  db.exec('ANALYZE sqlite_schema');   // recarga las estadísticas en la conexión
}

function sqlDeRaceBest(raceId) {
  const prepare = db.prepare;
  let sql = null;
  db.prepare = function (s) { if (s.includes('best_per_lane')) sql = s; return prepare.call(this, s); };
  try { Lap.raceBestByLane(raceId); } finally { db.prepare = prepare; }
  return sql;
}

test('busca la fila de la mejor vuelta por (carrera, carril) aunque las estadísticas sean las del arranque', () => {
  const raceId = seed();
  conEstadisticasDelArranque();
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sqlDeRaceBest(raceId)).all(raceId, raceId, raceId).map(r => r.detail);
  const deL = plan.find(d => / l USING /.test(d) || / l$/.test(d));
  assert.match(deL, /^SEARCH l USING INDEX idx_laps_race_lane \(race_id=\? AND lane=\?\)/, plan.join('\n'));
});

test('la mejor vuelta por carril sale bien', () => {
  const raceId = seed();
  conEstadisticasDelArranque();
  const rows = Lap.raceBestByLane(raceId).map(r => [r.lane, r.bestLapMs, r.entityName, r.entityType]);
  assert.deepEqual(rows, [[1, 7700, 'Ana', 'driver'], [2, 7900, 'Beto', 'driver']]);
});
