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
      SELECT pe.*, tc.categoria AS categoria
      FROM pole_entries pe
      LEFT JOIN teams_catalog tc ON tc.name = pe.entity_name
      WHERE pe.pole_session_id = ?
      ORDER BY pe.order_idx ASC, pe.id ASC
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

  // Returns entries sorted by lap_time_ms ASC. Ausentes (is_noshow, 0.00
  // sintético) van DESPUÉS de todos los tiempos reales — si no, su 0 saldría
  // primero como si fuera la vuelta más rápida. Sin tiempo todavía (NULL,
  // no debería darse ya con sesión 'done') van al final de todo.
  static getEntriesSorted(poleSessionId) {
    return db.prepare(`
      SELECT pe.*, tc.categoria AS categoria
      FROM pole_entries pe
      LEFT JOIN teams_catalog tc ON tc.name = pe.entity_name
      WHERE pe.pole_session_id = ?
      ORDER BY
        CASE WHEN pe.lap_time_ms IS NULL THEN 2 WHEN pe.is_noshow = 1 THEN 1 ELSE 0 END,
        pe.lap_time_ms ASC
    `).all(poleSessionId);
  }

  static updateEntryTime(entryId, lapTimeMs) {
    db.prepare('UPDATE pole_entries SET lap_time_ms = ? WHERE id = ?').run(lapTimeMs, entryId);
  }

  // Manda la entrada al FINAL de la cola (mayor order_idx de la sesión + 1).
  // No hace falta reajustar el resto: como getEntriesOrdered ordena por
  // order_idx ASC, esto basta para que todas las pendientes se desplacen una
  // posición hacia delante en el array (current_idx no se toca, ver
  // PoleController.skipParticipant).
  static moveToEnd(sessionId, entryId) {
    const row = db.prepare('SELECT MAX(order_idx) AS m FROM pole_entries WHERE pole_session_id = ?').get(sessionId);
    const newIdx = (row && row.m != null ? row.m : 0) + 1;
    db.prepare('UPDATE pole_entries SET order_idx = ? WHERE id = ?').run(newIdx, entryId);
  }

  // Incrementa el contador de saltos de la entrada y devuelve el valor nuevo.
  static registerSkip(entryId) {
    db.prepare('UPDATE pole_entries SET skip_count = skip_count + 1 WHERE id = ?').run(entryId);
    return db.prepare('SELECT skip_count FROM pole_entries WHERE id = ?').get(entryId).skip_count;
  }

  // Marca la entrada como AUSENTE de verdad (tras su 2º salto): 0.00 fijo,
  // is_noshow=1 para que ningún ranking la confunda con una vuelta real de 0.
  static markNoShow(entryId) {
    db.prepare('UPDATE pole_entries SET lap_time_ms = 0, is_noshow = 1 WHERE id = ?').run(entryId);
  }

  static advanceIdx(sessionId, newIdx) {
    db.prepare('UPDATE pole_sessions SET current_idx = ? WHERE id = ?').run(newIdx, sessionId);
  }

  static finish(id) {
    db.prepare("UPDATE pole_sessions SET status = 'done' WHERE id = ?").run(id);
  }
}

module.exports = PoleSession;
