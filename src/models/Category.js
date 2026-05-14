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
