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
const db = require('../config/database');

class Driver {
  static findByRace(raceId) {
    return db.prepare(`
      SELECT d.*, t.name AS team_name, t.color AS team_color
      FROM drivers d
      LEFT JOIN teams t ON t.id = d.team_id
      WHERE d.race_id = ?
      ORDER BY d.tanda_id ASC, d.lane ASC, d.id ASC
    `).all(raceId);
  }

  static findByTanda(tandaId) {
    return db.prepare(`
      SELECT d.*, t.name AS team_name, t.color AS team_color
      FROM drivers d
      LEFT JOIN teams t ON t.id = d.team_id
      WHERE d.tanda_id = ?
      ORDER BY d.id ASC
    `).all(tandaId);
  }

  static create({ race_id, tanda_id, team_id, name, lane, car_number }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO drivers (race_id, tanda_id, team_id, name, lane, car_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(race_id, tanda_id ?? null, team_id ?? null, name, lane ?? null, car_number ?? null);
    return lastInsertRowid;
  }

  static createMany(drivers) {
    const stmt = db.prepare(`
      INSERT INTO drivers (race_id, tanda_id, team_id, name, lane, car_number)
      VALUES (@race_id, @tanda_id, @team_id, @name, @lane, @car_number)
    `);
    db.transaction((list) => { for (const d of list) stmt.run(d); })(drivers);
  }
}

module.exports = Driver;
