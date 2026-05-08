const db = require('../config/database');

class Settings {
  static get(key, defaultValue = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  }

  static set(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }

  static getAll() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  static setMany(obj) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const [k, v] of Object.entries(obj)) stmt.run(k, String(v));
    })();
  }
}

module.exports = Settings;
