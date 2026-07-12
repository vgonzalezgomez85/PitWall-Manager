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
// Estado de cada circuito (caja DS) durante una manga.
//
// Es lo ÚNICO del motor de cronometraje que no se podía reconstruir de la BD: de
// `laps` salen las vueltas, las medias, la mejor vuelta y el último cruce, pero
// no si una caja está corriendo o en pausa, ni su ancla de tiempo ya desplazada
// por las pausas, ni cuánto le queda.
//
// Sin esto, un reinicio a mitad de manga la dejaba muerta: solo se podía cancelar.

const db = require('../config/database');

class MangaCircuit {
  /** Guarda (o actualiza) el estado de un circuito. Idempotente por (manga, circuito). */
  static save(mangaId, circuitIndex, { status, startTime, endTime, pauseStart, durationMs, elapsedMs }) {
    db.prepare(`
      INSERT INTO manga_circuits
        (manga_id, circuit_index, status, start_time_ms, end_time_ms, pause_start_ms,
         duration_ms, elapsed_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(manga_id, circuit_index) DO UPDATE SET
        status         = excluded.status,
        start_time_ms  = excluded.start_time_ms,
        end_time_ms    = excluded.end_time_ms,
        pause_start_ms = excluded.pause_start_ms,
        duration_ms    = excluded.duration_ms,
        elapsed_ms     = excluded.elapsed_ms,
        updated_at_ms  = excluded.updated_at_ms
    `).run(
      mangaId, circuitIndex, status,
      startTime ?? null, endTime ?? null, pauseStart ?? null,
      durationMs || 0, Math.max(0, Math.round(elapsedMs || 0)), Date.now(),
    );
  }

  /** Guarda todos los circuitos de una manga en una transacción. */
  static saveAll(mangaId, circuits) {
    db.transaction(() => {
      for (const c of circuits) {
        MangaCircuit.save(mangaId, c.index, {
          status: c.status, startTime: c.startTime, endTime: c.endTime,
          pauseStart: c.pauseStart, durationMs: c.durationMs, elapsedMs: c.elapsedMs,
        });
      }
    })();
  }

  /** Estado guardado de los circuitos de una manga, ordenados por índice. */
  static findByManga(mangaId) {
    return db.prepare(`
      SELECT circuit_index AS circuitIndex, status,
             start_time_ms AS startTime, end_time_ms AS endTime,
             pause_start_ms AS pauseStart, duration_ms AS durationMs,
             elapsed_ms AS elapsedMs, updated_at_ms AS updatedAt
      FROM manga_circuits WHERE manga_id = ? ORDER BY circuit_index
    `).all(mangaId);
  }

  static deleteByManga(mangaId) {
    db.prepare('DELETE FROM manga_circuits WHERE manga_id = ?').run(mangaId);
  }

  /**
   * Cuánto tiempo lleva PitWall sin escribir el estado de esta manga.
   * Es la duración de la caída: el hueco entre el último latido a disco y ahora.
   */
  static outageMs(mangaId, now = Date.now()) {
    const row = db.prepare('SELECT MAX(updated_at_ms) AS t FROM manga_circuits WHERE manga_id = ?').get(mangaId);
    if (!row || !row.t) return null;
    return Math.max(0, now - row.t);
  }
}

module.exports = MangaCircuit;
