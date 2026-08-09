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
//
// Control de neumáticos de una carrera de resistencia.
//
// La dotación de cada equipo es `races.tire_pairs_per_team` (igual para todos,
// se fija al crear la carrera). Cada entrega de un juego se registra como una
// fila en `tire_changes`. Los disponibles/usados NO se guardan: se DERIVAN del
// número de filas, así deshacer es borrar una fila y nunca hay descuadre.
//
// Una carrera con tandas tiene VARIAS filas en `teams` por equipo (una maestra
// + una por tanda). El control es por equipo real → se trabaja con el id
// CANÓNICO (el menor de las filas con el mismo nombre), igual que el cliente
// Lap. Todas las escrituras usan ese id canónico.
const db = require('../config/database');

// Contador de mutaciones: lo usa LiveStatsController para invalidar su caché
// de mangas ya finalizadas (indexada por Lap.mutationCount, que un cambio de
// neumático no toca) en cuanto se registra/edita/borra una entrega.
let _mutTotal = 0;

class TireChange {
  /** Total de mutaciones sobre `tire_changes` en este proceso. */
  static get mutationCount() { return _mutTotal; }
  // Equipos canónicos de la carrera (uno por nombre, el de menor id) con su
  // dotación, usados y disponibles. Ordenados por tanda/carril como el resto.
  static summaryByRace(raceId) {
    const race = db.prepare('SELECT tire_pairs_per_team FROM races WHERE id = ?').get(raceId);
    const allowance = race ? (race.tire_pairs_per_team || 0) : 0;

    const teams = db.prepare(`
      SELECT t.id, t.name, t.color, t.country
      FROM teams t
      WHERE t.race_id = ?
        AND t.id IN (SELECT MIN(id) FROM teams WHERE race_id = ? GROUP BY name)
      ORDER BY COALESCE(t.tanda_id, 0) ASC, t.lane ASC, t.id ASC
    `).all(raceId, raceId);

    const counts = db.prepare(`
      SELECT team_id, COUNT(*) AS used
      FROM tire_changes WHERE race_id = ?
      GROUP BY team_id
    `).all(raceId);
    const usedByTeam = {};
    counts.forEach(c => { usedByTeam[c.team_id] = c.used; });

    return {
      allowance,
      teams: teams.map(t => {
        const used = usedByTeam[t.id] || 0;
        return {
          id:        t.id,
          name:      t.name,
          color:     t.color,
          country:   t.country,
          used,
          available: allowance - used,   // puede ser negativo si se excede el cupo
        };
      }),
    };
  }

  // Historial de un equipo (canónico), más reciente primero.
  static historyByTeam(raceId, teamId) {
    return db.prepare(`
      SELECT id, manga_id, manga_number, race_elapsed_ms, created_at_ms, note
      FROM tire_changes
      WHERE race_id = ? AND team_id = ?
      ORDER BY created_at_ms DESC, id DESC
    `).all(raceId, teamId);
  }

  // Historial GLOBAL de la carrera, agrupado por manga. Cada cambio lleva el
  // nº de JUEGO del equipo (1, 2, 3…) según el orden cronológico en que se le
  // entregaron. Incluye las mangas de la carrera aunque no tengan cambios, para
  // ver el recorrido completo. Los cambios sin manga van a un grupo aparte.
  static fullHistoryByRace(raceId) {
    const race = db.prepare('SELECT tire_pairs_per_team FROM races WHERE id = ?').get(raceId);
    const allowance = race ? (race.tire_pairs_per_team || 0) : 0;

    const rows = db.prepare(`
      SELECT tc.id, tc.team_id, tc.manga_number, tc.race_elapsed_ms, tc.created_at_ms, tc.note,
             t.name AS team_name, t.color AS team_color
      FROM tire_changes tc
      LEFT JOIN teams t ON t.id = tc.team_id
      WHERE tc.race_id = ?
      ORDER BY tc.created_at_ms ASC, tc.id ASC
    `).all(raceId);

    // Nº de juego por equipo, en orden cronológico de entrega (1, 2, 3, …).
    const setByTeam = {};
    rows.forEach(r => {
      setByTeam[r.team_id] = (setByTeam[r.team_id] || 0) + 1;
      r.set_number = setByTeam[r.team_id];
    });

    // Mangas de la carrera (para listar también las que no tienen cambios).
    const byManga = new Map();
    db.prepare('SELECT DISTINCT number FROM mangas WHERE race_id = ? ORDER BY number ASC')
      .all(raceId).forEach(m => byManga.set(m.number, []));

    const orphan = [];
    rows.forEach(r => {
      if (r.manga_number == null) { orphan.push(r); return; }
      if (!byManga.has(r.manga_number)) byManga.set(r.manga_number, []);
      byManga.get(r.manga_number).push(r);
    });

    const groups = [...byManga.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([mangaNumber, changes]) => ({ mangaNumber, changes }));
    if (orphan.length) groups.push({ mangaNumber: null, changes: orphan });

    return { allowance, totalChanges: rows.length, groups };
  }

  static findById(id) {
    return db.prepare('SELECT * FROM tire_changes WHERE id = ?').get(id);
  }

  // El id canónico (menor) del equipo cuyo nombre coincide con el de `teamId`
  // dentro de la carrera. Sirve para normalizar cualquier fila de `teams` que
  // llegue por la URL a la fila canónica con la que se cuenta.
  static canonicalTeamId(raceId, teamId) {
    const row = db.prepare(`
      SELECT MIN(t2.id) AS canon
      FROM teams t1
      JOIN teams t2 ON t2.race_id = t1.race_id AND t2.name = t1.name
      WHERE t1.id = ? AND t1.race_id = ?
    `).get(teamId, raceId);
    return row ? row.canon : null;
  }

  // Registra una entrega. `createdAtMs` se pasa siempre (Date.now() del caller,
  // nunca dentro del modelo para no romper resúmenes deterministas en test).
  static add({ raceId, teamId, mangaId = null, mangaNumber = null, raceElapsedMs = null, note = null, createdAtMs }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tire_changes
        (race_id, team_id, manga_id, manga_number, race_elapsed_ms, created_at_ms, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      raceId, teamId,
      mangaId ?? null,
      mangaNumber ?? null,
      raceElapsedMs ?? null,
      createdAtMs,
      note ?? null
    );
    _mutTotal++;
    return lastInsertRowid;
  }

  // Edita un registro del historial (desde el lápiz). Solo campos de "cuándo".
  static update(id, { mangaId = null, mangaNumber = null, raceElapsedMs = null, note = null }) {
    db.prepare(`
      UPDATE tire_changes
      SET manga_id = ?, manga_number = ?, race_elapsed_ms = ?, note = ?
      WHERE id = ?
    `).run(mangaId ?? null, mangaNumber ?? null, raceElapsedMs ?? null, note ?? null, id);
    _mutTotal++;
  }

  static remove(id) {
    db.prepare('DELETE FROM tire_changes WHERE id = ?').run(id);
    _mutTotal++;
  }
}

module.exports = TireChange;
