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

class Circuit {
  static findAll() {
    return db.prepare('SELECT * FROM circuits ORDER BY name ASC').all();
  }

  static findById(id) {
    return db.prepare('SELECT * FROM circuits WHERE id = ?').get(id);
  }

  static create({ name, circuits_count, circuits_config, lanes_count, min_lap_ms, description, lane_sequence, track_image_b64, track_outline_json, track_direction }) {
    const cfg = Array.isArray(circuits_config) ? JSON.stringify(circuits_config) : (circuits_config || '[]');
    const seq = Array.isArray(lane_sequence) ? JSON.stringify(lane_sequence) : (lane_sequence || '[]');
    const outline = Array.isArray(track_outline_json) ? JSON.stringify(track_outline_json) : (track_outline_json || '[]');
    const dir = (track_direction === 'ccw') ? 'ccw' : 'cw';
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO circuits (name, circuits_count, circuits_config, lanes_count, min_lap_ms, description, lane_sequence, track_image_b64, track_outline_json, track_direction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, circuits_count || 1, cfg, lanes_count || 6, min_lap_ms || 0, description || null, seq, track_image_b64 || null, outline, dir);
    return lastInsertRowid;
  }

  static update(id, { name, circuits_count, circuits_config, lanes_count, min_lap_ms, description, lane_sequence, track_image_b64, track_outline_json, track_direction }) {
    const cfg = Array.isArray(circuits_config) ? JSON.stringify(circuits_config) : (circuits_config || '[]');
    const seq = Array.isArray(lane_sequence) ? JSON.stringify(lane_sequence) : (lane_sequence || '[]');
    const outline = Array.isArray(track_outline_json) ? JSON.stringify(track_outline_json) : (track_outline_json || '[]');
    const dir = (track_direction === 'ccw') ? 'ccw' : 'cw';
    db.prepare(`
      UPDATE circuits SET name=?, circuits_count=?, circuits_config=?, lanes_count=?, min_lap_ms=?, description=?, lane_sequence=?, track_image_b64=?, track_outline_json=?, track_direction=?
      WHERE id=?
    `).run(name, circuits_count || 1, cfg, lanes_count || 6, min_lap_ms || 0, description || null, seq, track_image_b64 || null, outline, dir, id);
  }

  static getTrackOutline(circuit) {
    try {
      const o = JSON.parse(circuit.track_outline_json || '[]');
      return Array.isArray(o) ? o : [];
    } catch { return []; }
  }

  static getLaneSequence(circuit) {
    try {
      const s = JSON.parse(circuit.lane_sequence || '[]');
      return Array.isArray(s) ? s : [];
    } catch { return []; }
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
