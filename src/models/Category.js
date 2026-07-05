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

class Category {
  static create(name, description = '') {
    const stmt = db.prepare(`
      INSERT INTO categories (name, description)
      VALUES (?, ?)
    `);
    return stmt.run(name, description);
  }

  static findAll() {
    const stmt = db.prepare(`
      SELECT c.*, COUNT(cars.id) AS car_count
      FROM categories c
      LEFT JOIN cars ON cars.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `);
    return stmt.all();
  }

  static findById(id) {
    const stmt = db.prepare(`
      SELECT * FROM categories WHERE id = ?
    `);
    return stmt.get(id);
  }

  static update(id, name, description = '') {
    const stmt = db.prepare(`
      UPDATE categories SET name = ?, description = ? WHERE id = ?
    `);
    return stmt.run(name, description, id);
  }

  static delete(id) {
    const stmt = db.prepare(`
      DELETE FROM categories WHERE id = ?
    `);
    return stmt.run(id);
  }

  static findByName(name) {
    const stmt = db.prepare(`
      SELECT * FROM categories WHERE name = ?
    `);
    return stmt.get(name);
  }
}

module.exports = Category;
