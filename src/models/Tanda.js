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

class Tanda {
  static findByRace(raceId) {
    return db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT mg.id)   AS manga_count,
        COUNT(DISTINCT CASE WHEN mg.status='finished' THEN mg.id END) AS mangas_finished,
        COUNT(DISTINCT te.id)   AS team_count,
        COUNT(DISTINCT d.id)    AS driver_count
      FROM tandas t
      LEFT JOIN mangas  mg ON mg.tanda_id = t.id
      LEFT JOIN teams   te ON te.tanda_id = t.id
      LEFT JOIN drivers d  ON d.tanda_id  = t.id
      WHERE t.race_id = ?
      GROUP BY t.id
      ORDER BY t.number ASC
    `).all(raceId);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM tandas WHERE id = ?').get(id);
  }

  static nextNumber(raceId) {
    const row = db.prepare('SELECT MAX(number) AS n FROM tandas WHERE race_id = ?').get(raceId);
    return (row?.n ?? 0) + 1;
  }

  // Sin modo, 'fixed': las tandas que no salen del formulario (importadas de
  // Control, pole, carrera simulada) conservan el reparto de siempre.
  static create(raceId, emptyLaneMode = 'fixed') {
    const number = Tanda.nextNumber(raceId);
    const mode = ['rotate', 'skip'].includes(emptyLaneMode) ? emptyLaneMode : 'fixed';
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO tandas (race_id, number, empty_lane_mode) VALUES (?, ?, ?)'
    ).run(raceId, number, mode);
    return lastInsertRowid;
  }

  static updateStatus(id, status) {
    db.prepare('UPDATE tandas SET status = ? WHERE id = ?').run(status, id);
  }

  static findNextPending(raceId, afterNumber) {
    return db.prepare(`
      SELECT t.* FROM tandas t
      WHERE t.race_id = ? AND t.number > ?
        AND EXISTS (SELECT 1 FROM mangas m WHERE m.tanda_id = t.id AND m.status = 'pending')
      ORDER BY t.number ASC LIMIT 1
    `).get(raceId, afterNumber);
  }

  // Última tanda con todas sus mangas cerradas (la del botón «Sectores»).
  static lastFinishedId(raceId) {
    const r = db.prepare(`
      SELECT t.id FROM tandas t
      WHERE t.race_id = ?
        AND EXISTS (SELECT 1 FROM mangas m WHERE m.tanda_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM mangas m WHERE m.tanda_id = t.id AND m.status != 'finished')
      ORDER BY t.number DESC LIMIT 1
    `).get(raceId);
    return r ? r.id : null;
  }

  // Pilotos, equipos y vueltas cuelgan de la tanda con ON DELETE SET NULL: sin
  // borrarlos a mano se quedaban sueltos en la carrera (y las vueltas, sin manga).
  static delete(id) {
    const borrar = db.transaction(() => {
      const { changes } = db.prepare('DELETE FROM laps WHERE manga_id IN (SELECT id FROM mangas WHERE tanda_id = ?)').run(id);
      db.prepare('DELETE FROM drivers WHERE tanda_id = ? OR team_id IN (SELECT id FROM teams WHERE tanda_id = ?)').run(id, id);
      db.prepare('DELETE FROM teams WHERE tanda_id = ?').run(id);
      db.prepare('DELETE FROM tandas WHERE id = ?').run(id);
      return changes;
    });
    if (borrar() > 0) require('./Lap').markExternalMutation();
  }
}

module.exports = Tanda;
