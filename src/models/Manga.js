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
        d.name  AS driver_name
      FROM manga_lanes ml
      LEFT JOIN teams   t ON t.id = ml.team_id
      LEFT JOIN drivers d ON d.id = ml.driver_id
      WHERE ml.manga_id = ?
      ORDER BY ml.lane ASC
    `).all(mangaId);
  }

  static updateStatus(id, status) {
    const now = new Date().toISOString();
    if (status === 'active')   db.prepare('UPDATE mangas SET status=?, started_at=?  WHERE id=?').run(status, now, id);
    else if (status === 'finished') db.prepare('UPDATE mangas SET status=?, finished_at=? WHERE id=?').run(status, now, id);
    else db.prepare('UPDATE mangas SET status=? WHERE id=?').run(status, id);
  }

  // ── Schedule generation ──────────────────────────────────────────────────
  // entities: [{id, type:'team'|'driver', name}]
  // laneSequence: [1,3,5,6,4,2]
  // Returns array of mangas, each manga = array of {lane, entity, isRest}
  static buildSchedule(laneSequence, entities) {
    const N = entities.length;
    if (N === 0 || laneSequence.length === 0) return [];

    const activeLanes  = laneSequence.filter(l => l > 0);
    const hasExplicit0 = laneSequence.includes(0);

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
    const totalMangas = seqLen;

    const schedule = [];
    for (let m = 0; m < totalMangas; m++) {
      const slots = entities.map((entity, i) => {
        const lane = extended[(i + m) % seqLen];
        return { lane, entity, isRest: lane === 0 };
      });
      schedule.push(slots);
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
        slots.forEach(({ lane, entity, isRest }) => {
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
