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

class Manga {
  static findByTanda(tandaId) {
    return db.prepare(`
      SELECT m.*,
        COUNT(DISTINCT l.id) AS total_laps
      FROM mangas m
      LEFT JOIN laps l ON l.manga_id = m.id
      WHERE m.tanda_id = ?
      GROUP BY m.id
      ORDER BY m.number ASC
    `).all(tandaId);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM mangas WHERE id = ?').get(id);
  }

  // All lane assignments for one manga, with entity names
  static getLanes(mangaId) {
    return db.prepare(`
      SELECT ml.*,
        t.name  AS team_name,  t.color AS team_color,  t.country AS team_country,
        tc.categoria AS team_categoria,
        d.name  AS driver_name
      FROM manga_lanes ml
      LEFT JOIN teams   t ON t.id = ml.team_id
      LEFT JOIN teams_catalog tc ON tc.name = t.name
      LEFT JOIN drivers d ON d.id = ml.driver_id
      WHERE ml.manga_id = ?
      ORDER BY ml.lane ASC
    `).all(mangaId);
  }

  static updateStatus(id, status) {
    const now = new Date().toISOString();
    if (status === 'active')   db.prepare('UPDATE mangas SET status=?, started_at=?  WHERE id=?').run(status, now, id);
    else if (status === 'finished') db.prepare('UPDATE mangas SET status=?, finished_at=? WHERE id=?').run(status, now, id);
    // Volver a 'pending' (stop forzado, repetir manga) borra las marcas de tiempo:
    // una manga pendiente que conservaba su `started_at` la veía como ACTIVA la
    // proyección (`status != 'finished' AND started_at IS NOT NULL`) y a la vez la
    // excluía del conjunto de pendientes. La clasificación estimada quedaba mal en
    // toda la ventana entre el STOP y el nuevo GO.
    else if (status === 'pending') db.prepare('UPDATE mangas SET status=?, started_at=NULL, finished_at=NULL WHERE id=?').run(status, id);
    else db.prepare('UPDATE mangas SET status=? WHERE id=?').run(status, id);
  }

  // ── Schedule generation ──────────────────────────────────────────────────
  // entities: [{id, type:'team'|'driver', name}]
  // laneSequence: [1,3,5,6,4,2]
  // Returns array of mangas, each manga = array of {lane, entity, isRest}
  // `passes` (P, por defecto 1): nº de veces que se recorre la SECUENCIA entera.
  // `laneRepeat` (R, por defecto 1): cada paso de carril se corre R mangas
  //   SEGUIDAS (mismo carril); cada una a su tiempo normal y las vueltas se
  //   suman (por nombre) en la clasificación. Con DS-300 la caja cierra cada
  //   manga a su tiempo, así que "repetir carril" son R mangas contiguas, no
  //   una manga más larga.
  // Total de mangas = P × seqLen × R.
  //
  // `emptyLaneMode` decide qué pasa con los carriles libres cuando hay MENOS
  // entidades que carriles activos:
  //   'fixed'  → se usan solo los N primeros carriles activos; los de mayor
  //              número quedan siempre vacíos (comportamiento histórico).
  //   'rotate' → la rotación se rellena con HUECOS vacíos (entity null) para que
  //              el carril libre vaya cambiando de manga en manga y todos pasen
  //              por los mismos carriles. Los huecos ocupan sitio en la rotación
  //              pero persistSchedule NO los guarda (no crean fila en manga_lanes
  //              → ni vueltas ni clasificación fantasma).
  static buildSchedule(laneSequence, entities, passes = 1, laneRepeat = 1, emptyLaneMode = 'fixed') {
    const N0 = entities.length;
    if (N0 === 0 || laneSequence.length === 0) return [];
    const P = Math.max(1, parseInt(passes, 10) || 1);
    const R = Math.max(1, parseInt(laneRepeat, 10) || 1);

    const activeLanes  = laneSequence.filter(l => l > 0);
    const hasExplicit0 = laneSequence.includes(0);

    // Modo "rotate" con menos entidades que carriles: rellenamos la rotación con
    // huecos vacíos (null) hasta cubrir todos los carriles activos, de modo que
    // el/los hueco(s) roten por todos los carriles como una entidad más.
    let ents = entities;
    if (emptyLaneMode === 'rotate' && !hasExplicit0 && N0 < activeLanes.length) {
      ents = [...entities, ...Array(activeLanes.length - N0).fill(null)];
    }
    const N = ents.length;

    let extended;
    if (hasExplicit0 && N >= activeLanes.length) {
      // Sequence already has rest slots; extend with more 0s only if entities > seq length
      extended = N > laneSequence.length
        ? [...laneSequence, ...Array(N - laneSequence.length).fill(0)]
        : laneSequence;
    } else if (!hasExplicit0 && N > activeLanes.length) {
      // Auto-extend with rest slots when more entities than lanes
      extended = [...activeLanes, ...Array(N - activeLanes.length).fill(0)];
    } else {
      // Fewer entities than active lanes: use only the first N active lanes
      extended = activeLanes.slice(0, N);
    }

    const seqLen = extended.length;

    // P pasadas de la rotación completa; en cada pasada, cada paso de carril
    // se materializa como R mangas contiguas (repetir carril).
    const schedule = [];
    for (let p = 0; p < P; p++) {
      for (let s = 0; s < seqLen; s++) {
        const slots = ents.map((entity, i) => {
          const lane = extended[(i + s) % seqLen];
          // Un hueco vacío (entity null) que cae en un carril real no es un
          // descanso: es un carril que simplemente se queda sin coche esa manga.
          return { lane, entity, isRest: lane === 0, isEmpty: entity == null && lane !== 0 };
        });
        for (let rep = 0; rep < R; rep++) schedule.push(slots.map(x => ({ ...x })));
      }
    }
    return schedule;
  }

  // Persist a generated schedule into the DB for a tanda
  static persistSchedule(tandaId, raceId, schedule) {
    const insertManga = db.prepare(`
      INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)
    `);
    const insertLane = db.prepare(`
      INSERT INTO manga_lanes (manga_id, lane, team_id, driver_id, is_rest)
      VALUES (?, ?, ?, ?, ?)
    `);

    const mangaIds = [];
    db.transaction(() => {
      schedule.forEach((slots, idx) => {
        const { lastInsertRowid: mangaId } = insertManga.run(tandaId, raceId, idx + 1);
        mangaIds.push(mangaId);
        slots.forEach(({ lane, entity, isRest, isEmpty }) => {
          // Hueco vacío (carril libre que rota): no se persiste ninguna fila, así
          // el carril queda sin coche esa manga y no contamina ninguna agregación.
          if (isEmpty || !entity) return;
          const teamId   = entity.type === 'team'   ? entity.id : null;
          const driverId = entity.type === 'driver' ? entity.id : null;
          insertLane.run(mangaId, lane, teamId, driverId, isRest ? 1 : 0);
        });
      });
    })();

    return mangaIds;
  }

  // Swap lane assignments for a pending manga
  // assignments: [{ mlId, teamId, driverId }]
  static updateLaneAssignments(assignments) {
    const stmt = db.prepare('UPDATE manga_lanes SET team_id=?, driver_id=? WHERE id=?');
    db.transaction(() => {
      assignments.forEach(({ mlId, teamId, driverId }) => {
        stmt.run(teamId ?? null, driverId ?? null, mlId);
      });
    })();
  }

  // Next pending manga in a tanda
  static nextPending(tandaId) {
    return db.prepare(`
      SELECT * FROM mangas WHERE tanda_id = ? AND status = 'pending'
      ORDER BY number ASC LIMIT 1
    `).get(tandaId);
  }

  // Total scheduled (non-rest) mangas per entity across an entire race
  static scheduledCountByRace(raceId) {
    return db.prepare(`
      SELECT
        COALESCE(ml.team_id, ml.driver_id)                  AS entity_id,
        CASE WHEN ml.team_id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type,
        COUNT(*)                                             AS total_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      WHERE m.race_id = ? AND ml.is_rest = 0
      GROUP BY entity_id, entity_type
    `).all(raceId);
  }

  // Active manga (if any)
  static findActive(raceId) {
    return db.prepare(`
      SELECT m.* FROM mangas m
      WHERE m.race_id = ? AND m.status = 'active'
      LIMIT 1
    `).get(raceId);
  }

  static findFirstPending(raceId) {
    return db.prepare(`
      SELECT m.* FROM mangas m
      WHERE m.race_id = ? AND m.status = 'pending'
      ORDER BY m.id ASC LIMIT 1
    `).get(raceId);
  }
}

module.exports = Manga;
