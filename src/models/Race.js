const db = require('../config/database');

class Race {
  static findAll() {
    return db.prepare(`
      SELECT r.*,
        COUNT(DISTINCT td.id) AS tanda_count,
        COUNT(DISTINCT d.id)  AS driver_count
      FROM races r
      LEFT JOIN tandas  td ON td.race_id = r.id
      LEFT JOIN drivers d  ON d.race_id  = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `).all();
  }

  static findById(id) {
    return db.prepare('SELECT * FROM races WHERE id = ?').get(id);
  }

  static create({ name, type, format, lanes_count, lane_sequence, manga_duration_minutes, circuits, has_pole, circuit_id, min_lap_ms,
                  driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms }) {
    const seq  = Array.isArray(lane_sequence) ? JSON.stringify(lane_sequence) : (lane_sequence || '[]');
    const circ = Array.isArray(circuits) ? JSON.stringify(circuits) : '[]';
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO races (name, type, format, lanes_count, lane_sequence, manga_duration_minutes, circuits_config, has_pole, circuit_id, min_lap_ms,
                          driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, format, lanes_count, seq, manga_duration_minutes || 5, circ, has_pole ? 1 : 0,
           circuit_id || null, min_lap_ms || 0,
           driver_min_total_ms || 0, driver_max_total_ms || 0,
           (driver_change_lockout_ms != null ? driver_change_lockout_ms : 120000));
    return lastInsertRowid;
  }

  static getCircuits(race) {
    try {
      const c = JSON.parse(race.circuits_config || '[]');
      if (Array.isArray(c) && c.length > 0) return c;
    } catch {}
    return [race.lanes_count]; // fallback: single circuit
  }

  static updateStatus(id, status) {
    const now = new Date().toISOString();
    if (status === 'active') {
      db.prepare('UPDATE races SET status=?, started_at=? WHERE id=?').run(status, now, id);
    } else if (status === 'finished' || status === 'completed') {
      db.prepare('UPDATE races SET status=?, finished_at=? WHERE id=?').run(status, now, id);
    } else {
      db.prepare('UPDATE races SET status=? WHERE id=?').run(status, id);
    }
  }

  static getLaneSequence(race) {
    // Prefer the assigned circuit's lane sequence (single source of truth).
    // Fall back to the race's own column for legacy races without a circuit.
    if (race.circuit_id) {
      try {
        const Circuit = require('./Circuit');
        const c = Circuit.findById(race.circuit_id);
        const seq = c ? Circuit.getLaneSequence(c) : [];
        if (seq.length > 0) return seq;
      } catch {}
    }
    try { return JSON.parse(race.lane_sequence || '[]'); } catch { return []; }
  }

  static delete(id) {
    return db.prepare('DELETE FROM races WHERE id=?').run(id);
  }
}

module.exports = Race;
