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

class Car {
  static create(brand, model, categoryId, description = '') {
    const stmt = db.prepare(`
      INSERT INTO cars (brand, model, category_id, description)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(brand, model, categoryId, description);
  }

  static findAll() {
    const stmt = db.prepare(`
      SELECT c.*, cat.name as category_name
      FROM cars c
      LEFT JOIN categories cat ON c.category_id = cat.id
      ORDER BY cat.name, c.brand, c.model
    `);
    return stmt.all();
  }

  static findById(id) {
    const stmt = db.prepare(`
      SELECT c.*, cat.name as category_name
      FROM cars c
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE c.id = ?
    `);
    return stmt.get(id);
  }

  static findByCategory(categoryId) {
    const stmt = db.prepare(`
      SELECT c.*, cat.name as category_name
      FROM cars c
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE c.category_id = ?
      ORDER BY c.brand, c.model
    `);
    return stmt.all(categoryId);
  }

  static update(id, brand, model, categoryId, description = '') {
    const stmt = db.prepare(`
      UPDATE cars SET brand = ?, model = ?, category_id = ?, description = ? WHERE id = ?
    `);
    return stmt.run(brand, model, categoryId, description, id);
  }

  static delete(id) {
    const stmt = db.prepare(`
      DELETE FROM cars WHERE id = ?
    `);
    return stmt.run(id);
  }

  // Mapa { "brand|model" → row } normalizado (case+accent insensitive) para
  // detectar duplicados en el importer CSV. Solo brand+model identifican el
  // coche; la categoría y descripción pueden cambiar entre versiones.
  static buildBrandModelIndex() {
    const { normalize } = require('../utils/csv');
    const rows = db.prepare(`
      SELECT c.id, c.brand, c.model, c.description, c.category_id, cat.name AS category_name
      FROM cars c
      LEFT JOIN categories cat ON c.category_id = cat.id
    `).all();
    const map = new Map();
    for (const r of rows) map.set(normalize(r.brand) + '|' + normalize(r.model), r);
    return map;
  }
}

module.exports = Car;
