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

// ── Contador de mutaciones ───────────────────────────────────────────────────
//
// El motor cachea agregados caros sobre `laps` (media y tiempo total de las
// mangas ANTERIORES: en una 24h son ~153.000 filas y cuestan 74 ms). Ese agregado
// no cambia mientras corre una manga, porque solo se insertan vueltas de la manga
// en curso. Pero una corrección sobre otra manga sí lo cambiaría, y confiar en
// que alguien recuerde invalidar la caché en cada punto de escritura es la forma
// más segura de que se pudra.
//
// Aquí se cuenta cada mutación, atribuida a su manga cuando se conoce.
// `mutationsOutside(mangaId)` dice cuántas han tocado CUALQUIER otra manga: si
// ese número no cambia, la caché de "mangas anteriores" sigue siendo válida.
// Una mutación de manga desconocida cuenta como "fuera" → invalida. Es el lado
// seguro por el que equivocarse.
let _mutTotal = 0;
const _mutByManga = new Map();

function _bump(mangaId) {
  _mutTotal++;
  if (mangaId != null) _mutByManga.set(mangaId, (_mutByManga.get(mangaId) || 0) + 1);
}

/** manga_id de una vuelta, por su id. Lookup por clave primaria: coste despreciable. */
function _mangaOf(lapId) {
  const row = db.prepare('SELECT manga_id FROM laps WHERE id = ?').get(lapId);
  return row ? row.manga_id : null;
}

// Caché de la corrección de salida por carrera, invalidada por el contador de
// mutaciones (ver startSettledByEntity). Acotada a unas pocas carreras: solo
// conviven la viva y alguna abierta en un móvil/Le Mans.
const _settledCache = new Map();   // raceId → { mut, map }
const _SETTLED_MAX = 8;

class Lap {
  /** Nº de mutaciones que han tocado alguna manga distinta de `mangaId`. */
  static mutationsOutside(mangaId) {
    return _mutTotal - (mangaId != null ? (_mutByManga.get(mangaId) || 0) : 0);
  }

  /** Total de mutaciones sobre `laps` en este proceso. */
  static get mutationCount() { return _mutTotal; }

  /**
   * Para los pocos sitios que escriben en `laps` con SQL crudo, saltándose el
   * modelo (reconstrucción de tanda). Invalida cualquier caché derivada.
   */
  static markExternalMutation() { _bump(null); }

  static create({ race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit = 0, is_ghost = 0, is_pit_stop = 0, is_warmup = 0, ghost_from_lane = null, is_estimated = 0 }) {
    _bump(manga_id);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, is_pit_stop, is_warmup, ghost_from_lane, is_estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(race_id, manga_id ?? null, team_id ?? null, driver_id ?? null,
           lane, lap_number, lap_time_ms, elapsed_ms ?? 0, is_exit, is_ghost, is_pit_stop, is_warmup, ghost_from_lane ?? null, is_estimated ? 1 : 0);
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
          AND manga_id IS NOT NULL
          AND lap_time_ms >= (SELECT minms FROM pt)
        GROUP BY lane
      )
      SELECT b.lane,
        b.bestLapMs,
        COALESCE(t.name, d.name) AS entityName,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entityType,
        tc.categoria AS entityCategoria
      FROM best_per_lane b
      JOIN laps l ON l.race_id = ? AND l.lane = b.lane AND l.lap_time_ms = b.bestLapMs
                 AND l.is_ghost = 0 AND l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      LEFT JOIN teams_catalog tc ON tc.name = t.name
      GROUP BY b.lane
    `).all(raceId, raceId, raceId);
  }

  // ── Agregado por entidad, partido en "mangas anteriores" + "manga en curso" ──
  //
  // `aggregateByRace` escanea las vueltas de TODA la carrera. En una 24 h son
  // 160.000 filas y cuesta ~101 ms, y la proyección lo llamaba en cada cruce.
  // Ese bloqueo síncrono no es solo lentitud: supera FRAME_GAP_MS (75 ms), así
  // que puede partir una trama del DS en dos y perder un cruce de verdad.
  //
  // La parte de las mangas ya cerradas (153.000 de esas 160.000 filas) NO cambia
  // mientras corre una manga. Se calcula una vez y se cachea; la manga en curso
  // (~7.000 filas) se agrega aparte y se funden en memoria.
  //
  // Devuelve EXACTAMENTE la misma forma y el mismo orden que `aggregateByRace`.
  // Hay un test que lo comprueba entidad a entidad sobre las 22 mangas reales de
  // la 24h de Modena.

  /**
   * Sumas crudas por entidad para un subconjunto de vueltas. Sin nombres ni orden.
   *
   * `pit_stops` viaja aquí y no en una consulta aparte porque el filtro que
   * necesita (race_id, is_ghost = 0, manga_id no nulo) es exactamente este: es una
   * columna más de un GROUP BY que ya recorre esas filas, así que sale gratis y
   * hereda el troceado y la caché. Contarlo por separado costaba un escaneo
   * completo de la carrera (35 ms sobre las 160.000 vueltas de una 24 h) por cada
   * equipo y cada refresco del cliente Lap.
   *
   * `INDEXED BY idx_laps_manga` en la rama de una sola manga no es un capricho:
   * el planificador elegía `idx_laps_race_flags` y escaneaba las 160.000 filas de
   * la carrera para filtrar 7.000 (26,9 ms). Por el índice de manga: 0,7 ms.
   */
  static _aggRaw(raceId, { excludeManga = null, onlyManga = null } = {}) {
    const columnas = `
        COALESCE(l.team_id, l.driver_id) AS entity_id,
        CASE WHEN l.team_id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type,
        COUNT(l.id) AS total_laps,
        MIN(CASE WHEN l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 THEN l.lap_time_ms END) AS best_lap_ms,
        SUM(CASE WHEN l.is_warmup = 0 THEN l.lap_time_ms ELSE 0 END) AS avg_sum,
        SUM(CASE WHEN l.is_warmup = 0 AND l.lap_time_ms IS NOT NULL THEN 1 ELSE 0 END) AS avg_cnt,
        SUM(l.lap_time_ms) AS total_time_ms,
        COUNT(DISTINCT l.manga_id) AS mangas_raced,
        SUM(l.is_exit) AS exit_count,
        SUM(l.is_pit_stop) AS pit_stops,
        MAX(CASE WHEN l.is_warmup = 0 AND l.lap_number > 0 THEN l.id END) AS last_lap_id`;

    if (onlyManga != null) {
      return db.prepare(`
        SELECT ${columnas}
        FROM laps l INDEXED BY idx_laps_manga
        WHERE l.manga_id = ? AND l.race_id = ? AND l.is_ghost = 0
        GROUP BY entity_id, entity_type
      `).all(onlyManga, raceId);
    }

    const filtro = excludeManga != null ? 'AND l.manga_id != ?' : '';
    const args = excludeManga != null ? [raceId, excludeManga] : [raceId];
    return db.prepare(`
      SELECT ${columnas}
      FROM laps l
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL ${filtro}
      GROUP BY entity_id, entity_type
    `).all(...args);
  }

  /** Nombre y color por entidad. Tablas pequeñas: coste despreciable. */
  static _entityMeta(raceId) {
    const meta = {};
    db.prepare('SELECT id, name, color FROM teams WHERE race_id = ?').all(raceId)
      .forEach(t => { meta['team:' + t.id] = { entity_name: t.name, color: t.color }; });
    db.prepare('SELECT id, name FROM drivers WHERE race_id = ?').all(raceId)
      .forEach(d => { meta['driver:' + d.id] = { entity_name: d.name, color: null }; });
    return meta;
  }

  /** Coma acumulada por entidad. Sale de manga_lanes, no de laps: no depende de las vueltas. */
  static _comaByEntity(raceId) {
    const out = {};
    db.prepare(`
      SELECT ml.team_id, ml.driver_id, SUM(ml.coma) AS coma
      FROM manga_lanes ml
      JOIN mangas mg ON mg.id = ml.manga_id
      WHERE mg.race_id = ? AND ml.is_rest = 0
      GROUP BY ml.team_id, ml.driver_id
    `).all(raceId).forEach(r => {
      const k = r.team_id != null ? 'team:' + r.team_id : 'driver:' + r.driver_id;
      out[k] = r.coma || 0;
    });
    return out;
  }

  /**
   * Coma de la ÚLTIMA manga que corrió cada entidad (la de mayor `manga_id` con
   * `is_rest = 0`). Es lo que desempata a igualdad de vueltas: quién iba más
   * adelantado en pista al caer la bandera de su último tramo. `manga_id` es
   * monótono con la creación, así que "el mayor" = el último tramo (también con
   * varias tandas). Si descansó la última manga, cuenta la última que sí corrió.
   */
  static _lastComaByEntity(raceId) {
    const out = {}, best = {};
    db.prepare(`
      SELECT ml.team_id, ml.driver_id, ml.manga_id AS mid, ml.coma
      FROM manga_lanes ml
      JOIN mangas mg ON mg.id = ml.manga_id
      WHERE mg.race_id = ? AND ml.is_rest = 0
    `).all(raceId).forEach(r => {
      const k = r.team_id != null ? 'team:' + r.team_id : 'driver:' + r.driver_id;
      if (best[k] == null || r.mid > best[k]) { best[k] = r.mid; out[k] = r.coma || 0; }
    });
    return out;
  }

  /**
   * Corrección de la vuelta de SALIDA para el TIEMPO TOTAL (solo el total, NUNCA
   * la media de carril / avg_lap_ms, que sigue clavando TicTac).
   *
   * En la 1ª manga de cada entidad, el cruce de salida (is_warmup) trae un tiempo
   * artefacto (rejilla→línea, arranque desde parado: ~1,2 s) que infravalora el
   * tiempo total ~11 s. Para el total y el desempate se sustituye por `settledAvg`:
   * media de las vueltas COMPLETAS (is_warmup=0, is_ghost=0 — INCLUYE salidas y
   * pit-stops) cuyo cruce cae en el primer 60 % de la duración de la manga. Es
   * determinista (sale de las vueltas y de la duración ya en disco) y restart-safe.
   *
   * Solo la 1ª manga de la entidad (la de menor manga_id con vueltas). Mangas 2+
   * sin cambios. Devuelve Map key `team:ID` | `driver:ID` →
   *   { firstMangaId, warmupMs, settledAvg, delta }  (delta = settledAvg − warmupMs).
   */
  static startSettledByEntity(raceId) {
    const mut = _mutTotal;
    const c = _settledCache.get(raceId);
    if (c && c.mut === mut) return c.map;

    const rows = db.prepare(`
      WITH firsts AS (
        SELECT COALESCE(l.team_id, l.driver_id) AS eid,
               CASE WHEN l.team_id IS NOT NULL THEN 'team' ELSE 'driver' END AS etype,
               MIN(l.manga_id) AS first_manga
        FROM laps l
        WHERE l.race_id = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
          AND (l.team_id IS NOT NULL OR l.driver_id IS NOT NULL)
        GROUP BY eid, etype
      )
      SELECT f.eid AS eid, f.etype AS etype, f.first_manga AS first_manga,
        (SELECT COALESCE(SUM(w.lap_time_ms), 0)
           FROM laps w
          WHERE w.manga_id = f.first_manga AND w.is_ghost = 0 AND w.is_warmup = 1
            AND COALESCE(w.team_id, w.driver_id) = f.eid) AS warmup_ms,
        (SELECT AVG(cp.lap_time_ms)
           FROM laps cp JOIN mangas m ON m.id = cp.manga_id
          WHERE cp.manga_id = f.first_manga AND cp.is_ghost = 0 AND cp.is_warmup = 0
            AND COALESCE(cp.team_id, cp.driver_id) = f.eid
            AND cp.elapsed_ms <= 0.6 * COALESCE(m.actual_duration_ms,
                  (SELECT manga_duration_minutes FROM races WHERE id = ?) * 60000)
        ) AS settled_avg
      FROM firsts f
    `).all(raceId, raceId);

    const map = new Map();
    for (const r of rows) {
      const delta = (r.settled_avg != null && r.warmup_ms > 0) ? (r.settled_avg - r.warmup_ms) : 0;
      map.set(`${r.etype}:${r.eid}`, {
        firstMangaId: r.first_manga, warmupMs: r.warmup_ms,
        settledAvg: r.settled_avg, delta,
      });
    }

    _settledCache.set(raceId, { mut, map });
    while (_settledCache.size > _SETTLED_MAX) _settledCache.delete(_settledCache.keys().next().value);
    return map;
  }

  /** Aplica la corrección de salida a total_time_ms sobre filas de forma pública. */
  static _applyStartSettled(raceId, rows) {
    const corr = Lap.startSettledByEntity(raceId);
    for (const r of rows) {
      const c = corr.get(r.entity_type + ':' + r.entity_id);
      if (c && c.delta) r.total_time_ms += c.delta;
    }
    return rows;
  }

  /** Funde varias sumas crudas de la misma entidad en una sola fila con la forma pública. */
  static _mergeAgg(raceId, partes) {
    const acc = {};
    for (const filas of partes) {
      for (const r of filas) {
        if (r.entity_id == null) continue;
        const k = r.entity_type + ':' + r.entity_id;
        const a = acc[k] || (acc[k] = {
          entity_id: r.entity_id, entity_type: r.entity_type,
          total_laps: 0, best_lap_ms: null, avg_sum: 0, avg_cnt: 0,
          total_time_ms: 0, mangas_raced: 0, exit_count: 0, pit_stops: 0,
          last_lap_id: null,
        });
        a.total_laps    += r.total_laps || 0;
        a.avg_sum       += r.avg_sum || 0;
        a.avg_cnt       += r.avg_cnt || 0;
        a.total_time_ms += r.total_time_ms || 0;
        a.mangas_raced  += r.mangas_raced || 0;   // los subconjuntos son disjuntos por manga
        a.exit_count    += r.exit_count || 0;
        a.pit_stops     += r.pit_stops || 0;
        if (r.best_lap_ms != null && (a.best_lap_ms == null || r.best_lap_ms < a.best_lap_ms)) {
          a.best_lap_ms = r.best_lap_ms;
        }
        // Ids monótonos: la última vuelta de la entidad es la del id mayor de
        // entre los subconjuntos (que son disjuntos por manga).
        if (r.last_lap_id != null && (a.last_lap_id == null || r.last_lap_id > a.last_lap_id)) {
          a.last_lap_id = r.last_lap_id;
        }
      }
    }

    const meta     = Lap._entityMeta(raceId);
    const coma     = Lap._comaByEntity(raceId);
    const lastComa = Lap._lastComaByEntity(raceId);
    const rows = Object.entries(acc).map(([k, a]) => ({
      entity_id:    a.entity_id,
      entity_name:  meta[k]?.entity_name ?? null,
      entity_type:  a.entity_type,
      color:        a.entity_type === 'team' ? (meta[k]?.color ?? null) : null,
      total_laps:   a.total_laps,
      best_lap_ms:  a.best_lap_ms,
      avg_lap_ms:   a.avg_cnt > 0 ? a.avg_sum / a.avg_cnt : null,
      total_time_ms: a.total_time_ms,
      mangas_raced: a.mangas_raced,
      exit_count:   a.exit_count,
      pit_stops:    a.pit_stops,
      last_lap_id:  a.last_lap_id,
      coma_total:      coma[k] || 0,       // suma (referencia)
      last_manga_coma: lastComa[k] || 0,   // desempate oficial
    }));

    // Corrección de la vuelta de salida sobre total_time_ms (1ª manga de cada
    // entidad). Se aplica ANTES de ordenar para que el desempate por tiempo use
    // el total corregido, idéntico al de aggregateByRace (comparado en tests).
    Lap._applyStartSettled(raceId, rows);

    // Desempate a igualdad de vueltas: la coma de la ÚLTIMA manga (quién iba más
    // adelantado en pista al final). El tiempo total queda como criterio posterior
    // por si empataran también en esa coma. DEBE coincidir con aggregateByRace.
    rows.sort((x, y) =>
      (y.total_laps - x.total_laps) ||
      ((y.last_manga_coma || 0) - (x.last_manga_coma || 0)) ||
      (x.total_time_ms - y.total_time_ms));
    return rows;
  }

  /**
   * Igual que `aggregateByRace`, pero reutilizando el agregado de las mangas
   * anteriores que le pasen ya calculado (y cacheado por el motor).
   * `priorRaw` = `Lap._aggRaw(raceId, { excludeManga: currentMangaId })`.
   */
  static aggregateByRaceSplit(raceId, currentMangaId, priorRaw) {
    const actual = Lap._aggRaw(raceId, { onlyManga: currentMangaId });
    return Lap._mergeAgg(raceId, [priorRaw, actual]);
  }

  // Aggregate results per entity (team or driver) across all mangas of a race
  static aggregateByRace(raceId) {
    // total_laps counts every recorded lap (including exits and pit-stops);
    // best_lap_ms still excludes exits so a crashed lap can't become "best",
    // y también la vuelta 1 (cruce de salida: en datos antiguos se guardó sin
    // is_warmup y un cruce a 3s del GO salía como mejor vuelta de la carrera).
    const rows = db.prepare(`
      SELECT
        COALESCE(t.id,   d.id)   AS entity_id,
        COALESCE(t.name, d.name) AS entity_name,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type,
        t.color,
        COUNT(l.id)                              AS total_laps,
        MIN(CASE WHEN l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 THEN l.lap_time_ms END) AS best_lap_ms,
        -- Media SIMPLE de tiempos de vuelta, SIN warmup (= media de TicTac,
        -- verificado al ms contra las tramas del DS-300 en RESISBARNA y Modena).
        -- Incluye salidas/pits (ritmo real). Es la que alimenta la proyección.
        AVG(CASE WHEN l.is_warmup = 0 THEN l.lap_time_ms END) AS avg_lap_ms,
        SUM(l.lap_time_ms)                       AS total_time_ms,
        COUNT(DISTINCT l.manga_id)               AS mangas_raced,
        SUM(l.is_exit)                           AS exit_count,
        SUM(l.is_pit_stop)                       AS pit_stops,
        -- Id de la última vuelta válida (el mayor id: son monótonos). Solo el id;
        -- su tiempo se busca por clave primaria cuando hace falta, que es gratis.
        MAX(CASE WHEN l.is_warmup = 0 AND l.lap_number > 0 THEN l.id END) AS last_lap_id,
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
        -- Coma de la ÚLTIMA manga que corrió (mayor manga_id, is_rest=0): el
        -- desempate oficial. Quién iba más adelantado en pista al final.
        COALESCE((
          SELECT ml.coma FROM manga_lanes ml
          WHERE ml.is_rest = 0
            AND ml.manga_id IN (SELECT id FROM mangas WHERE race_id = l.race_id)
            AND ((t.id IS NOT NULL AND ml.team_id = t.id)
              OR (t.id IS NULL    AND ml.driver_id = d.id))
          ORDER BY ml.manga_id DESC LIMIT 1
        ), 0) AS last_manga_coma
      FROM laps l
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
      GROUP BY entity_id, entity_type
      -- Desempate a igualdad de vueltas: la coma de la ÚLTIMA manga (quién iba más
      -- adelantado en pista al final). El tiempo total, criterio posterior.
      ORDER BY total_laps DESC,
               last_manga_coma DESC,
               total_time_ms ASC
    `).all(raceId);

    // Corrección de la vuelta de salida (1ª manga). Cambia total_time_ms, así que
    // hay que reordenar en JS con el MISMO comparador que _mergeAgg — el ORDER BY
    // de SQL ordenaba por el total crudo. Así ambas vías dan idéntico resultado.
    Lap._applyStartSettled(raceId, rows);
    rows.sort((x, y) =>
      (y.total_laps - x.total_laps) ||
      ((y.last_manga_coma || 0) - (x.last_manga_coma || 0)) ||
      (x.total_time_ms - y.total_time_ms));
    return rows;
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
        AVG(CASE WHEN l.is_warmup = 0
                  AND l.lap_time_ms >= (SELECT COALESCE(min_lap_ms, 0) FROM races WHERE id = ?)
                 THEN l.lap_time_ms END) AS avg_ms,
        MAX(CASE WHEN l.lap_number > 1 THEN l.lap_time_ms END) AS worst_ms,
        SUM(l.is_exit)     AS exit_count,
        SUM(CASE WHEN l.is_pit_stop = 1 THEN 1 ELSE 0 END) AS pit_stop_count,
        GROUP_CONCAT(CASE WHEN l.is_pit_stop = 1 THEN l.lap_number END) AS pit_stop_laps
      FROM laps l
      WHERE l.race_id = ? AND ${col} = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
      GROUP BY l.lane
      ORDER BY l.lane ASC
    `).all(raceId, raceId, raceId, entityId);
  }

  // Per-(lane, manga) breakdown for one entity — usado en la parrilla de
  // resultados cuando hay PASADAS o REPETIR-CARRIL (race.passes>1 ||
  // race.lane_repeat>1): una entidad corre el mismo carril en VARIAS mangas y
  // hay que verlas SEPARADAS. Idéntico a perLaneByEntity pero GROUP BY
  // (lane, manga_id), añadiendo manga_id y el number de la manga, ORDER BY
  // manga.number (así la k-ésima fila de un carril = ocurrencia k). Mismos
  // agregados y MISMOS filtros (warmup/exit/min_lap donde corresponde).
  static perLaneMangaByEntity(raceId, entityId, entityType) {
    const col = entityType === 'team' ? 'l.team_id' : 'l.driver_id';
    return db.prepare(`
      SELECT l.lane,
        l.manga_id        AS manga_id,
        m.number          AS manga_number,
        COUNT(l.id)        AS laps,
        MIN(CASE WHEN l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1
                  AND l.lap_time_ms >= (SELECT COALESCE(min_lap_ms, 0) FROM races WHERE id = ?)
                 THEN l.lap_time_ms END) AS best_ms,
        AVG(CASE WHEN l.is_warmup = 0
                  AND l.lap_time_ms >= (SELECT COALESCE(min_lap_ms, 0) FROM races WHERE id = ?)
                 THEN l.lap_time_ms END) AS avg_ms,
        MAX(CASE WHEN l.lap_number > 1 THEN l.lap_time_ms END) AS worst_ms,
        SUM(l.is_exit)     AS exit_count,
        SUM(CASE WHEN l.is_pit_stop = 1 THEN 1 ELSE 0 END) AS pit_stop_count,
        GROUP_CONCAT(CASE WHEN l.is_pit_stop = 1 THEN l.lap_number END) AS pit_stop_laps
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      WHERE l.race_id = ? AND ${col} = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
      GROUP BY l.lane, l.manga_id
      ORDER BY l.lane ASC, m.number ASC
    `).all(raceId, raceId, raceId, entityId);
  }

  // ── Ghost lap corrections ────────────────────────────────────────────────

  static deleteLap(id) {
    _bump(_mangaOf(id));
    db.prepare('DELETE FROM laps WHERE source_lap_id = ?').run(id); // remove transferred copies
    db.prepare('DELETE FROM laps WHERE id = ?').run(id);
  }

  static deleteByManga(mangaId) {
    _bump(mangaId);
    db.prepare('DELETE FROM laps WHERE manga_id = ?').run(mangaId);
  }

  // Editar manualmente el tiempo de una vuelta. Además de cambiar lap_time_ms,
  // desplaza el reloj (elapsed_ms) de esta vuelta y de todas las posteriores del
  // MISMO carril por la diferencia, para que la columna "@" siga siendo coherente
  // (el reloj es acumulativo). No toca los flags (exit/ghost/pit): es un override
  // manual del tiempo, no una reclasificación.
  static updateTime(id, newMs) {
    _bump(_mangaOf(id));
    newMs = Math.round(newMs);
    if (!newMs || newMs <= 0) return;
    const lap = db.prepare('SELECT id, manga_id, lane, lap_time_ms, elapsed_ms FROM laps WHERE id = ?').get(id);
    if (!lap) return;
    const delta = newMs - lap.lap_time_ms;
    const tx = db.transaction(() => {
      // Desplaza el reloj de esta vuelta y las siguientes del carril.
      db.prepare('UPDATE laps SET elapsed_ms = elapsed_ms + ? WHERE manga_id = ? AND lane = ? AND elapsed_ms >= ?')
        .run(delta, lap.manga_id, lap.lane, lap.elapsed_ms);
      // Al corregir el tiempo a mano deja de ser una estimación: el operador ha
      // puesto el valor real. Si siguiera marcada, el informe seguiría contándola
      // como repuesta y el recuento mentiría.
      db.prepare('UPDATE laps SET lap_time_ms = ?, is_estimated = 0 WHERE id = ?').run(newMs, id);
    });
    tx();
  }

  static markGhost(id) {
    _bump(_mangaOf(id));
    db.prepare('UPDATE laps SET is_ghost = 1 WHERE id = ?').run(id);
  }

  static restore(id) {
    _bump(_mangaOf(id));
    // Delete transferred copy if it exists, then restore original
    db.prepare('DELETE FROM laps WHERE source_lap_id = ?').run(id);
    db.prepare('UPDATE laps SET is_ghost = 0 WHERE id = ?').run(id);
  }

  // Mark original as ghost and create a transferred copy on the destination lane
  static transfer(lapId, toLane, mangaId, raceId) {
    _bump(mangaId);
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

    // La vuelta reasignada (cruce que el carril destino se saltó) cuenta para el
    // total, pero con tiempo = MEDIA ACTUAL del carril destino, NO el tiempo
    // corto del fantasma. Así no falsea nada: añadir un valor igual a la media
    // no la mueve, y la media nunca es la vuelta más rápida (no toca la mejor).
    const avgRow = db.prepare(`
      SELECT AVG(lap_time_ms) AS avg FROM laps
      WHERE manga_id = ? AND lane = ? AND is_ghost = 0 AND is_warmup = 0 AND lap_number > 0
    `).get(mangaId, toLane);
    const assignMs = (avgRow && avgRow.avg) ? Math.round(avgRow.avg) : original.lap_time_ms;

    db.prepare(`
      INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, source_lap_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      raceId, mangaId,
      laneAssign?.team_id ?? null, laneAssign?.driver_id ?? null,
      toLane, nextNum, assignMs, original.elapsed_ms, original.is_exit ?? 0,
      lapId
    );
  }

  // Add a manual lap to a lane (appended after last recorded lap)
  static addManual({ mangaId, raceId, lane, lapTimeMs }) {
    _bump(mangaId);
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
