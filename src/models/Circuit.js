const db = require('../config/database');

class Circuit {
  static findAll() {
    return db.prepare('SELECT * FROM circuits ORDER BY name ASC').all();
  }

  static findById(id) {
    return db.prepare('SELECT * FROM circuits WHERE id = ?').get(id);
  }

  static create({ name, circuits_count, circuits_config, lanes_count, min_lap_ms, description }) {
    const cfg = Array.isArray(circuits_config) ? JSON.stringify(circuits_config) : (circuits_config || '[]');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO circuits (name, circuits_count, circuits_config, lanes_count, min_lap_ms, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, circuits_count || 1, cfg, lanes_count || 6, min_lap_ms || 0, description || null);
    return lastInsertRowid;
  }

  static update(id, { name, circuits_count, circuits_config, lanes_count, min_lap_ms, description }) {
    const cfg = Array.isArray(circuits_config) ? JSON.stringify(circuits_config) : (circuits_config || '[]');
    db.prepare(`
      UPDATE circuits SET name=?, circuits_count=?, circuits_config=?, lanes_count=?, min_lap_ms=?, description=?
      WHERE id=?
    `).run(name, circuits_count || 1, cfg, lanes_count || 6, min_lap_ms || 0, description || null, id);
  }

  static delete(id) {
    db.prepare('DELETE FROM circuits WHERE id = ?').run(id);
  }

  static getConfig(circuit) {
    try {
      const c = JSON.parse(circuit.circuits_config || '[]');
      if (Array.isArray(c) && c.length > 0) return c;
    } catch {}
    return [circuit.lanes_count];
  }
}

module.exports = Circuit;
