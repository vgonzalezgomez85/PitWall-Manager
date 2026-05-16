const db = require('../config/database');

class Lap {
  static create({ race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit = 0, is_ghost = 0, is_pit_stop = 0, ghost_from_lane = null }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, is_pit_stop, ghost_from_lane)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(race_id, manga_id ?? null, team_id ?? null, driver_id ?? null,
           lane, lap_number, lap_time_ms, elapsed_ms ?? 0, is_exit, is_ghost, is_pit_stop, ghost_from_lane ?? null);
    return lastInsertRowid;
  }

  // Total valid laps for a driver or team across all mangas of a race EXCEPT the given manga
  static raceCountByEntity(raceId, excludeMangaId, teamId, driverId) {
    const col = teamId ? 'team_id' : 'driver_id';
    const id  = teamId || driverId;
    if (!id) return 0;
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM laps
       WHERE race_id = ? AND ${col} = ? AND manga_id != ? AND is_ghost = 0 AND is_exit = 0`
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
    return db.prepare(`
      SELECT l.lane,
        l.lap_time_ms  AS bestLapMs,
        COALESCE(t.name, d.name) AS entityName,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entityType
      FROM laps l
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.is_exit = 0 AND l.lap_number > 0
        AND l.lap_time_ms = (
          SELECT MIN(l2.lap_time_ms) FROM laps l2
          WHERE l2.race_id = l.race_id AND l2.lane = l.lane
            AND l2.is_ghost = 0 AND l2.is_exit = 0 AND l2.lap_number > 0
        )
      GROUP BY l.lane
    `).all(raceId);
  }

  // Aggregate results per entity (team or driver) across all mangas of a race
  static aggregateByRace(raceId) {
    return db.prepare(`
      SELECT
        COALESCE(t.id,   d.id)   AS entity_id,
        COALESCE(t.name, d.name) AS entity_name,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type,
        t.color,
        COUNT(l.id)                              AS total_laps,
        MIN(CASE WHEN l.is_exit=0 THEN l.lap_time_ms END) AS best_lap_ms,
        AVG(CASE WHEN l.is_exit=0 THEN l.lap_time_ms END) AS avg_lap_ms,
        SUM(l.lap_time_ms)                       AS total_time_ms,
        COUNT(DISTINCT l.manga_id)               AS mangas_raced,
        SUM(l.is_exit)                           AS exit_count
      FROM laps l
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.race_id = ? AND l.is_ghost = 0
      GROUP BY entity_id, entity_type
      ORDER BY total_laps DESC, best_lap_ms ASC
    `).all(raceId);
  }

  // Per-lane breakdown for one entity across all mangas of a race
  static perLaneByEntity(raceId, entityId, entityType) {
    const col = entityType === 'team' ? 'l.team_id' : 'l.driver_id';
    return db.prepare(`
      SELECT l.lane,
        COUNT(l.id)        AS laps,
        MIN(CASE WHEN l.is_exit = 0 AND l.lap_number > 1 THEN l.lap_time_ms END) AS best_ms,
        AVG(CASE WHEN l.is_exit = 0 AND l.lap_number > 1 THEN l.lap_time_ms END) AS avg_ms,
        MAX(CASE WHEN l.lap_number > 1 THEN l.lap_time_ms END) AS worst_ms,
        SUM(l.is_exit)     AS exit_count,
        SUM(CASE WHEN l.is_pit_stop = 1 THEN 1 ELSE 0 END) AS pit_stop_count,
        GROUP_CONCAT(CASE WHEN l.is_pit_stop = 1 THEN l.lap_number END) AS pit_stop_laps
      FROM laps l
      WHERE l.race_id = ? AND ${col} = ? AND l.is_ghost = 0
      GROUP BY l.lane
      ORDER BY l.lane ASC
    `).all(raceId, entityId);
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
