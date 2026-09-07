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
// ════════════════════════════════════════════════════════════════════════════
//  AGREGADOS RACE-WIDE DE LIVE-STATS — cálculo PURO, sin estado.
//
//  Son la parte cara de `LiveStatsController.json`: tres consultas que recorren
//  TODAS las vueltas de la carrera (≈150.000 en una 24 h) más la consistencia
//  robusta en JS sobre esas vueltas. ~250 ms sobre Modena, y la vista se repide
//  en cada cruce. Dependen SOLO de `raceId` + `min_lap_ms` + las vueltas — NO de
//  la manga que se está mirando ni de la sesión viva. Extraído aquí para poder
//  ejecutarlo en el worker de stats (ver StatsWorkerClient / statsWorker).
//
//  Es el MISMO cálculo que estaba embebido en LiveStatsController.json; hay un
//  test de equivalencia (test/race-wide-stats-engine.test.js) y el controlador
//  cae a esta función en el hilo si el worker no está.
//
//    build(raceId, { db, minLapMs, consistency }) → {
//      raceByKey:          Map<key, {entity_name,total_laps,pace_all_ms,
//                                    pace_clean_ms,best_ms,exits,pits,mangas_raced}>
//      raceConsByKey:      Map<key, {pct,stdMs,level,meanMs,...}>  (ritmo puro)
//      raceConsAllByKey:   Map<key, {...}>                         (regularidad)
//      raceExitTimesByKey: Map<key, number[]>
//      raceProgress:       { mangas:number[], byName:{}, avgByName:{} }
//    }
// ════════════════════════════════════════════════════════════════════════════
'use strict';

function build(raceId, deps = {}) {
  const db = deps.db || require('../config/database');
  const { robustConsistency, MIN_CONSISTENCY_LAPS } =
    deps.consistency || require('../lib/consistency');
  // Numérico y saneado: se interpola en el SQL igual que hacía el controlador.
  const ml = Math.max(0, parseInt(deps.minLapMs, 10) || 0);

  // ── Total de vueltas de cada entidad en TODA la carrera y su pace medio ────
  const raceWide = db.prepare(`
    SELECT
      CASE WHEN l.team_id IS NOT NULL THEN 'team_' || l.team_id ELSE 'driver_' || l.driver_id END AS key,
      COALESCE(tm.name, dr.name) AS entity_name,
      SUM(CASE WHEN l.is_ghost = 0 THEN 1 ELSE 0 END) AS total_laps,
      -- Media SIMPLE sin warmup (= TicTac) para la predicción.
      AVG(CASE WHEN l.is_ghost = 0 AND l.is_warmup = 0 THEN l.lap_time_ms END) AS pace_all_ms,
      AVG(CASE WHEN l.is_ghost = 0 AND l.is_exit = 0 THEN l.lap_time_ms END) AS pace_clean_ms,
      MIN(CASE WHEN l.is_ghost = 0 AND l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 AND l.lap_time_ms >= ${ml} THEN l.lap_time_ms END) AS best_ms,
      SUM(CASE WHEN l.is_ghost = 0 AND l.is_exit = 1 AND l.is_pit_stop = 0 THEN 1 ELSE 0 END) AS exits,
      SUM(CASE WHEN l.is_ghost = 0 AND l.is_pit_stop = 1 THEN 1 ELSE 0 END) AS pits,
      COUNT(DISTINCT l.manga_id) AS mangas_raced
    FROM laps l
    JOIN mangas m ON m.id = l.manga_id
    JOIN tandas tn ON tn.id = m.tanda_id
    LEFT JOIN teams   tm ON tm.id = l.team_id
    LEFT JOIN drivers dr ON dr.id = l.driver_id
    WHERE tn.race_id = ?
    GROUP BY key
  `).all(raceId);
  const raceByKey = new Map();
  raceWide.forEach(r => raceByKey.set(r.key, r));

  // ── Consistencia race-wide ROBUSTA (CV filtrado sobre mediana/MAD, en JS) ──
  // Una sola query trae las vueltas elegibles CON su flag is_exit; en memoria se
  // parten en dos muestras por entidad: SIN salidas (ritmo puro, con filtro de
  // incidentes) y CON salidas (regularidad real del stint, sin filtro).
  const eligibleLapRows = db.prepare(`
    SELECT
      CASE WHEN l.team_id IS NOT NULL THEN 'team_' || l.team_id ELSE 'driver_' || l.driver_id END AS key,
      l.lap_time_ms AS t,
      l.is_exit AS is_exit
    FROM laps l
    JOIN mangas m ON m.id = l.manga_id
    JOIN tandas t ON t.id = m.tanda_id
    WHERE t.race_id = ?
      AND l.is_ghost = 0 AND l.is_warmup = 0
      AND l.lap_number > 1 AND l.lap_time_ms >= ${ml}
  `).all(raceId);
  const raceCleanByKey = new Map();      // SIN salidas/pits
  const raceAllByKey   = new Map();      // CON salidas/pits
  const raceExitTimesByKey = new Map();  // solo los tiempos de salidas/pits (perdido total)
  for (const r of eligibleLapRows) {
    let all = raceAllByKey.get(r.key);
    if (!all) { all = []; raceAllByKey.set(r.key, all); }
    all.push(r.t);
    if (!r.is_exit) {
      let cln = raceCleanByKey.get(r.key);
      if (!cln) { cln = []; raceCleanByKey.set(r.key, cln); }
      cln.push(r.t);
    } else {
      let ex = raceExitTimesByKey.get(r.key);
      if (!ex) { ex = []; raceExitTimesByKey.set(r.key, ex); }
      ex.push(r.t);
    }
  }
  const raceConsByKey    = new Map();  // SIN
  const raceConsAllByKey = new Map();  // CON
  for (const [key, times] of raceCleanByKey) {
    raceConsByKey.set(key, robustConsistency(times, MIN_CONSISTENCY_LAPS));
  }
  for (const [key, times] of raceAllByKey) {
    raceConsAllByKey.set(key, robustConsistency(times, MIN_CONSISTENCY_LAPS, { filterIncidents: false }));
  }

  // ── Progreso de carrera: vueltas acumuladas y media limpia manga a manga ───
  // Agrupado por NOMBRE (para soportar equipos duplicados por tanda). Lo usan
  // las gráficas de la pestaña Proyectada.
  const progressRows = db.prepare(`
    SELECT m.number AS manga, COALESCE(t.name, d.name) AS ename, COUNT(l.id) AS laps,
           AVG(CASE WHEN l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 THEN l.lap_time_ms END) AS avg_ms
    FROM laps l
    JOIN mangas m ON m.id = l.manga_id
    LEFT JOIN teams   t ON t.id = l.team_id
    LEFT JOIN drivers d ON d.id = l.driver_id
    WHERE l.race_id = ? AND l.is_ghost = 0
    GROUP BY m.number, ename
    ORDER BY m.number ASC
  `).all(raceId);
  const progMangas = [...new Set(progressRows.map(r => r.manga))].sort((a, b) => a - b);
  const lapsByNameManga = {}, avgByNameManga = {};
  progressRows.forEach(r => {
    (lapsByNameManga[r.ename] = lapsByNameManga[r.ename] || {})[r.manga] = r.laps;
    (avgByNameManga[r.ename]  = avgByNameManga[r.ename]  || {})[r.manga] = r.avg_ms;
  });
  const raceProgress = { mangas: progMangas, byName: {}, avgByName: {} };
  Object.keys(lapsByNameManga).forEach(name => {
    let cum = 0;
    raceProgress.byName[name]    = progMangas.map(mn => { cum += (lapsByNameManga[name][mn] || 0); return cum; });
    raceProgress.avgByName[name] = progMangas.map(mn => {
      const a = avgByNameManga[name][mn]; return a != null ? Math.round(a) : null;
    });
  });

  return { raceByKey, raceConsByKey, raceConsAllByKey, raceExitTimesByKey, raceProgress };
}

module.exports = { build };
