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
