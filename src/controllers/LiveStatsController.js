const Race          = require('../models/Race');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Lap           = require('../models/Lap');
const TimingService = require('../services/TimingService');
const db            = require('../config/database');
const {
  CONSISTENCY_LEVELS,
  consistencyLevel,
  median,
  filterIncidentLaps,
  MIN_CONSISTENCY_LAPS,
  robustConsistency,
} = require('../lib/consistency');

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
    if (activeRaces.length === 1) return res.redirect(`/races/${activeRaces[0].id}/live-stats`);
    res.render('live-stats/index', {
      t: req.t, lang, races: activeRaces, noLive: activeRaces.length === 0,
    });
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

    // Lista de entidades disponibles (de TODA la carrera, para que el piloto
    // se encuentre aunque ahora esté descansando en esta manga).
    const entityRows = db.prepare(`
      SELECT DISTINCT
        COALESCE(t.id, d.id)   AS entity_id,
        COALESCE(t.name, d.name) AS entity_name,
        CASE WHEN t.id IS NOT NULL THEN 'team' ELSE 'driver' END AS entity_type
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas tn ON tn.id = m.tanda_id
      LEFT JOIN teams   t ON t.id = ml.team_id
      LEFT JOIN drivers d ON d.id = ml.driver_id
      WHERE tn.race_id = ? AND ml.is_rest = 0
      ORDER BY entity_name COLLATE NOCASE ASC
    `).all(race.id);

    // ── Matriz por carril ────────────────────────────────────────────────
    // Stats de cada entidad EN cada carril a lo largo de TODA la carrera, para
    // la comparativa por carril. clave (`tipo_id`) → carril → { stats }.
    // best = excluye salidas/warmup/1ª vuelta (igual que raceBestByLane).
    // avgAll = media sucia (con salidas, sin warmup); avgClean = sin salidas.
    const laneStatRows = db.prepare(`
      SELECT
        CASE WHEN l.team_id IS NOT NULL THEN 'team_'||l.team_id ELSE 'driver_'||l.driver_id END AS key,
        l.lane,
        COUNT(*) AS laps,
        MIN(CASE WHEN l.is_exit=0 AND l.is_warmup=0 AND l.lap_number>1 THEN l.lap_time_ms END) AS bestMs,
        AVG(CASE WHEN l.is_warmup=0 THEN l.lap_time_ms END)                    AS avgAllMs,
        AVG(CASE WHEN l.is_warmup=0 AND l.is_exit=0 THEN l.lap_time_ms END)    AS avgCleanMs,
        SUM(l.is_exit) AS exits
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
        laps: r.laps, bestMs: r.bestMs, avgAllMs: r.avgAllMs, avgCleanMs: r.avgCleanMs, exits: r.exits || 0,
      };
    });
    const lanesList = [...laneSet].sort((a, b) => a - b);

    res.render('live-stats/show', {
      t: req.t, lang, race, tandas, allMangas, entityRows,
      selectedMangaId,
      isActive: TimingService.activeMangaId === selectedMangaId,
      laneMatrix, lanesList,
    });
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
    const session  = isActive ? TimingService.session : null;
    const mangaDurationMs = session?.durationMs
                          ?? (race.manga_duration_minutes * 60 * 1000);

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

    // Clasificación por total laps (desc), luego best (asc)
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
        SUM(CASE WHEN l.is_ghost = 0 THEN 1 ELSE 0 END) AS total_laps,
        AVG(CASE WHEN l.is_ghost = 0 THEN l.lap_time_ms END) AS pace_all_ms,
        AVG(CASE WHEN l.is_ghost = 0 AND l.is_exit = 0 THEN l.lap_time_ms END) AS pace_clean_ms,
        MIN(CASE WHEN l.is_ghost = 0 AND l.is_exit = 0 AND l.is_warmup = 0 AND l.lap_number > 1 AND l.lap_time_ms >= ${race.min_lap_ms || 0} THEN l.lap_time_ms END) AS best_ms,
        SUM(CASE WHEN l.is_ghost = 0 AND l.is_exit = 1 AND l.is_pit_stop = 0 THEN 1 ELSE 0 END) AS exits,
        SUM(CASE WHEN l.is_ghost = 0 AND l.is_pit_stop = 1 THEN 1 ELSE 0 END) AS pits,
        COUNT(DISTINCT l.manga_id) AS mangas_raced
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ?
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
    for (const r of eligibleLapRows) {
      let all = raceAllByKey.get(r.key);
      if (!all) { all = []; raceAllByKey.set(r.key, all); }
      all.push(r.t);
      if (!r.is_exit) {
        let cln = raceCleanByKey.get(r.key);
        if (!cln) { cln = []; raceCleanByKey.set(r.key, cln); }
        cln.push(r.t);
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
    // Enriquecer cada entity con su total race-wide
    entities.forEach(e => {
      const rw = raceByKey.get(e.key) || {};
      e.raceTotalLaps   = rw.total_laps  || 0;
      e.racePaceAllMs   = rw.pace_all_ms   ? Math.round(rw.pace_all_ms)   : null;
      e.racePaceCleanMs = rw.pace_clean_ms ? Math.round(rw.pace_clean_ms) : null;
      e.raceBestMs      = rw.best_ms != null ? rw.best_ms : null;
      e.raceExits       = rw.exits || 0;
      e.racePits        = rw.pits  || 0;
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
      e.mangasRaced     = rw.mangas_raced || 0;
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

    // Clasificación PROYECTADA de TODA la carrera: la MISMA proyección que el
    // directo (getStandings().projection / _buildProjection), para que el
    // espectador vea la clasificación estimada al final, no solo la manga.
    // Disponible mientras corre una manga de esta carrera.
    let projection = null;
    try {
      const TimingService = require('../services/TimingService');
      if (TimingService.activeRaceId === race.id) {
        const st = TimingService.getStandings();
        projection = st ? st.projection : null;
      }
    } catch (e) { /* sin proyección si no hay sesión viva */ }

    // La comparativa en vivo (tú vs 1-2 rivales) se calcula en CLIENTE a partir
    // de `entities` (cada una trae lane, position, totalLaps, best/avg, última).
    res.json({
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
    });
  }
}

module.exports = LiveStatsController;
