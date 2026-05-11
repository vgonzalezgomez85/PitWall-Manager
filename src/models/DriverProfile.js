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
}

module.exports = DriverProfile;
