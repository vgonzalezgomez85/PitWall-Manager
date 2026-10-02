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
// LapTracking — rivales que sigue cada equipo desde Lap web, y sus números por
// carril (solo mangas terminadas).

const db  = require('../config/database');
const Lap = require('./Lap');

const MAX_TRACKED = 5;

// Caché por carrera. Solo cuentan mangas terminadas, así que los cruces de la
// manga viva no la invalidan: la clave es el conjunto de mangas terminadas +
// las mutaciones que han tocado alguna de ellas (correcciones) o externas.
const _laneCache = new Map();   // raceId → { key, byName }
const _CACHE_MAX = 8;

class LapTracking {
  static get MAX() { return MAX_TRACKED; }

  static listFor(raceId, teamName) {
    return db.prepare(
      'SELECT tracked_name FROM lap_tracking WHERE race_id = ? AND team_name = ? ORDER BY position'
    ).all(raceId, teamName).map(r => r.tracked_name);
  }

  /** Reemplaza la lista entera. Descarta el propio equipo, duplicados y nombres que no son de la carrera. */
  static setFor(raceId, teamName, names) {
    const valid = new Set(LapTracking.teamNames(raceId));
    const clean = [];
    for (const n of Array.isArray(names) ? names : []) {
      const s = String(n);
      if (s === teamName || !valid.has(s) || clean.includes(s)) continue;
      clean.push(s);
      if (clean.length === MAX_TRACKED) break;
    }
    const del = db.prepare('DELETE FROM lap_tracking WHERE race_id = ? AND team_name = ?');
    const ins = db.prepare('INSERT INTO lap_tracking (race_id, team_name, tracked_name, position) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      del.run(raceId, teamName);
      clean.forEach((n, i) => ins.run(raceId, teamName, n, i));
    })();
    return clean;
  }

  static teamNames(raceId) {
    return db.prepare('SELECT DISTINCT name FROM teams WHERE race_id = ? ORDER BY name').all(raceId).map(r => r.name);
  }

  /**
   * name → { color, laps, bestMs, avgAllMs, avgCleanMs, lanes: [{ lane, laps, bestMs, avgAllMs, avgCleanMs }] }
   * Mismos criterios que la matriz por carril de live-stats: vueltas = todas las
   * no fantasma; rápida sin warmup ni salidas; media sin warmup (con y sin salidas).
   */
  static laneStatsByName(raceId) {
    const finished = db.prepare("SELECT id FROM mangas WHERE race_id = ? AND status = 'finished' ORDER BY id")
      .all(raceId).map(r => r.id);
    const key = finished.join(',') + '|' + Lap.mutationsInvolving(finished);
    const c = _laneCache.get(raceId);
    if (c && c.key === key) return c.byName;

    const rows = db.prepare(`
      SELECT t.name AS name, MAX(t.color) AS color, l.lane,
        COUNT(*) AS laps,
        MIN(CASE WHEN l.is_exit=0 AND l.is_warmup=0 AND l.lap_number>1 THEN l.lap_time_ms END) AS bestMs,
        SUM(CASE WHEN l.is_warmup=0 THEN l.lap_time_ms END)                 AS sumAll,
        SUM(CASE WHEN l.is_warmup=0 THEN 1 ELSE 0 END)                      AS nAll,
        SUM(CASE WHEN l.is_warmup=0 AND l.is_exit=0 THEN l.lap_time_ms END) AS sumClean,
        SUM(CASE WHEN l.is_warmup=0 AND l.is_exit=0 THEN 1 ELSE 0 END)      AS nClean
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id AND m.status = 'finished'
      JOIN teams  t ON t.id = l.team_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lane > 0
      GROUP BY t.name, l.lane
      ORDER BY t.name, l.lane
    `).all(raceId);

    const avg = (s, n) => (n > 0 ? Math.round(s / n) : null);
    const acc = {};
    for (const r of rows) {
      const g = acc[r.name] || (acc[r.name] = {
        color: r.color, laps: 0, bestMs: null, _sA: 0, _nA: 0, _sC: 0, _nC: 0, lanes: [],
      });
      if (!g.color && r.color) g.color = r.color;
      g.laps += r.laps;
      if (r.bestMs != null && (g.bestMs == null || r.bestMs < g.bestMs)) g.bestMs = r.bestMs;
      g._sA += r.sumAll || 0;   g._nA += r.nAll || 0;
      g._sC += r.sumClean || 0; g._nC += r.nClean || 0;
      g.lanes.push({
        lane: r.lane, laps: r.laps, bestMs: r.bestMs,
        avgAllMs: avg(r.sumAll, r.nAll), avgCleanMs: avg(r.sumClean, r.nClean),
      });
    }
    const byName = {};
    for (const [name, g] of Object.entries(acc)) {
      byName[name] = {
        color: g.color, laps: g.laps, bestMs: g.bestMs,
        avgAllMs: avg(g._sA, g._nA), avgCleanMs: avg(g._sC, g._nC), lanes: g.lanes,
      };
    }

    _laneCache.delete(raceId);
    _laneCache.set(raceId, { key, byName });
    while (_laneCache.size > _CACHE_MAX) _laneCache.delete(_laneCache.keys().next().value);
    return byName;
  }

  static _resetCache() { _laneCache.clear(); }
}

module.exports = LapTracking;
