const Race          = require('../models/Race');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Lap           = require('../models/Lap');
const TimingService = require('../services/TimingService');
const db            = require('../config/database');

// ── Helpers ────────────────────────────────────────────────────────────────

// Cálculo de predicción de adelantamiento entre dos entidades.
// my, rival: { totalLapsRaceSoFar, pacePerLap (ms), mangasRaced, lapsThisManga }
// remainingMsInManga, remainingMangas
// Devuelve { willPassInManga, willPassInRace, lapsAtEndOfManga, lapsAtEndOfRace, ... }
function predictOvertake({ my, rival, remainingMsInManga, remainingMangas, avgMangaDurationMs }) {
  // Proyección dentro de la manga actual: vueltas adicionales = remaining / pace.
  const myExtraInManga    = my.pacePerLap    > 0 ? Math.max(0, remainingMsInManga / my.pacePerLap)    : 0;
  const rivalExtraInManga = rival.pacePerLap > 0 ? Math.max(0, remainingMsInManga / rival.pacePerLap) : 0;

  const myAtEndOfManga    = my.totalLapsRaceSoFar    + myExtraInManga;
  const rivalAtEndOfManga = rival.totalLapsRaceSoFar + rivalExtraInManga;

  // Proyección para el resto de la carrera (mangas pendientes posteriores):
  // se asume que cada uno seguirá a su ritmo medio histórico × duración media.
  const myPerManga    = my.pacePerLap    > 0 ? avgMangaDurationMs / my.pacePerLap    : 0;
  const rivalPerManga = rival.pacePerLap > 0 ? avgMangaDurationMs / rival.pacePerLap : 0;

  const myAtEndOfRace    = myAtEndOfManga    + remainingMangas * myPerManga;
  const rivalAtEndOfRace = rivalAtEndOfManga + remainingMangas * rivalPerManga;

  const gapNow         = my.totalLapsRaceSoFar - rival.totalLapsRaceSoFar;
  const gapEndOfManga  = myAtEndOfManga       - rivalAtEndOfManga;
  const gapEndOfRace   = myAtEndOfRace        - rivalAtEndOfRace;

  // Detecta cambios de signo del gap entre ahora y el futuro → indica
  // adelantamiento en cualquiera de los dos sentidos.
  const willPassInManga    = gapNow < 0 && gapEndOfManga > 0;  // yo le paso
  const willPassInRace     = gapNow < 0 && gapEndOfRace  > 0;
  const willBePassedManga  = gapNow > 0 && gapEndOfManga < 0;  // me pasa él
  const willBePassedRace   = gapNow > 0 && gapEndOfRace  < 0;

  // Distancia (en vueltas) que necesito mejorar o defender para forzar/evitar
  // el adelantamiento. Sign convention: positivo = soy yo el que necesita
  // ganar terreno; negativo = el rival necesita mejorar para alcanzarme.
  const margin = +gapEndOfRace.toFixed(2);

  return {
    gapNow:            +gapNow.toFixed(2),
    gapEndOfManga:     +gapEndOfManga.toFixed(2),
    gapEndOfRace:      +gapEndOfRace.toFixed(2),
    myAtEndOfManga:    +myAtEndOfManga.toFixed(2),
    rivalAtEndOfManga: +rivalAtEndOfManga.toFixed(2),
    myAtEndOfRace:     +myAtEndOfRace.toFixed(2),
    rivalAtEndOfRace:  +rivalAtEndOfRace.toFixed(2),
    willPassInManga,
    willPassInRace,
    willBePassedManga,
    willBePassedRace,
    margin,
  };
}


// Sectorización en N bins iguales sobre la duración de la manga. Por defecto 3
// bins (inicio / mitad / final). Si la manga es muy corta los bins pequeños
// pueden quedar vacíos — la UI lo muestra como "—".
const SECTOR_BINS = 3;

function buildEntityStats({ laps, mangaDurationMs }) {
  // laps = array de filas para UN piloto/equipo en una manga, ordenadas por
  // elapsed_ms ASC. Cada fila { lap_time_ms, elapsed_ms, is_exit, is_pit_stop }.
  const racing = laps.filter(l => !l.is_ghost);  // ghosts no cuentan en nada
  const clean  = racing.filter(l => !l.is_exit); // sin exits ni pit-stops
  const exits  = racing.filter(l => !!l.is_exit);

  const sum   = a => a.reduce((s, l) => s + l.lap_time_ms, 0);
  const min   = a => a.length ? Math.min(...a.map(l => l.lap_time_ms)) : null;
  const avg   = a => a.length ? Math.round(sum(a) / a.length) : null;

  const bestMs       = min(clean);
  const avgAll       = avg(racing);
  const avgClean     = avg(clean);
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
    for (const l of racing) {
      const idx = Math.min(SECTOR_BINS - 1, Math.floor(l.elapsed_ms / binMs));
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

  return {
    totalLaps:   racing.length,
    cleanLaps:   clean.length,
    exitCount:   exits.filter(l => !l.is_pit_stop).length,
    pitStopCount: exits.filter(l => l.is_pit_stop).length,
    bestMs,
    avgAll, avgClean,
    deltaAll, deltaClean,
    lostMs, lostLapsEquiv,
    sectors,
  };
}

class LiveStatsController {

  // GET /race-stats — landing: list races so the user picks one. Auto-redirect
  // to the active race if there's one.
  static index(req, res) {
    const lang = req.session?.lang || 'es';
    const races = Race.findAll();
    const active = races.find(r => r.status === 'active');
    if (active) return res.redirect(`/races/${active.id}/live-stats`);
    res.render('live-stats/index', { t: req.t, lang, races });
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

    res.render('live-stats/show', {
      t: req.t, lang, race, tandas, allMangas, entityRows,
      selectedMangaId,
      isActive: TimingService.activeMangaId === selectedMangaId,
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
             l.lap_time_ms, l.elapsed_ms, l.is_exit, l.is_pit_stop, l.is_ghost,
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
      ...buildEntityStats({ laps: e.laps, mangaDurationMs }),
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
        COUNT(DISTINCT l.manga_id) AS mangas_raced
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ?
      GROUP BY key
    `).all(race.id);
    const raceByKey = new Map();
    raceWide.forEach(r => raceByKey.set(r.key, r));

    // Mangas restantes en la carrera (pending) y duración media (para proyectar futuro).
    const remainingMangas = db.prepare(`
      SELECT COUNT(*) AS n FROM mangas m
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND m.status = 'pending'
    `).get(race.id).n;
    const avgMangaDurationMs = mangaDurationMs || (race.manga_duration_minutes * 60 * 1000);

    // Enriquecer cada entity con su total race-wide
    entities.forEach(e => {
      const rw = raceByKey.get(e.key) || {};
      e.raceTotalLaps   = rw.total_laps  || 0;
      e.racePaceAllMs   = rw.pace_all_ms   ? Math.round(rw.pace_all_ms)   : null;
      e.racePaceCleanMs = rw.pace_clean_ms ? Math.round(rw.pace_clean_ms) : null;
      e.mangasRaced     = rw.mangas_raced || 0;
    });

    // ── Predicción de adelantamiento (opcional) ─────────────────────────────
    let prediction = null;
    const myKey      = req.query.entity     || null;
    const rivalKey   = req.query.compareWith || null;
    if (myKey && rivalKey && myKey !== rivalKey) {
      const me    = entities.find(e => e.key === myKey);
      const rival = entities.find(e => e.key === rivalKey);
      if (me && rival) {
        const myPace    = (req.query.usePaceClean === '1' ? me.avgClean    : me.avgAll)    ?? me.racePaceAllMs;
        const rivalPace = (req.query.usePaceClean === '1' ? rival.avgClean : rival.avgAll) ?? rival.racePaceAllMs;
        prediction = predictOvertake({
          my:    { totalLapsRaceSoFar: me.raceTotalLaps,    pacePerLap: myPace    || 0 },
          rival: { totalLapsRaceSoFar: rival.raceTotalLaps, pacePerLap: rivalPace || 0 },
          remainingMsInManga: remainingMs ?? 0,
          remainingMangas,
          avgMangaDurationMs,
        });
        prediction.myName    = me.entityName;
        prediction.rivalName = rival.entityName;
      }
    }

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
      prediction,
    });
  }
}

module.exports = LiveStatsController;
