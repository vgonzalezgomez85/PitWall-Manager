const db = require('../config/database');

class PoleSession {
  static findByRace(raceId) {
    return db.prepare('SELECT * FROM pole_sessions WHERE race_id = ?').get(raceId);
  }

  // Create the session in 'setup' state (lane not yet chosen, entries already populated)
  static create(raceId) {
    return db.prepare(
      'INSERT INTO pole_sessions (race_id) VALUES (?)'
    ).run(raceId).lastInsertRowid;
  }

  static addEntry({ poleSessionId, entityType, entityName, membersJson }) {
    return db.prepare(`
      INSERT INTO pole_entries (pole_session_id, entity_type, entity_name, members_json)
      VALUES (?, ?, ?, ?)
    `).run(poleSessionId, entityType, entityName, membersJson ?? null).lastInsertRowid;
  }

  // Persist an explicit order for the entries (array of IDs).
  // Ignora IDs ajenos a la sesión por seguridad.
  static setEntryOrder(sessionId, orderedIds) {
    const valid = new Set(
      db.prepare('SELECT id FROM pole_entries WHERE pole_session_id = ?')
        .all(sessionId).map(r => r.id)
    );
    const ids = (orderedIds || []).map(n => parseInt(n, 10)).filter(n => valid.has(n));
    if (ids.length === 0) return;
    const update = db.prepare('UPDATE pole_entries SET order_idx = ? WHERE id = ?');
    db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    })();
  }

  // Start pole: persists order if provided, sets lane, transitions to 'in_progress'.
  // Si no se proporciona order, se respeta el order_idx ya guardado.
  static startPole(sessionId, lane, orderedIds) {
    if (Array.isArray(orderedIds) && orderedIds.length > 0) {
      this.setEntryOrder(sessionId, orderedIds);
    }
    db.prepare(
      "UPDATE pole_sessions SET lane = ?, status = 'in_progress', current_idx = 0 WHERE id = ?"
    ).run(lane, sessionId);
  }

  // Get entries in random (shuffled) order
  static getEntriesOrdered(poleSessionId) {
    return db.prepare(`
      SELECT * FROM pole_entries
      WHERE pole_session_id = ?
      ORDER BY order_idx ASC, id ASC
    `).all(poleSessionId);
  }

  // Save the current participant's time and advance the index (or finish)
  static submitTime(sessionId, entryId, lapTimeMs) {
    const session = db.prepare('SELECT * FROM pole_sessions WHERE id = ?').get(sessionId);
    const total   = db.prepare('SELECT COUNT(*) AS n FROM pole_entries WHERE pole_session_id = ?').get(sessionId).n;

    db.prepare('UPDATE pole_entries SET lap_time_ms = ? WHERE id = ?').run(lapTimeMs ?? null, entryId);

    const nextIdx = session.current_idx + 1;
    if (nextIdx >= total) {
      db.prepare("UPDATE pole_sessions SET status = 'done', current_idx = ? WHERE id = ?").run(nextIdx, sessionId);
    } else {
      db.prepare('UPDATE pole_sessions SET current_idx = ? WHERE id = ?').run(nextIdx, sessionId);
    }
  }

  // Returns entries sorted by lap_time_ms ASC (null times at the end)
  static getEntriesSorted(poleSessionId) {
    return db.prepare(`
      SELECT * FROM pole_entries
      WHERE pole_session_id = ?
      ORDER BY CASE WHEN lap_time_ms IS NULL THEN 1 ELSE 0 END, lap_time_ms ASC
    `).all(poleSessionId);
  }

  static updateEntryTime(entryId, lapTimeMs) {
    db.prepare('UPDATE pole_entries SET lap_time_ms = ? WHERE id = ?').run(lapTimeMs, entryId);
  }

  static advanceIdx(sessionId, newIdx) {
    db.prepare('UPDATE pole_sessions SET current_idx = ? WHERE id = ?').run(newIdx, sessionId);
  }

  static finish(id) {
    db.prepare("UPDATE pole_sessions SET status = 'done' WHERE id = ?").run(id);
  }
}

module.exports = PoleSession;
