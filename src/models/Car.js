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
