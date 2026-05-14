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

  // ── Per-category minimum lap times ─────────────────────────────────────────
  static getCategoryTimes(circuitId) {
    return db.prepare(`
      SELECT cct.category_id, cct.min_lap_ms, cat.name AS category_name
      FROM circuit_category_times cct
      JOIN categories cat ON cat.id = cct.category_id
      WHERE cct.circuit_id = ?
      ORDER BY cat.name
    `).all(circuitId);
  }

  // times: { [categoryId]: minLapMs }  — entries with 0/null/empty are removed
  static setCategoryTimes(circuitId, times) {
    const del = db.prepare('DELETE FROM circuit_category_times WHERE circuit_id = ? AND category_id = ?');
    const ins = db.prepare(`
      INSERT INTO circuit_category_times (circuit_id, category_id, min_lap_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(circuit_id, category_id) DO UPDATE SET min_lap_ms = excluded.min_lap_ms
    `);
    const tx = db.transaction(() => {
      for (const [catId, ms] of Object.entries(times || {})) {
        const cid = parseInt(catId, 10);
        const m   = parseInt(ms, 10);
        if (!cid) continue;
        if (!m || m <= 0) del.run(circuitId, cid);
        else              ins.run(circuitId, cid, m);
      }
    });
    tx();
  }

  static getMinLapMsForCategory(circuitId, categoryId) {
    if (categoryId) {
      const row = db.prepare('SELECT min_lap_ms FROM circuit_category_times WHERE circuit_id=? AND category_id=?').get(circuitId, categoryId);
      if (row && row.min_lap_ms > 0) return row.min_lap_ms;
    }
    const c = db.prepare('SELECT min_lap_ms FROM circuits WHERE id=?').get(circuitId);
    return c ? c.min_lap_ms : 0;
  }
}

module.exports = Circuit;
