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

class DriverShift {
  // ── Lectura ──────────────────────────────────────────────────────────

  // Devuelve el shift abierto (sin ended_at_ms) de un carril en una manga.
  // Hay como máximo uno por carril.
  static findOpenByLane(mangaId, lane) {
    return db.prepare(`
      SELECT * FROM driver_shifts
      WHERE manga_id = ? AND lane = ? AND ended_at_ms IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(mangaId, lane);
  }

  // Todos los shifts abiertos de una manga (puede incluir pre-armed).
  static findAllOpenByManga(mangaId) {
    return db.prepare(`
      SELECT * FROM driver_shifts
      WHERE manga_id = ? AND ended_at_ms IS NULL
      ORDER BY lane ASC
    `).all(mangaId);
  }

  // Shifts pre-armados de una manga (started_at_ms IS NULL, pre_armed=1).
  // Se usan al arrancar la manga para "activarlos".
  static findPreArmedByManga(mangaId) {
    return db.prepare(`
      SELECT * FROM driver_shifts
      WHERE manga_id = ? AND pre_armed = 1 AND started_at_ms IS NULL
      ORDER BY lane ASC
    `).all(mangaId);
  }

  // Shift activo por carril en una manga (último checkin sea cual sea su estado).
  static currentByManga(mangaId) {
    return db.prepare(`
      SELECT ds.*
      FROM driver_shifts ds
      INNER JOIN (
        SELECT lane, MAX(id) AS max_id
        FROM driver_shifts WHERE manga_id = ?
        GROUP BY lane
      ) latest ON ds.id = latest.max_id
    `).all(mangaId);
  }

  // Histórico completo de shifts de una manga.
  static historyByManga(mangaId) {
    return db.prepare(`
      SELECT * FROM driver_shifts
      WHERE manga_id = ?
      ORDER BY lane ASC, id ASC
    `).all(mangaId);
  }

  // Total de driving_ms acumulado por un piloto en todas las mangas de
  // una carrera. Útil para validar contra driver_min/max_total_ms.
  static totalDrivingMsByDriverInRace(raceId, driverProfileId) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(driving_ms), 0) AS total
      FROM driver_shifts ds
      JOIN drivers d ON d.id = ds.driver_id
      JOIN teams_catalog_members tcm ON tcm.name = d.name
      WHERE ds.race_id = ? AND tcm.driver_id = ?
    `).get(raceId, driverProfileId);
    return row ? row.total : 0;
  }

  // Resumen por piloto del catálogo (driver_profile) en una carrera:
  // total_ms + lista de shifts.
  static raceSummary(raceId) {
    return db.prepare(`
      SELECT
        tcm.driver_id            AS profile_id,
        dp.name                  AS profile_name,
        dp.category              AS profile_category,
        SUM(ds.driving_ms)       AS total_ms,
        COUNT(*)                 AS shifts_count,
        SUM(CASE WHEN ds.started_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS runs_count
      FROM driver_shifts ds
      JOIN drivers d                 ON d.id = ds.driver_id
      JOIN teams_catalog_members tcm ON tcm.name = d.name
      JOIN driver_profiles dp        ON dp.id = tcm.driver_id
      WHERE ds.race_id = ?
      GROUP BY tcm.driver_id
      ORDER BY total_ms DESC
    `).all(raceId);
  }

  // ── Escritura ────────────────────────────────────────────────────────

  // Abre un nuevo shift (live durante manga running, o pre-armado en standby).
  // - Para shift live:    started_at_ms = nowMs, pre_armed = 0
  // - Para shift pre-armed: started_at_ms = null, pre_armed = 1
  static openShift({ mangaId, raceId, lane, teamId, driverId, driverName, startedAtMs, preArmed }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO driver_shifts
        (manga_id, race_id, lane, team_id, driver_id, driver_name, started_at_ms, pre_armed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mangaId, raceId, lane,
      teamId || null, driverId || null, driverName,
      preArmed ? null : (startedAtMs || Date.now()),
      preArmed ? 1 : 0
    );
    return lastInsertRowid;
  }

  // Corrección manual: crea un turno YA CERRADO con el tiempo indicado, porque
  // el equipo olvidó fichar. Cuenta como un turno (started_at_ms no nulo) y suma
  // su driving_ms al total del piloto en la carrera. manual=1 para auditarlo.
  static addManualTime({ mangaId, raceId, lane, teamId, driverId, driverName, drivingMs, atMs }) {
    const now = atMs || Date.now();
    const ms  = Math.max(0, Math.round(drivingMs || 0));
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO driver_shifts
        (manga_id, race_id, lane, team_id, driver_id, driver_name, started_at_ms, ended_at_ms, pre_armed, driving_ms, manual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)
    `).run(mangaId, raceId, lane, teamId || null, driverId || null, driverName, now - ms, now, ms);
    return lastInsertRowid;
  }

  // Cierra un shift: setea ended_at_ms y persiste el driving_ms final.
  static closeShift(id, endedAtMs, drivingMs) {
    db.prepare(`
      UPDATE driver_shifts
      SET ended_at_ms = ?, driving_ms = ?
      WHERE id = ?
    `).run(endedAtMs, drivingMs, id);
  }

  // Actualiza driving_ms de un shift abierto (persistencia periódica del tick).
  static updateDrivingMs(id, drivingMs) {
    db.prepare('UPDATE driver_shifts SET driving_ms = ? WHERE id = ?').run(drivingMs, id);
  }

  // Convierte los shifts pre-armados de una manga en activos:
  // started_at_ms = startTimeMs, pre_armed = 0.
  static activatePreArmedShifts(mangaId, startTimeMs) {
    db.prepare(`
      UPDATE driver_shifts
      SET started_at_ms = ?, pre_armed = 0
      WHERE manga_id = ? AND pre_armed = 1 AND started_at_ms IS NULL
    `).run(startTimeMs, mangaId);
  }

  // Cierra todos los shifts abiertos de una manga (al terminar/cancelar).
  // No actualiza driving_ms (lo respeta como esté en BD; el caller debe
  // haber persistido el valor en memoria justo antes).
  static closeAllOpenForManga(mangaId, endedAtMs) {
    db.prepare(`
      UPDATE driver_shifts
      SET ended_at_ms = ?
      WHERE manga_id = ? AND ended_at_ms IS NULL
    `).run(endedAtMs, mangaId);
  }

  // Borra todos los shifts de una manga (usado en cancelManga).
  static deleteByManga(mangaId) {
    db.prepare('DELETE FROM driver_shifts WHERE manga_id = ?').run(mangaId);
  }

  // ── Lookups auxiliares ──────────────────────────────────────────────

  static findProfileByQR(qrCode) {
    return db.prepare('SELECT * FROM driver_profiles WHERE qr_code = ?').get(qrCode);
  }

  // True si el equipo del piloto DESCANSA en esta manga (manga_lanes.is_rest=1).
  // Se usa para rechazar el fichaje con un motivo claro: un piloto de un equipo
  // que descansa no puede correr en ese momento.
  static isProfileTeamResting(profileId, mangaId) {
    const row = db.prepare(`
      SELECT 1
      FROM driver_profiles dp
      JOIN teams_catalog_members tcm ON tcm.driver_id = dp.id
      JOIN teams_catalog tc           ON tc.id = tcm.team_id
      JOIN teams t                    ON t.name = tc.name
      JOIN manga_lanes ml             ON ml.team_id = t.id AND ml.manga_id = ? AND ml.is_rest = 1
      WHERE dp.id = ? LIMIT 1
    `).get(mangaId, profileId);
    return !!row;
  }

  // Dado un perfil de piloto y una manga, devuelve la asignación
  // (carril + race driver). Si el piloto pertenece a varios equipos del
  // catálogo que coinciden con equipos de la manga, devuelve TODAS las
  // coincidencias para que el caller detecte ambigüedad.
  static findAssignmentsByProfile(profileId, mangaId) {
    return db.prepare(`
      SELECT d.id        AS driver_id,
             d.name      AS driver_name,
             d.team_id   AS team_id,
             ml.lane     AS lane
      FROM driver_profiles dp
      JOIN teams_catalog_members tcm ON tcm.driver_id = dp.id
      JOIN teams_catalog tc           ON tc.id = tcm.team_id
      JOIN teams t                    ON t.name = tc.name
      JOIN drivers d                  ON d.team_id = t.id AND d.name = dp.name
      JOIN manga_lanes ml             ON ml.team_id = t.id AND ml.manga_id = ? AND ml.is_rest = 0
      WHERE dp.id = ?
    `).all(mangaId, profileId);
  }
}

module.exports = DriverShift;
