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
const Race          = require('../models/Race');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Lap           = require('../models/Lap');
const TireChange    = require('../models/TireChange');
const PoleSession   = require('../models/PoleSession');
const TimingService = require('../services/TimingService');
const db            = require('../config/database');
const {
  CONSISTENCY_LEVELS,
  consistencyLevel,
  MIN_CONSISTENCY_LAPS,
  robustConsistency,
} = require('../lib/consistency');

// ── Caché de la respuesta JSON ─────────────────────────────────────────────
//
// Esta vista cuesta ~200 ms sobre las 160.000 vueltas de una 24 h y devuelve
// 213 KB, y el cliente la repide en CADA cruce. Sin caché, cada espectador con la
// página abierta costaba ~500 ms de CPU por segundo: dos pantallas puestas y el
// proceso —un hilo, better-sqlite3 síncrono— se queda sin aire, retrasando el
// tick y el procesado del serie.
//
// La respuesta depende SOLO de (carrera, manga): el `entity` y el `usePaceClean`
// que manda el cliente no se leen aquí — la comparativa se calcula en el
// navegador a partir de `entities`. Así que una sola copia sirve a todos.
//
// La invalidación NO puede ser por mutación como en el cliente Lap: allí rehacer
// el paquete cuesta 3 ms y se puede permitir hacerlo en cada cruce; aquí cuesta
// 200 ms, así que hacerlo en cada cruce sería exactamente el problema que se
// viene a resolver. Con la manga viva manda el reloj (1 s de retraso no lo ve
// nadie: el cliente ya lleva su propio contador). Con la manga acabada no entra
// ninguna vuelta, así que solo la puede cambiar una corrección — y de eso sí
// avisa el contador de mutaciones, sin caducar nunca por tiempo.
const JSON_TTL_MS   = 1000;
const JSON_MAX_KEYS = 8;
const _jsonCache = new Map();   // `${raceId}:${mangaId}` → { ts, mut, payload }

// ── Helpers ────────────────────────────────────────────────────────────────

// Sectorización en N bins iguales sobre la duración de la manga. Por defecto 3
// bins (inicio / mitad / final). Si la manga es muy corta los bins pequeños
// pueden quedar vacíos — la UI lo muestra como "—".
const SECTOR_BINS = 3;

// Las funciones de consistencia (CONSISTENCY_LEVELS, consistencyLevel, median,
// filterIncidentLaps, MIN_CONSISTENCY_LAPS, robustConsistency) viven ahora en
// ../lib/consistency y se importan arriba. Comportamiento IDÉNTICO.

function buildEntityStats({ laps, mangaDurationMs, minLapMs = 0 }) {
  // laps = array de filas para UN piloto/equipo en una manga, ordenadas por
  // elapsed_ms ASC. Cada fila { lap_time_ms, elapsed_ms, is_exit, is_pit_stop }.
  const racing = laps.filter(l => !l.is_ghost);  // ghosts no cuentan en nada
  const clean  = racing.filter(l => !l.is_exit); // sin exits ni pit-stops
  // Bases de RITMO para MEDIAS: excluyen el calentamiento (is_warmup) — que
  // incluye el primer cruce parcial (~0.5s) y la vuelta de warm-up — y también
  // las vueltas SUB-MÍNIMO (cruces fantasma imposibles < min_lap_ms). Sin esto
  // la media se hunde por debajo de las vueltas reales (y del "mejor", que ya
  // exige >=min). Mantienen las salidas/pits (pace = con incidentes;
  // paceClean = sin exits).
  const pace      = racing.filter(l => !l.is_warmup && (minLapMs <= 0 || l.lap_time_ms >= minLapMs));
  const paceClean = pace.filter(l => !l.is_exit);
  // Vueltas válidas para "mejor vuelta": ni salida, ni primer cruce (warmup /
  // lap_number <= 1), ni por debajo del tiempo mínimo de carrera (Pt).
  const bestEligible = racing.filter(l =>
    !l.is_exit && !l.is_warmup && l.lap_number > 1 && (minLapMs <= 0 || l.lap_time_ms >= minLapMs));
  // Muestra "CON salidas y pit-stops": misma base pero INCLUYE is_exit (salidas
  // y pits). Es la regularidad real del stint; el CV se calcula SIN filtrar
  // incidentes (los sucesos no marcados cuentan).
  const allEligible = racing.filter(l =>
    !l.is_warmup && l.lap_number > 1 && (minLapMs <= 0 || l.lap_time_ms >= minLapMs));
  const exits  = racing.filter(l => !!l.is_exit);

  const sum   = a => a.reduce((s, l) => s + l.lap_time_ms, 0);
  const min   = a => a.length ? Math.min(...a.map(l => l.lap_time_ms)) : null;
  const avg   = a => a.length ? Math.round(sum(a) / a.length) : null;

  const bestMs       = min(bestEligible);
  const avgAll       = avg(pace);       // media de ritmo (sin warmup, con exits)
  const avgClean     = avg(paceClean);  // media limpia (sin warmup ni exits)
  const deltaAll     = (bestMs != null && avgAll   != null) ? avgAll   - bestMs : null;
  const deltaClean   = (bestMs != null && avgClean != null) ? avgClean - bestMs : null;

  // Tiempo perdido en salidas/pit-stops = Σ (lap_time − avg_clean) por cada
  // exit. Si no hay avg_clean (todas las vueltas son exits) usa 0.
  const reference = avgClean ?? avgAll ?? 0;
  let lostMs = 0;
  for (const l of exits) {
    const over = l.lap_time_ms - reference;
    if (over > 0) lostMs += over;
  }
  const lostLapsEquiv = reference > 0 ? +(lostMs / reference).toFixed(2) : 0;

  // Sectorización: divide la duración en SECTOR_BINS y agrupa por bin de
  // elapsed_ms. Calcula avg en cada bin (con y sin exits) para ver evolución.
  const binMs = mangaDurationMs > 0 ? mangaDurationMs / SECTOR_BINS : 0;
  const sectorsAll   = Array.from({ length: SECTOR_BINS }, () => []);
  const sectorsClean = Array.from({ length: SECTOR_BINS }, () => []);
  if (binMs > 0) {
    for (const l of pace) {  // sin warmup: las medias por tramo cuadran con avgAll/avgClean
      const raw = Math.floor(l.elapsed_ms / binMs);
      const idx = Number.isFinite(raw) ? Math.min(SECTOR_BINS - 1, Math.max(0, raw)) : 0;
      sectorsAll[idx].push(l);
      if (!l.is_exit) sectorsClean[idx].push(l);
    }
  }
  const sectorAvg = (arr) => arr.length ? Math.round(sum(arr) / arr.length) : null;
  const sectors = sectorsAll.map((bin, i) => ({
    label:    `Tramo ${i + 1}`,
    avgAll:   sectorAvg(bin),
    avgClean: sectorAvg(sectorsClean[i]),
    laps:     bin.length,
    exits:    bin.filter(l => l.is_exit).length,
  }));

  // Última vuelta cronometrada (las filas vienen ordenadas por elapsed_ms ASC).
  const lastLapMs = racing.length ? racing[racing.length - 1].lap_time_ms : null;

  // % de consistencia (coincide con TicTac): CV clásico con DE MUESTRAL (n−1)
  // sobre las vueltas elegibles, PERO filtrando antes los incidentes (vueltas
  // sueltas a >150% del ritmo / >3.5σ robusto) para que una salida no marcada
  // no hunda la métrica. Mínimo 5 vueltas tras filtrar; si no, null.
  const cons = robustConsistency(bestEligible.map(l => l.lap_time_ms), MIN_CONSISTENCY_LAPS);
  const consistency      = cons ? cons.pct   : null;
  const consistencyStdMs = cons ? cons.stdMs : null;
  const consistencyLevelName = cons ? cons.level : null;
  const consistencyMeanMs = cons ? cons.meanMs : null;

  // Variante CON salidas/pits: incluye is_exit y NO filtra incidentes → mide la
  // regularidad total del stint (paradas incluidas). Sale más baja que la SIN.
  const consAll = robustConsistency(allEligible.map(l => l.lap_time_ms), MIN_CONSISTENCY_LAPS, { filterIncidents: false });
  const consistencyAll      = consAll ? consAll.pct    : null;
  const consistencyAllStdMs = consAll ? consAll.stdMs  : null;
  const consistencyAllLevelName = consAll ? consAll.level : null;
  const consistencyAllMeanMs = consAll ? consAll.meanMs : null;

  return {
    totalLaps:   racing.length,
    cleanLaps:   clean.length,
    exitCount:   exits.filter(l => !l.is_pit_stop).length,
    pitStopCount: exits.filter(l => l.is_pit_stop).length,
    bestMs,
    avgAll, avgClean,
    deltaAll, deltaClean,
    lastLapMs,
    lostMs, lostLapsEquiv,
    consistency,
    consistencyStdMs,
    consistencyLevel: consistencyLevelName,
    consistencyMeanMs,
    consistencyAll,
    consistencyAllStdMs,
    consistencyAllLevel: consistencyAllLevelName,
    consistencyAllMeanMs,
    sectors,
  };
}

class LiveStatsController {

  // GET /race-stats — landing de la vista EN VIVO. Muestra las carreras ACTIVAS
  // (status='active') para que el piloto/equipo elija cuál seguir. Normalmente
  // habrá una sola: en ese caso se entra directo. Si hay varias (p.ej. activas
  // en paralelo) se muestra el selector para no adivinar la equivocada. La
  // vista de carreras FINALIZADAS se implementará aparte.
  static index(req, res) {
    const lang = req.session?.lang || 'es';
    const activeRaces = Race.findAll().filter(r => r.status === 'active');

    // Carreras con la POLE en curso: la carrera en sí aún no está "active"
    // (eso arranca con la primera manga, después de la pole), pero un
    // invitado también quiere poder seguirla en directo.
    const poleRaces = Race.findAll()
      .filter(r => r.has_pole && r.status !== 'active' && r.status !== 'finished')
      .filter(r => {
        const s = PoleSession.findByRace(r.id);
        return s && s.status === 'in_progress';
      });

    if (activeRaces.length === 1 && poleRaces.length === 0) return res.redirect(`/races/${activeRaces[0].id}/live-stats`);
    if (poleRaces.length === 1 && activeRaces.length === 0) return res.redirect(`/races/${poleRaces[0].id}/pole/timing`);

    res.render('live-stats/index', {
      t: req.t, lang, races: activeRaces, poleRaces,
      noLive: activeRaces.length === 0 && poleRaces.length === 0,
    });
  }

  // Todo lo que necesita "Comparativa por carril" (la cuadrícula por defecto Y
  // la comparación con filtros): entidades, matriz por carril, vueltas totales
  // y tramos por manga. Recorre TODA la carrera (no solo la manga activa) —
  // es caro en una 24h, así que NO va en el JSON de refresco por vuelta; el
  // cliente solo lo vuelve a pedir cuando termina una manga (ver lanes()).
  static _buildLaneGridData(race) {
    // Lista de entidades disponibles (de TODA la carrera, para que el piloto
    // se encuentre aunque ahora esté descansando en esta manga). La categoría
    // sale del catálogo de equipos del club (`teams_catalog`), que no está
    // enlazado por id — se empareja por NOMBRE, igual que en /races/:id/lemans.
    const entityRows = db.prepare(`
      SELECT DISTINCT
        COALESCE(t.id, d.id)   AS entity_id,
        COALESCE(t.name, d.name) AS entity_name,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type,
        tc.categoria AS categoria
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas tn ON tn.id = m.tanda_id
      LEFT JOIN teams   t ON t.id = ml.team_id
      LEFT JOIN drivers d ON d.id = ml.driver_id
      LEFT JOIN teams_catalog tc ON tc.name = t.name
      WHERE tn.race_id = ? AND ml.is_rest = 0
      ORDER BY entity_name COLLATE NOCASE ASC
    `).all(race.id);

    // ── Matriz por carril ────────────────────────────────────────────────
    // Stats de cada entidad EN cada carril a lo largo de TODA la carrera, para
    // la comparativa por carril. clave (`tipo_id`) → carril → { stats }.
    // best = excluye salidas/warmup/1ª vuelta (igual que raceBestByLane).
    // avgAll = media sucia (con salidas, sin warmup); avgClean = sin salidas.
    // exits/pits: mismo criterio que raceWide en el JSON (is_pit_stop aparte
    // de is_exit, no es un subconjunto).
    const laneStatRows = db.prepare(`
      SELECT
        CASE WHEN l.team_id IS NOT NULL THEN 'team_'||l.team_id ELSE 'driver_'||l.driver_id END AS key,
        l.lane,
        COUNT(*) AS laps,
        MIN(CASE WHEN l.is_exit=0 AND l.is_warmup=0 AND l.lap_number>1 THEN l.lap_time_ms END) AS bestMs,
        AVG(CASE WHEN l.is_warmup=0 THEN l.lap_time_ms END)                    AS avgAllMs,
        AVG(CASE WHEN l.is_warmup=0 AND l.is_exit=0 THEN l.lap_time_ms END)    AS avgCleanMs,
        SUM(CASE WHEN l.is_exit=1 AND l.is_pit_stop=0 THEN 1 ELSE 0 END)       AS exits,
        SUM(CASE WHEN l.is_pit_stop=1 THEN 1 ELSE 0 END)                      AS pits
      FROM laps l
      WHERE l.race_id = ? AND l.is_ghost = 0 AND (l.team_id IS NOT NULL OR l.driver_id IS NOT NULL)
      GROUP BY key, l.lane
    `).all(race.id);
    const laneMatrix = {};
    const laneSet = new Set();
    laneStatRows.forEach(r => {
      if (r.lane == null || r.lane <= 0) return;
      laneSet.add(r.lane);
      (laneMatrix[r.key] = laneMatrix[r.key] || {})[r.lane] = {
        laps: r.laps, bestMs: r.bestMs, avgAllMs: r.avgAllMs, avgCleanMs: r.avgCleanMs,
        exits: r.exits || 0, pits: r.pits || 0,
      };
    });
    const lanesList = [...laneSet].sort((a, b) => a - b);

    // Vueltas totales de cada entidad en TODA la carrera (todos los carriles).
    const totalLapsRows = db.prepare(`
      SELECT CASE WHEN l.team_id IS NOT NULL THEN 'team_'||l.team_id ELSE 'driver_'||l.driver_id END AS key,
             COUNT(*) AS total_laps
      FROM laps l
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
        AND (l.team_id IS NOT NULL OR l.driver_id IS NOT NULL)
      GROUP BY key
    `).all(race.id);
    const totalLapsByKey = {};
    totalLapsRows.forEach(r => { totalLapsByKey[r.key] = r.total_laps; });

    // ── Tramos (runs) por entidad×carril ────────────────────────────────
    // Un bloque por MANGA, siempre — aunque el carril se repita en mangas
    // consecutivas (`lane_repeat`), cada manga se pinta separada con sus
    // propios datos (M1 no se mezcla con M2). No hay fusión: es la fila
    // per-manga tal cual sale de la query.
    const perMangaRows = db.prepare(`
      SELECT
        CASE WHEN l.team_id IS NOT NULL THEN 'team_'||l.team_id ELSE 'driver_'||l.driver_id END AS key,
        l.lane, m.number AS manga_number,
        COUNT(*) AS laps,
        MIN(CASE WHEN l.is_exit=0 AND l.is_warmup=0 AND l.lap_number>1 THEN l.lap_time_ms END) AS bestMs,
        SUM(CASE WHEN l.is_warmup=0 THEN l.lap_time_ms ELSE 0 END)                  AS sumAll,
        SUM(CASE WHEN l.is_warmup=0 THEN 1 ELSE 0 END)                             AS cntAll,
        SUM(CASE WHEN l.is_warmup=0 AND l.is_exit=0 THEN l.lap_time_ms ELSE 0 END) AS sumClean,
        SUM(CASE WHEN l.is_warmup=0 AND l.is_exit=0 THEN 1 ELSE 0 END)             AS cntClean,
        SUM(CASE WHEN l.is_exit=1 AND l.is_pit_stop=0 THEN 1 ELSE 0 END)           AS exits,
        SUM(CASE WHEN l.is_pit_stop=1 THEN 1 ELSE 0 END)                          AS pits
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND (l.team_id IS NOT NULL OR l.driver_id IS NOT NULL)
      GROUP BY key, l.lane, m.number
      ORDER BY m.number ASC
    `).all(race.id);
    const laneDriverRows = db.prepare(`
      SELECT DISTINCT 'team_'||l.team_id AS key, l.lane, m.number AS manga_number, d.name AS driver_name
      FROM laps l
      JOIN drivers d ON d.id = l.driver_id
      JOIN mangas m ON m.id = l.manga_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.team_id IS NOT NULL
    `).all(race.id);
    const driversByKeyLaneManga = {}; // key → lane → manga_number → [driver_name, …]
    laneDriverRows.forEach(r => {
      if (r.lane == null || r.lane <= 0) return;
      const byLane  = (driversByKeyLaneManga[r.key] = driversByKeyLaneManga[r.key] || {});
      const byManga = (byLane[r.lane] = byLane[r.lane] || {});
      (byManga[r.manga_number] = byManga[r.manga_number] || []).push(r.driver_name);
    });

    const laneRuns = {}; // key → lane → [ { mangas:[n], drivers:[…], laps, bestMs, avgAllMs, avgCleanMs, exits, pits }, … ]
    perMangaRows.forEach(r => {
      if (r.lane == null || r.lane <= 0) return;
      const byLane = (laneRuns[r.key] = laneRuns[r.key] || {});
      const runs   = (byLane[r.lane] = byLane[r.lane] || []);
      runs.push({
        mangas: [r.manga_number],
        drivers: [...(((driversByKeyLaneManga[r.key] || {})[r.lane] || {})[r.manga_number] || [])],
        laps: r.laps, bestMs: r.bestMs,
        avgAllMs:   r.cntAll   > 0 ? r.sumAll   / r.cntAll   : null,
        avgCleanMs: r.cntClean > 0 ? r.sumClean / r.cntClean : null,
        exits: r.exits || 0, pits: r.pits || 0,
      });
    });

    return { entityRows, laneMatrix, lanesList, totalLapsByKey, laneRuns };
  }

  // GET /races/:id/live-stats?mangaId=N&entity=team_5
  static show(req, res) {
    const lang = req.session?.lang || 'es';
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const tandas = Tanda.findByRace(race.id);
    const allMangas = tandas.flatMap(t => Manga.findByTanda(t.id).map(m => ({
      id: m.id, number: m.number, status: m.status,
      tandaId: t.id, tandaNumber: t.number,
    })));

    // Manga seleccionada: query param > activa > última con vueltas > primera
    let selectedMangaId = parseInt(req.query.mangaId, 10);
    if (!selectedMangaId) {
      const active = allMangas.find(m => m.status === 'active');
      selectedMangaId = active?.id || allMangas.find(m => m.status === 'finished')?.id
                        || allMangas[0]?.id || null;
    }

    const laneGrid = LiveStatsController._buildLaneGridData(race);

    res.render('live-stats/show', {
      t: req.t, lang, race, tandas, allMangas,
      selectedMangaId,
      isActive: TimingService.activeMangaId === selectedMangaId,
      ...laneGrid,
    });
  }

  // GET /races/:id/live-stats/lanes.json
  // Mismos datos que `show` usa para "Comparativa por carril", pero servidos
  // aparte para que el cliente los pueda refrescar SIN recargar la página —
  // solo al terminar una manga (ver comentario en _buildLaneGridData: es una
  // consulta cara sobre TODA la carrera, no apta para cada vuelta).
  static lanes(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });
    res.json(LiveStatsController._buildLaneGridData(race));
  }

  // GET /races/:id/live-stats.json?mangaId=N&entity=team_5
  // Devuelve los datos calculados — usado tanto en la render inicial como
  // en los refrescos del socket.
  static json(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });

    const mangaId = parseInt(req.query.mangaId, 10);
    if (!mangaId) return res.status(400).json({ error: 'mangaId_required' });

    const manga = Manga.findById(mangaId);
    if (!manga || manga.race_id !== race.id) return res.status(404).json({ error: 'manga_not_found' });

    // Duración de la sesión: in-memory si está activa, valor de race si no.
    const isActive = TimingService.activeMangaId === manga.id;

    const cacheKey = `${race.id}:${manga.id}`;
    const cached   = _jsonCache.get(cacheKey);
    // cached.isActive tiene que coincidir con el isActive de AHORA: si no,
    // la caché es de antes/después de un GO (p.ej. finished→pending→active
    // al re-lanzar una manga) y el TTL de 1 s la daría por buena aunque el
    // payload todavía diga "finished" — justo el salto que importa enseñar.
    if (cached && cached.isActive === isActive && (isActive
          ? (Date.now() - cached.ts) < JSON_TTL_MS
          : cached.mut === Lap.mutationCount && cached.tireMut === TireChange.mutationCount)) {
      return res.json(cached.payload);
    }

    const session  = isActive ? TimingService.session : null;
    const mangaDurationMs = session?.durationMs
                          ?? (race.manga_duration_minutes * 60 * 1000);

    // ── Cambios de neumático (solo resistencia con control activado) ───────
    // Se cruza por NOMBRE de equipo, igual que el indicador 🛞 del directo
    // (refreshTireIndicators en live.js): "Manga actual" usa el conteo de
    // ESTA manga, "Proyectada" el TOTAL de carrera (ver raceWideOf más abajo).
    const hasTireControl = race.type === 'championship' && (race.tire_pairs_per_team || 0) > 0;
    const tireByNameManga = {};   // `${name}::${mangaNumber}` -> count
    const tireByNameTotal = {};   // name -> count total
    if (hasTireControl) {
      db.prepare(`
        SELECT t.name AS team_name, tc.manga_number, COUNT(*) AS n
        FROM tire_changes tc
        JOIN teams t ON t.id = tc.team_id
        WHERE tc.race_id = ?
        GROUP BY t.name, tc.manga_number
      `).all(race.id).forEach(r => {
        tireByNameTotal[r.team_name] = (tireByNameTotal[r.team_name] || 0) + r.n;
        if (r.manga_number != null) tireByNameManga[`${r.team_name}::${r.manga_number}`] = r.n;
      });
    }

    // Cargar todas las vueltas de la manga con flags.
    const laps = db.prepare(`
      SELECT l.team_id, l.driver_id, l.lane, l.lap_number,
             l.lap_time_ms, l.elapsed_ms, l.is_exit, l.is_pit_stop, l.is_ghost, l.is_warmup,
             COALESCE(t.name, d.name) AS entity_name,
             CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type
      FROM laps l
      LEFT JOIN teams   t ON t.id = l.team_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.manga_id = ? AND l.is_ghost = 0
      ORDER BY l.elapsed_ms ASC
    `).all(manga.id);

    // Agrupar por entidad
    const byEntity = new Map();
    for (const l of laps) {
      const key = `${l.entity_type}_${l[l.entity_type + '_id']}`;
      if (!byEntity.has(key)) {
        byEntity.set(key, {
          key,
          entityType: l.entity_type,
          entityName: l.entity_name,
          lane: l.lane,
          laps: [],
        });
      }
      byEntity.get(key).laps.push(l);
    }

    // Calcular stats por entidad
    const entities = [...byEntity.values()].map(e => ({
      key:        e.key,
      entityName: e.entityName,
      lane:       e.lane,
      ...buildEntityStats({ laps: e.laps, mangaDurationMs, minLapMs: race.min_lap_ms || 0 }),
      // Serie vuelta a vuelta (de la manga) para la gráfica de la comparativa.
      // n = nº de vuelta, t = tiempo (ms), x = salida/pit (1) para marcarla.
      lapSeries:  e.laps.map(l => ({ n: l.lap_number, t: l.lap_time_ms, x: l.is_exit ? 1 : 0 })),
    }));

    // Quien DESCANSA esta manga no tiene vueltas → no sale en `laps`, así que
    // sin esto desaparecía sin más de "Manga actual" en vez de indicar que le
    // toca descanso. Se añade con stats a 0 y isResting=true.
    const restRows = db.prepare(`
      SELECT ml.team_id, ml.driver_id, COALESCE(t.name, d.name) AS entity_name,
             CASE WHEN ml.team_id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type
      FROM manga_lanes ml
      LEFT JOIN teams   t ON t.id = ml.team_id
      LEFT JOIN drivers d ON d.id = ml.driver_id
      WHERE ml.manga_id = ? AND ml.is_rest = 1 AND (ml.team_id IS NOT NULL OR ml.driver_id IS NOT NULL)
    `).all(manga.id);
    restRows.forEach(r => {
      const key = `${r.entity_type}_${r.entity_type === 'team' ? r.team_id : r.driver_id}`;
      if (byEntity.has(key)) return;   // ya tiene vueltas (no debería pasar si descansa)
      entities.push({
        key, entityName: r.entity_name, lane: null,
        ...buildEntityStats({ laps: [], mangaDurationMs, minLapMs: race.min_lap_ms || 0 }),
        lapSeries: [],
        isResting: true,
      });
    });

    // Cambios de neumático de ESTA manga (0 si la carrera no lleva control).
    entities.forEach(e => {
      e.tireChangesManga = hasTireControl ? (tireByNameManga[`${e.entityName}::${manga.number}`] || 0) : 0;
    });

    // Clasificación por total laps (desc), luego best (asc). Quien descansa
    // (0 vueltas, sin mejor) cae naturalmente al final por este mismo orden.
    entities.sort((a, b) => b.totalLaps - a.totalLaps
                         || (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity));
    entities.forEach((e, i) => { e.position = i + 1; });

    // Tiempo transcurrido y restante
    const elapsedMs = session ? Date.now() - session.startTime : null;
    const remainingMs = isActive && elapsedMs != null
      ? Math.max(0, mangaDurationMs - elapsedMs) : null;

    // ── Datos race-wide para predicción ─────────────────────────────────────
    // Total de vueltas de cada entidad en TODA la carrera, y su pace medio.
    const raceWide = db.prepare(`
      SELECT
        CASE WHEN l.team_id IS NOT NULL THEN 'team_' || l.team_id ELSE 'driver_' || l.driver_id END AS key,
        COALESCE(tm.name, dr.name) AS entity_name,
        SUM(CASE WHEN l.is_ghost = 0 THEN 1 ELSE 0 END) AS total_laps,
        -- Media SIMPLE sin warmup (= TicTac) para la predicción.
        AVG(CASE WHEN l.is_ghost = 0 AND l.is_warmup = 0 THEN l.lap_time_ms END) AS pace_all_ms,
        AVG(CASE WHEN l.is_ghost = 0 AND l.is_exit = 0 THEN l.lap_time_ms END) AS pace_clean_ms,
        MIN(CASE WHEN l.is_ghost = 0 AND l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 AND l.lap_time_ms >= ${race.min_lap_ms || 0} THEN l.lap_time_ms END) AS best_ms,
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
    `).all(race.id);
    const raceByKey = new Map();
    raceWide.forEach(r => raceByKey.set(r.key, r));

    // Consistencia race-wide ROBUSTA: el CV clásico necesita mediana/MAD, que no
    // se obtienen de sum/sumsq en SQL. Traemos las vueltas limpias elegibles de
    // TODA la carrera por entidad (mismo filtro que el pace) y calculamos el CV
    // filtrado en JS, igual que en manga. Una sola query agrupada; agregamos las
    // vueltas por key en memoria (24h ≈ 150k filas: es un render de página, no
    // tiempo real). Mínimo 5 vueltas tras filtrar (en carrera siempre hay).
    // Una sola query trae las vueltas elegibles CON su flag is_exit (racing,
    // !warmup, lap>1, ≥minLap, incluyendo salidas/pits). En memoria se parte en
    // dos muestras por entidad: SIN (is_exit=0 + filtro incidentes → ritmo puro)
    // y CON (todas, incluye is_exit, sin filtro → regularidad real del stint).
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
        AND l.lap_number > 1 AND l.lap_time_ms >= ${race.min_lap_ms || 0}
    `).all(race.id);
    const raceCleanByKey = new Map();  // SIN salidas/pits
    const raceAllByKey   = new Map();  // CON salidas/pits
    const raceExitTimesByKey = new Map();  // solo los tiempos de las salidas/pits (para el perdido total)
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

    // Mangas restantes en la carrera (pending) y duración media (para proyectar futuro).
    const remainingMangas = db.prepare(`
      SELECT COUNT(*) AS n FROM mangas m
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND m.status = 'pending'
    `).get(race.id).n;
    // Stats race-wide de UNA key (team_X / driver_Y) — se usa tanto para
    // enriquecer `entities` (solo quienes corren ESTA manga) como para
    // `raceWideByKey`, que cubre a TODOS los participantes de la carrera
    // (incluidos los que descansan en la manga que se está viendo), para la
    // tabla de Clasificación Proyectada.
    function raceWideOf(key, nameHint) {
      const rw = raceByKey.get(key) || {};
      const name = rw.entity_name || nameHint || null;
      const racePaceAllMs   = rw.pace_all_ms   ? Math.round(rw.pace_all_ms)   : null;
      const racePaceCleanMs = rw.pace_clean_ms ? Math.round(rw.pace_clean_ms) : null;
      // Perdido TOTAL de carrera: mismo criterio que el de manga (Σ sobre las
      // salidas/pits del exceso frente a la media limpia), pero con la media
      // race-wide como referencia y sobre TODAS las salidas de la carrera.
      const ref = racePaceCleanMs ?? racePaceAllMs ?? 0;
      const exitTimes = raceExitTimesByKey.get(key) || [];
      let raceLostMs = 0;
      for (const t of exitTimes) { const over = t - ref; if (over > 0) raceLostMs += over; }
      return {
        raceTotalLaps: rw.total_laps || 0,
        racePaceAllMs, racePaceCleanMs,
        raceBestMs: rw.best_ms != null ? rw.best_ms : null,
        raceExits: rw.exits || 0,
        racePits:  rw.pits  || 0,
        raceLostMs,
        raceLostLapsEquiv: ref > 0 ? +(raceLostMs / ref).toFixed(2) : 0,
        mangasRaced: rw.mangas_raced || 0,
        raceTireChanges: hasTireControl && name ? (tireByNameTotal[name] || 0) : 0,
      };
    }
    const raceWideByKey = {};
    for (const key of raceByKey.keys()) raceWideByKey[key] = raceWideOf(key);

    // Enriquecer cada entity con su total race-wide
    entities.forEach(e => {
      Object.assign(e, raceWideOf(e.key, e.entityName));
      const rc = raceConsByKey.get(e.key) || null;
      e.raceConsistency      = rc ? rc.pct    : null;
      e.raceConsistencyStdMs = rc ? rc.stdMs  : null;
      e.raceConsistencyLevel = rc ? rc.level  : null;
      e.raceConsistencyMeanMs = rc ? rc.meanMs : null;
      const rcA = raceConsAllByKey.get(e.key) || null;
      e.raceConsistencyAll      = rcA ? rcA.pct    : null;
      e.raceConsistencyAllStdMs = rcA ? rcA.stdMs  : null;
      e.raceConsistencyAllLevel = rcA ? rcA.level  : null;
      e.raceConsistencyAllMeanMs = rcA ? rcA.meanMs : null;
    });

    // Progreso de carrera: vueltas ACUMULADAS de cada equipo manga a manga
    // (agrupado por NOMBRE para soportar equipos duplicados por tanda). Lo usa
    // la gráfica "Gap de vueltas" para mostrar el gap entre equipos a lo largo
    // de la carrera y su tendencia (se acercan / se alejan).
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
    `).all(race.id);
    const progMangas = [...new Set(progressRows.map(r => r.manga))].sort((a, b) => a - b);
    const lapsByNameManga = {}, avgByNameManga = {};
    progressRows.forEach(r => {
      (lapsByNameManga[r.ename] = lapsByNameManga[r.ename] || {})[r.manga] = r.laps;
      (avgByNameManga[r.ename]  = avgByNameManga[r.ename]  || {})[r.manga] = r.avg_ms;
    });
    // byName = vueltas acumuladas por manga; avgByName = media de vuelta (limpia)
    // de cada manga. Lo usan las gráficas de la pestaña Proyectada (datos de
    // carrera, X = manga).
    const raceProgress = { mangas: progMangas, byName: {}, avgByName: {} };
    Object.keys(lapsByNameManga).forEach(name => {
      let cum = 0;
      raceProgress.byName[name]    = progMangas.map(mn => { cum += (lapsByNameManga[name][mn] || 0); return cum; });
      raceProgress.avgByName[name] = progMangas.map(mn => {
        const a = avgByNameManga[name][mn]; return a != null ? Math.round(a) : null;
      });
    });

    // Clasificación PROYECTADA de TODA la carrera: la MISMA proyección ÚNICA que
    // el directo, Le Mans y el panel (TimingService.buildRaceProjection, desde
    // BD). Funciona haya o no sesión viva, así el espectador ve siempre la
    // clasificación estimada al final, no solo la manga.
    // Cacheada (TTL corto, del motor): esta vista se repide en CADA cruce, y sin
    // caché la proyección costaba 68 ms sobre las 160.000 vueltas de una 24 h en
    // cada una de esas peticiones. Es la misma caché que usan el directo y Lap.
    let projection = null;
    try {
      projection = TimingService._cachedProjection(race.id);
    } catch (e) { /* sin proyección si falla la consulta */ }

    // Quién descansa AHORA MISMO (en la manga realmente activa, no la que se
    // esté mirando en el desplegable) — la Clasificación Proyectada es de toda
    // la carrera y no depende de la manga seleccionada, así que el descanso
    // que marca también tiene que ser el de la manga en curso de verdad.
    let restingKeysActive = [];
    if (TimingService.activeMangaId != null) {
      restingKeysActive = db.prepare(`
        SELECT CASE WHEN ml.team_id IS NOT NULL THEN 'team_' || ml.team_id ELSE 'driver_' || ml.driver_id END AS key
        FROM manga_lanes ml
        WHERE ml.manga_id = ? AND ml.is_rest = 1 AND (ml.team_id IS NOT NULL OR ml.driver_id IS NOT NULL)
      `).all(TimingService.activeMangaId).map(r => r.key);
    }

    // La comparativa en vivo (tú vs 1-2 rivales) se calcula en CLIENTE a partir
    // de `entities` (cada una trae lane, position, totalLaps, best/avg, última).
    const payload = {
      raceId: race.id,
      mangaId: manga.id,
      mangaNumber: manga.number,
      mangaStatus: manga.status,
      mangaDurationMs,
      elapsedMs,
      remainingMs,
      remainingMangas,
      isActive,
      entities,
      projection,
      raceProgress,
      raceWideByKey,
      restingKeysActive,
    };

    _jsonCache.set(cacheKey, { ts: Date.now(), mut: Lap.mutationCount, tireMut: TireChange.mutationCount, isActive, payload });
    while (_jsonCache.size > JSON_MAX_KEYS) _jsonCache.delete(_jsonCache.keys().next().value);

    res.json(payload);
  }

  /** Tira la caché de la respuesta. Para los tests; en producción caduca sola. */
  static _resetCache() { _jsonCache.clear(); }
}

module.exports = LiveStatsController;
