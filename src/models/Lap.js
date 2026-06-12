const db = require('../config/database');

class Lap {
  static create({ race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit = 0, is_ghost = 0, is_pit_stop = 0, is_warmup = 0, ghost_from_lane = null }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, is_pit_stop, is_warmup, ghost_from_lane)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(race_id, manga_id ?? null, team_id ?? null, driver_id ?? null,
           lane, lap_number, lap_time_ms, elapsed_ms ?? 0, is_exit, is_ghost, is_pit_stop, is_warmup, ghost_from_lane ?? null);
    return lastInsertRowid;
  }

  // Total valid laps for a driver or team across all mangas of a race EXCEPT the given manga
  static raceCountByEntity(raceId, excludeMangaId, teamId, driverId) {
    const col = teamId ? 'team_id' : 'driver_id';
    const id  = teamId || driverId;
    if (!id) return 0;
    // Count every recorded lap (exits and pit-stops are still laps, just
    // slow ones); only ghosts are excluded.
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM laps
       WHERE race_id = ? AND ${col} = ? AND manga_id != ? AND is_ghost = 0`
    ).get(raceId, id, excludeMangaId);
    return row?.n ?? 0;
  }

  // Used for live page state rebuild — excludes ghost laps
  static findByManga(mangaId) {
    return db.prepare(`
      SELECT l.*, d.name AS driver_name, t.name AS team_name
      FROM laps l
      LEFT JOIN drivers d ON d.id = l.driver_id
      LEFT JOIN teams   t ON t.id = l.team_id
      WHERE l.manga_id = ? AND l.is_ghost = 0
      ORDER BY l.elapsed_ms ASC
    `).all(mangaId);
  }

  // Used for corrections panel — includes ghost laps + transfer info
  static findByMangaAll(mangaId) {
    return db.prepare(`
      SELECT l.*,
        d.name  AS driver_name,  t.name  AS team_name,
        dest.lane AS transferred_to_lane,
        src.lane  AS transferred_from_lane
      FROM laps l
      LEFT JOIN drivers d    ON d.id   = l.driver_id
      LEFT JOIN teams   t    ON t.id   = l.team_id
      LEFT JOIN laps   dest  ON dest.source_lap_id = l.id
      LEFT JOIN laps   src   ON src.id = l.source_lap_id
      WHERE l.manga_id = ?
      ORDER BY l.lane ASC, l.elapsed_ms ASC
    `).all(mangaId);
  }

  static findByRace(raceId) {
    return db.prepare(`
      SELECT l.*, d.name AS driver_name, t.name AS team_name
      FROM laps l
      LEFT JOIN drivers d ON d.id = l.driver_id
      LEFT JOIN teams   t ON t.id = l.team_id
      WHERE l.race_id = ? AND l.is_ghost = 0
      ORDER BY l.elapsed_ms ASC
    `).all(raceId);
  }

  // Best valid lap per lane across the entire race, with team/driver attribution
  static raceBestByLane(raceId) {
    // CTE: primero calculamos la mejor vuelta por carril (O(N) con índice
    // idx_laps_race_lane), luego JOIN para recuperar el equipo/piloto
    // asociado a esa fila. La versión anterior usaba una subquery correlada
    // que escaneaba ~N²; medido 776ms con 4800 filas vs <1ms con esta.
    return db.prepare(`
      WITH pt AS (SELECT COALESCE(min_lap_ms, 0) AS minms FROM races WHERE id = ?),
      best_per_lane AS (
        SELECT lane, MIN(lap_time_ms) AS bestLapMs
        FROM laps
        -- lap_number > 1: la 1ª vuelta de cada manga (salida desde parado /
        -- primera referencia del DS) NO puede contar como vuelta rápida.
        -- lap_time_ms >= Pt: una vuelta MÁS RÁPIDA que el mínimo físico del
        -- circuito es un fantasma por definición — la descartamos aunque no
        -- esté marcada is_ghost (p.ej. el Pt se configuró después de correr).
        WHERE race_id = ? AND is_ghost = 0 AND is_exit = 0 AND is_warmup = 0 AND lap_number > 1
          AND lap_time_ms >= (SELECT minms FROM pt)
        GROUP BY lane
      )
      SELECT b.lane,
        b.bestLapMs,
        COALESCE(t.name, d.name) AS entityName,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entityType
      FROM best_per_lane b
      JOIN laps l ON l.race_id = ? AND l.lane = b.lane AND l.lap_time_ms = b.bestLapMs
                 AND l.is_ghost = 0 AND l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      GROUP BY b.lane
    `).all(raceId, raceId, raceId);
  }

  // Aggregate results per entity (team or driver) across all mangas of a race
  static aggregateByRace(raceId) {
    // total_laps counts every recorded lap (including exits and pit-stops);
    // best_lap_ms still excludes exits so a crashed lap can't become "best",
    // y también la vuelta 1 (cruce de salida: en datos antiguos se guardó sin
    // is_warmup y un cruce a 3s del GO salía como mejor vuelta de la carrera).
    return db.prepare(`
      SELECT
        COALESCE(t.id,   d.id)   AS entity_id,
        COALESCE(t.name, d.name) AS entity_name,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type,
        t.color,
        COUNT(l.id)                              AS total_laps,
        MIN(CASE WHEN l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 THEN l.lap_time_ms END) AS best_lap_ms,
        -- Media "sucia" (incluye salidas) pero SIN warmup: representa el
        -- ritmo real de carrera con sus mistakes incluidos. Es la métrica
        -- correcta para la proyección "vueltas al final de la carrera".
        AVG(CASE WHEN l.is_warmup = 0 THEN l.lap_time_ms END) AS avg_lap_ms,
        SUM(l.lap_time_ms)                       AS total_time_ms,
        COUNT(DISTINCT l.manga_id)               AS mangas_raced,
        SUM(l.is_exit)                           AS exit_count,
        -- Coma acumulada: fracción de vuelta en curso al caer la bandera de
        -- cada manga (estimada en stopManga). Desempate a igualdad de vueltas:
        -- más coma = llegó más lejos en las vueltas que no llegó a marcar.
        COALESCE((
          SELECT SUM(ml.coma) FROM manga_lanes ml
          JOIN mangas mg ON mg.id = ml.manga_id
          WHERE mg.race_id = l.race_id AND ml.is_rest = 0
            AND ((t.id IS NOT NULL AND ml.team_id = t.id)
              OR (t.id IS NULL    AND ml.driver_id = d.id))
        ), 0) AS coma_total,
        -- Tiempo de pista de la entidad: duración real de las mangas TERMINADAS
        -- en las que corrió (los descansos no aportan tiempo ni vueltas). Base
        -- de la media de proyección estilo TicTac: tiempo ÷ (vueltas + coma).
        COALESCE((
          SELECT SUM(COALESCE(mg2.actual_duration_ms,
                     (SELECT manga_duration_minutes * 60000 FROM races WHERE id = l.race_id)))
          FROM manga_lanes ml2
          JOIN mangas mg2 ON mg2.id = ml2.manga_id
          WHERE mg2.race_id = l.race_id AND mg2.status = 'finished' AND ml2.is_rest = 0
            AND ((t.id IS NOT NULL AND ml2.team_id = t.id)
              OR (t.id IS NULL    AND ml2.driver_id = d.id))
        ), 0) AS race_dur_ms
      FROM laps l
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.race_id = ? AND l.is_ghost = 0
      GROUP BY entity_id, entity_type
      ORDER BY total_laps DESC, coma_total DESC, total_time_ms ASC
    `).all(raceId);
  }

  // Per-lane breakdown for one entity across all mangas of a race
  static perLaneByEntity(raceId, entityId, entityType) {
    const col = entityType === 'team' ? 'l.team_id' : 'l.driver_id';
    return db.prepare(`
      SELECT l.lane,
        COUNT(l.id)        AS laps,
        -- VR del carril: ni ghost (WHERE), ni salida, ni warmup, ni 1ª vuelta,
        -- ni nada por debajo del Pt (fantasma no-marcado) — igual que el footer.
        MIN(CASE WHEN l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1
                  AND l.lap_time_ms >= (SELECT COALESCE(min_lap_ms, 0) FROM races WHERE id = ?)
                 THEN l.lap_time_ms END) AS best_ms,
        AVG(CASE WHEN l.lap_number > 1 THEN l.lap_time_ms END) AS avg_ms,
        MAX(CASE WHEN l.lap_number > 1 THEN l.lap_time_ms END) AS worst_ms,
        SUM(l.is_exit)     AS exit_count,
        SUM(CASE WHEN l.is_pit_stop = 1 THEN 1 ELSE 0 END) AS pit_stop_count,
        GROUP_CONCAT(CASE WHEN l.is_pit_stop = 1 THEN l.lap_number END) AS pit_stop_laps
      FROM laps l
      WHERE l.race_id = ? AND ${col} = ? AND l.is_ghost = 0
      GROUP BY l.lane
      ORDER BY l.lane ASC
    `).all(raceId, raceId, entityId);
  }

  // ── Ghost lap corrections ────────────────────────────────────────────────

  static deleteLap(id) {
    db.prepare('DELETE FROM laps WHERE source_lap_id = ?').run(id); // remove transferred copies
    db.prepare('DELETE FROM laps WHERE id = ?').run(id);
  }

  static deleteByManga(mangaId) {
    db.prepare('DELETE FROM laps WHERE manga_id = ?').run(mangaId);
  }

  static markGhost(id) {
    db.prepare('UPDATE laps SET is_ghost = 1 WHERE id = ?').run(id);
  }

  // Link a ghost lap to the real lap on another lane (auto-transfer linkage).
  // Sets realLap.source_lap_id = ghostLapId so findByMangaAll shows the
  // bidirectional "→ / ↔ de" relationship without creating a duplicate lap.
  static linkGhostToRealLap(ghostLapId, mangaId, realLane) {
    const realLap = db.prepare(
      'SELECT id FROM laps WHERE manga_id = ? AND lane = ? AND is_ghost = 0 ORDER BY elapsed_ms DESC LIMIT 1'
    ).get(mangaId, realLane);
    if (realLap) {
      db.prepare('UPDATE laps SET source_lap_id = ? WHERE id = ?').run(ghostLapId, realLap.id);
    }
  }

  static restore(id) {
    // Delete transferred copy if it exists, then restore original
    db.prepare('DELETE FROM laps WHERE source_lap_id = ?').run(id);
    db.prepare('UPDATE laps SET is_ghost = 0 WHERE id = ?').run(id);
  }

  // Mark original as ghost and create a transferred copy on the destination lane
  static transfer(lapId, toLane, mangaId, raceId) {
    const original = db.prepare('SELECT * FROM laps WHERE id = ?').get(lapId);
    if (!original) return;

    db.prepare('UPDATE laps SET is_ghost = 1 WHERE id = ?').run(lapId);

    const laneAssign = db.prepare(
      'SELECT team_id, driver_id FROM manga_lanes WHERE manga_id = ? AND lane = ?'
    ).get(mangaId, toLane);

    const maxRow = db.prepare(
      'SELECT MAX(lap_number) AS maxN FROM laps WHERE manga_id = ? AND lane = ? AND is_ghost = 0'
    ).get(mangaId, toLane);
    const nextNum = (maxRow?.maxN ?? 0) + 1;

    db.prepare(`
      INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, source_lap_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      raceId, mangaId,
      laneAssign?.team_id ?? null, laneAssign?.driver_id ?? null,
      toLane, nextNum, original.lap_time_ms, original.elapsed_ms, original.is_exit ?? 0,
      lapId
    );
  }

  // Add a manual lap to a lane (appended after last recorded lap)
  static addManual({ mangaId, raceId, lane, lapTimeMs }) {
    const laneAssign = db.prepare(
      'SELECT team_id, driver_id FROM manga_lanes WHERE manga_id = ? AND lane = ?'
    ).get(mangaId, lane);

    const maxRow = db.prepare(
      'SELECT MAX(lap_number) AS maxN FROM laps WHERE manga_id = ? AND lane = ? AND is_ghost = 0'
    ).get(mangaId, lane);
    const nextNum = (maxRow?.maxN ?? 0) + 1;

    const lastLap = db.prepare(
      'SELECT elapsed_ms FROM laps WHERE manga_id = ? AND lane = ? AND is_ghost = 0 ORDER BY elapsed_ms DESC LIMIT 1'
    ).get(mangaId, lane);
    const elapsedMs = (lastLap?.elapsed_ms ?? 0) + lapTimeMs;

    return Lap.create({
      race_id: raceId, manga_id: mangaId,
      team_id: laneAssign?.team_id ?? null,
      driver_id: laneAssign?.driver_id ?? null,
      lane, lap_number: nextNum,
      lap_time_ms: lapTimeMs, elapsed_ms: elapsedMs,
      is_exit: 0
    });
  }
}

module.exports = Lap;
