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

// Resultados de los entrenos competitivos (heats con rotación de carriles).
//
// team_id / driver_id quedan a NULL: en competición los participantes se teclean
// a mano y no hay carrera, así que no hay fila en `teams`/`drivers` (ambas están
// scopeadas por race_id) a la que apuntar. Se conserva `participant_name` como
// identidad del participante dentro de la sesión.
class CompetitionTrainingResult {

  // Guarda de una vez las filas de un heat terminado.
  // rows: [{ lane, participantName, bestLapMs, avgLapMs, lapCount }]
  static saveHeat(sessionId, heatNumber, rows) {
    if (!sessionId || !Array.isArray(rows) || rows.length === 0) return 0;
    const insert = db.prepare(`
      INSERT INTO competition_training_results
        (session_id, heat_number, lane, participant_name, best_lap_ms, avg_lap_ms, lap_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const r of rows) {
        insert.run(
          sessionId, heatNumber, r.lane, r.participantName,
          r.bestLapMs ?? null, r.avgLapMs ?? null, r.lapCount || 0
        );
      }
    })();
    return rows.length;
  }

  // Sesiones guardadas, la más reciente primero.
  static listSessions() {
    return db.prepare(`
      SELECT session_id                        AS session_id,
             COUNT(DISTINCT heat_number)       AS heats,
             COUNT(DISTINCT participant_name)  AS participants,
             SUM(lap_count)                    AS laps,
             MIN(best_lap_ms)                  AS best_lap_ms,
             MIN(created_at)                   AS started_at
      FROM competition_training_results
      GROUP BY session_id
      ORDER BY MIN(created_at) DESC
    `).all();
  }

  static getHeats(sessionId) {
    return db.prepare(`
      SELECT * FROM competition_training_results
      WHERE session_id = ?
      ORDER BY heat_number ASC, lane ASC
    `).all(sessionId);
  }

  // Clasificación de la sesión: gana quien más vueltas suma en todos sus heats;
  // a igualdad, la mejor vuelta.
  //
  // La media es la de TODAS las vueltas de la sesión, ponderada por las vueltas
  // de cada heat (no la media de las medias, que daría el mismo peso a un heat
  // de 3 vueltas que a uno de 40).
  static getStandings(sessionId) {
    return db.prepare(`
      SELECT participant_name                       AS participant_name,
             COUNT(*)                               AS heats,
             SUM(lap_count)                         AS laps,
             MIN(best_lap_ms)                       AS best_lap_ms,
             CASE WHEN SUM(lap_count) > 0
                  THEN CAST(ROUND(
                         SUM(COALESCE(avg_lap_ms, 0) * lap_count) * 1.0 / SUM(lap_count)
                       ) AS INTEGER)
                  ELSE NULL END                     AS avg_lap_ms
      FROM competition_training_results
      WHERE session_id = ?
      GROUP BY participant_name
      ORDER BY laps DESC, (best_lap_ms IS NULL) ASC, best_lap_ms ASC
    `).all(sessionId);
  }

  static deleteSession(sessionId) {
    return db.prepare('DELETE FROM competition_training_results WHERE session_id = ?')
      .run(sessionId).changes;
  }
}

module.exports = CompetitionTrainingResult;
