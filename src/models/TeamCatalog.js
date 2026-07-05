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

class TeamCatalog {
  static findAll() {
    const teams = db.prepare('SELECT * FROM teams_catalog ORDER BY name ASC').all();
    const members = db.prepare(`
      SELECT m.*, dp.category
      FROM teams_catalog_members m
      LEFT JOIN driver_profiles dp ON dp.id = m.driver_id
      ORDER BY m.team_id, m.position ASC
    `).all();
    for (const t of teams) {
      t.members = members.filter(m => m.team_id === t.id);
    }
    return teams;
  }

  static findById(id) {
    const team = db.prepare('SELECT * FROM teams_catalog WHERE id = ?').get(id);
    if (!team) return null;
    team.members = db.prepare(`
      SELECT m.*, dp.category
      FROM teams_catalog_members m
      LEFT JOIN driver_profiles dp ON dp.id = m.driver_id
      WHERE m.team_id = ?
      ORDER BY m.position ASC
    `).all(id);
    return team;
  }

  static create({ name, color, notes, country, categoria, coche, car_photo }) {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO teams_catalog (name, color, notes, country, categoria, coche, car_photo) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(name, color || '#8b949e', notes || null, country || null,
          categoria || null, coche || null, car_photo || null);
    return lastInsertRowid;
  }

  static update(id, { name, color, notes, country, categoria, coche, car_photo }) {
    const base = 'UPDATE teams_catalog SET name=?, color=?, notes=?, country=?, categoria=?, coche=?';
    if (car_photo !== undefined) {
      db.prepare(`${base}, car_photo=? WHERE id=?`)
        .run(name, color || '#8b949e', notes || null, country || null,
             categoria || null, coche || null, car_photo, id);
    } else {
      db.prepare(`${base} WHERE id=?`)
        .run(name, color || '#8b949e', notes || null, country || null,
             categoria || null, coche || null, id);
    }
  }

  static delete(id) {
    db.prepare('DELETE FROM teams_catalog WHERE id = ?').run(id);
  }

  // Mapa { normName → row } para detectar duplicados case+accent insensitive.
  static buildNameIndex() {
    const { normalize } = require('../utils/csv');
    const rows = db.prepare('SELECT id, name, categoria, coche, country, notes FROM teams_catalog').all();
    const map = new Map();
    for (const r of rows) map.set(normalize(r.name), r);
    return map;
  }

  static setMembers(teamId, members) {
    db.prepare('DELETE FROM teams_catalog_members WHERE team_id = ?').run(teamId);
    const insert = db.prepare(
      'INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES (?, ?, ?, ?)'
    );
    members.forEach((m, i) => {
      insert.run(teamId, m.driver_id || null, m.name, i);
    });
  }
}

module.exports = TeamCatalog;
