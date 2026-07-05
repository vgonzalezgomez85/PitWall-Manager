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
                  driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms, driver_max_runs,
                  passes, lane_repeat }) {
    const seq  = Array.isArray(lane_sequence) ? JSON.stringify(lane_sequence) : (lane_sequence || '[]');
    const circ = Array.isArray(circuits) ? JSON.stringify(circuits) : '[]';
    let raceKey = null;
    try { raceKey = require('crypto').randomUUID(); } catch { /* backfill lo cubre */ }
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO races (name, type, format, lanes_count, lane_sequence, manga_duration_minutes, circuits_config, has_pole, circuit_id, min_lap_ms,
                          driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms, driver_max_runs, passes, lane_repeat, race_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, format, lanes_count, seq, manga_duration_minutes || 5, circ, has_pole ? 1 : 0,
           circuit_id || null, min_lap_ms || 0,
           driver_min_total_ms || 0, driver_max_total_ms || 0,
           (driver_change_lockout_ms != null ? driver_change_lockout_ms : 120000),
           driver_max_runs || 0,
           Math.max(1, parseInt(passes, 10) || 1), Math.max(1, parseInt(lane_repeat, 10) || 1), raceKey);
    return lastInsertRowid;
  }

  // Partial update — only the provided fields are written. Used by the
  // "Editar carrera" page (name + circuit OR manual min lap).
  static update(id, { name, circuit_id, min_lap_ms, lanes_count, circuits_config, lane_sequence }) {
    const sets = [], vals = [];
    if (name            !== undefined) { sets.push('name=?');            vals.push(name); }
    if (circuit_id      !== undefined) { sets.push('circuit_id=?');      vals.push(circuit_id || null); }
    if (min_lap_ms      !== undefined) { sets.push('min_lap_ms=?');      vals.push(min_lap_ms || 0); }
    if (lanes_count     !== undefined) { sets.push('lanes_count=?');     vals.push(lanes_count); }
    if (circuits_config !== undefined) { sets.push('circuits_config=?'); vals.push(Array.isArray(circuits_config) ? JSON.stringify(circuits_config) : circuits_config); }
    if (lane_sequence   !== undefined) { sets.push('lane_sequence=?');   vals.push(Array.isArray(lane_sequence) ? JSON.stringify(lane_sequence) : lane_sequence); }
    if (!sets.length) return;
    vals.push(id);
    db.prepare(`UPDATE races SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  }

  // True if any lap has been recorded for this race. Gates destructive edits
  // (changing the circuit reshuffles lanes, so it's only allowed before racing).
  static hasRecordedLaps(id) {
    return !!db.prepare('SELECT 1 FROM laps WHERE race_id=? LIMIT 1').get(id);
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
