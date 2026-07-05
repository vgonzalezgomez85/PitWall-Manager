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

class DriverProfile {
  static findAll() {
    return db.prepare(`
      SELECT * FROM driver_profiles
      ORDER BY CASE category
        WHEN 'platino' THEN 0 WHEN 'oro' THEN 1
        WHEN 'plata'   THEN 2 WHEN 'bronce' THEN 3
        ELSE 4 END, name ASC
    `).all();
  }

  static findById(id) {
    return db.prepare('SELECT * FROM driver_profiles WHERE id = ?').get(id);
  }

  static create({ name, category }) {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO driver_profiles (name, category) VALUES (?, ?)'
    ).run(name, category);
    db.prepare('UPDATE driver_profiles SET qr_code = ? WHERE id = ?')
      .run(`DRV:${lastInsertRowid}`, lastInsertRowid);
    return lastInsertRowid;
  }

  static update(id, { name, category }) {
    db.prepare('UPDATE driver_profiles SET name = ?, category = ? WHERE id = ?').run(name, category, id);
  }

  static delete(id) {
    db.prepare('DELETE FROM driver_profiles WHERE id = ?').run(id);
  }

  // Devuelve mapa { normName → row } para lookup case+accent insensitive.
  // Útil en el importer CSV para detectar duplicados.
  static buildNameIndex() {
    const { normalize } = require('../utils/csv');
    const rows = db.prepare('SELECT id, name, category FROM driver_profiles').all();
    const map = new Map();
    for (const r of rows) map.set(normalize(r.name), r);
    return map;
  }
}

module.exports = DriverProfile;
