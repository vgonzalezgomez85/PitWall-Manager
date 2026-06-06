const Race           = require('../models/Race');
const Manga          = require('../models/Manga');
const Tanda          = require('../models/Tanda');
const Lap            = require('../models/Lap');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
const DriverShift    = require('../models/DriverShift');
const SocketService  = require('../services/SocketService');
const SerialService  = require('../services/SerialService');
const TimingService  = require('../services/TimingService');
const ExcelJS        = require('exceljs');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

class SessionController {

  // Devuelve la duración EFECTIVA de una manga en ms:
  //   - Si TimingService está gestionando esta manga ahora mismo, usa su
  //     `session.durationMs` (refleja la trama race_go del DS-300).
  //   - En su defecto, usa `race.manga_duration_minutes` de BD. Este valor
  //     es habitualmente el placeholder 99 que pone el wizard porque la
  //     duración real la marca el DS-300 al pulsar GO, así que la proyección
  //     basada en este fallback será inflada si no se ha corregido.
  //
  // Pendiente: idealmente cada manga debería persistir su duración real en
  // BD cuando arranca, para que las vistas históricas/post-carrera también
  // calculen bien la proyección. De momento solo el live (mientras está
  // activo) usa la duración real.
  static _getEffectiveMangaDurationMs(race, manga) {
    if (TimingService.activeMangaId === manga.id && TimingService.session?.durationMs > 0) {
      return TimingService.session.durationMs;
    }
    // Duración real persistida del DS (GO) — correcta también en mangas
    // terminadas o tras recargar, a diferencia del placeholder de la BD.
    if (manga.actual_duration_ms > 0) return manga.actual_duration_ms;
    return (race.manga_duration_minutes || 0) * 60000;
  }

  // POST /races/:id/mangas/:mangaId/start
  static start(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);

    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (manga.race_id !== race.id) return res.status(400).render('error', { t: req.t, code: 400, message: 'Bad request' });

    if (manga.status !== 'pending') return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);

    if (TimingService.isRunning) {
      return res.status(409).render('error', {
        t: req.t, code: 409,
        message: `Another manga is already running (ID ${TimingService.activeMangaId})`
      });
    }

    const lanes   = Manga.getLanes(manga.id);
    const tanda   = Tanda.findById(manga.tanda_id);
    const teams   = Team.findByTanda(manga.tanda_id);
    const drivers = Driver.findByTanda(manga.tanda_id);

    // En simulación/BART SlotTime inicia la carrera, así que el usuario puede
    // fijar la duración al dar GO (en DS-300 la manda la caja). Si llega, se usa
    // para esta manga y se recuerda en la carrera para el próximo GO.
    const durMin = parseInt(req.body.duration_minutes, 10);
    let durationMs = null;
    if (Number.isFinite(durMin) && durMin > 0) {
      durationMs = durMin * 60000;
      race.manga_duration_minutes = durMin;
      try { require('../config/database').prepare('UPDATE races SET manga_duration_minutes=? WHERE id=?').run(durMin, race.id); } catch {}
    }

    TimingService.startManga(manga, race, lanes, teams, drivers, durationMs);
    Tanda.updateStatus(tanda.id, 'active');
    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/pause  — pausa manual (simulación/BART)
  static pause(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (TimingService.activeMangaId === manga.id) TimingService.pauseManga();
    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/resume  — reanuda manual (simulación/BART)
  static resume(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (TimingService.activeMangaId === manga.id) TimingService.resumeManga();
    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/stop
  // Manual stop: cancels the manga, wipes laps, resets to pending for restart.
  static stop(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    if (TimingService.activeMangaId === manga.id) {
      TimingService.cancelManga();
    } else if (manga.status === 'active') {
      // Manga stuck as active after server restart — clean up manually
      Lap.deleteByManga(manga.id);
      Manga.updateStatus(manga.id, 'pending');
    }

    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/repeat
  // Resets a finished manga to pending so it can be run again.
  static repeat(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (manga.status !== 'finished') return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);

    // Can't repeat while another manga is running
    if (TimingService.isRunning) {
      req.session.flash = {
        type: 'error',
        text: req.session?.lang === 'en'
          ? 'Cannot repeat: another heat is currently running.'
          : 'No se puede repetir: hay otra manga en marcha.',
      };
      return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
    }

    // Wipe laps and reset manga to pending
    Lap.deleteByManga(manga.id);
    Manga.updateStatus(manga.id, 'pending');

    // If tanda was finished, reactivate it
    const tanda = Tanda.findById(manga.tanda_id);
    if (tanda?.status === 'finished') Tanda.updateStatus(tanda.id, 'active');

    // Clear the tanda boundary so the hardware GO is accepted again.
    TimingService.clearTandaBoundary();

    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // GET /races/:id/mangas/:mangaId/live
  static live(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const laps     = Lap.findByManga(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;

    // Previous-manga lap totals per lane (for "race total" display)
    const prevLapsByLane = {};
    lanes.forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    // Pre-register this manga so DS hardware GO button can start it
    if (manga.status === 'pending' && !TimingService.isRunning) {
      const teams   = Team.findByTanda(manga.tanda_id);
      const drivers = Driver.findByTanda(manga.tanda_id);
      // If the in-memory tanda boundary was set by a previous race/tanda
      // that has no finished mangas in this race's current tanda, clear it
      // so the hardware GO is accepted again.
      const db = require('../config/database');
      const hasFinishedInTanda = db.prepare(
        `SELECT 1 FROM mangas WHERE tanda_id = ? AND status = 'finished' LIMIT 1`
      ).get(manga.tanda_id);
      if (!hasFinishedInTanda) TimingService.clearTandaBoundary();
      TimingService.setPendingManga(manga, race, lanes, teams, drivers);
    }

    const totalMangas = Manga.findByTanda(manga.tanda_id).length;
    const totalTandas = Tanda.findByRace(race.id).length;
    // Duración total de la CARRERA (todas las mangas de todas las tandas) —
    // usado por la clasificación estimada con la fórmula:
    //   projectedTotal = totalRaceMs / lapAvgMs
    const totalRaceMangas = require('../config/database').prepare(
      'SELECT COUNT(*) c FROM mangas m JOIN tandas t ON t.id = m.tanda_id WHERE t.race_id = ?'
    ).get(race.id).c;
    // Duración EFECTIVA por manga: si el TimingService está gestionando
    // esta manga ahora mismo, usar su durationMs (refleja el valor que el
    // DS-300 envió en el race_go). En su defecto, fallback al valor de BD
    // (manga_duration_minutes, normalmente el placeholder por defecto 99
    // que no es realista — ver memoria "Log duración manga engañoso").
    const effectiveMangaDurationMs = SessionController._getEffectiveMangaDurationMs(race, manga);
    const totalRaceMs = totalRaceMangas * effectiveMangaDurationMs;

    // Team-race extras: members per lane + current active drivers
    let teamMembersByLane = {};
    let activeDriversByLane = {};
    if (race.format === 'team') {
      const db = require('../config/database');
      lanes.filter(l => !l.is_rest && l.team_id).forEach(l => {
        teamMembersByLane[l.lane] = db.prepare(
          'SELECT id, name FROM drivers WHERE team_id = ? ORDER BY name ASC'
        ).all(l.team_id);
      });
      const shifts = DriverShift.currentByManga(manga.id);
      shifts.forEach(s => { activeDriversByLane[s.lane] = s.driver_name; });
    }

    // Race-wide best lap per lane (for non-active or page reload)
    const raceBestLapsArr = Lap.raceBestByLane(race.id);
    const raceBestLaps = {};
    raceBestLapsArr.forEach(r => { raceBestLaps[r.lane] = { bestLapMs: r.bestLapMs, entityName: r.entityName }; });

    // Next tanda button: show whenever this tanda is finished (regardless of manga state)
    let nextTanda = null;
    if (tanda?.status === 'finished') {
      nextTanda = Tanda.findNextPending(race.id, tanda.number) || null;
    }

    // Next-manga lane assignments per current lane (for "→ Pista X" hint on cards
    // once the current manga finishes). Looks first inside the same tanda, then
    // falls back to the first manga of the next pending tanda.
    const nextLaneByLane = {};
    let nextMangaInfo = null;
    {
      const sameTandaMangas = Manga.findByTanda(manga.tanda_id) || [];
      let next = sameTandaMangas.find(m => m.number > manga.number && m.status !== 'finished');
      if (!next && tanda) {
        const nt = Tanda.findNextPending(race.id, tanda.number);
        if (nt) {
          const ntMangas = Manga.findByTanda(nt.id) || [];
          next = ntMangas.find(m => m.status !== 'finished') || null;
          if (next) nextMangaInfo = { tandaNumber: nt.number, mangaNumber: next.number, sameTanda: false };
        }
      } else if (next) {
        nextMangaInfo = { tandaNumber: tanda.number, mangaNumber: next.number, sameTanda: true };
      }
      if (next) {
        const nextLanes = Manga.getLanes(next.id) || [];
        // Number resting entities in next manga (1..N) so we can show
        // "→ Descanso n/N" on each card.
        const nextRest = nextLanes.filter(nl => nl.is_rest)
          .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
        const nextRestTotal = nextRest.length;
        const nextRestPosByKey = {};
        nextRest.forEach((nl, i) => {
          const key = nl.team_id ? `t${nl.team_id}` : `d${nl.driver_id}`;
          nextRestPosByKey[key] = i + 1;
        });
        // Same alphabetical numbering for CURRENT rest entities (so cardId matches client)
        const curRest = lanes.filter(l => l.is_rest)
          .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
        const curRestPosByKey = {};
        curRest.forEach((cl, i) => {
          const key = cl.team_id ? `t${cl.team_id}` : `d${cl.driver_id}`;
          curRestPosByKey[key] = i + 1;
        });

        lanes.forEach(l => {
          if (!l.team_id && !l.driver_id) return;
          const match = nextLanes.find(nl =>
            (l.team_id   && nl.team_id   === l.team_id) ||
            (l.driver_id && nl.driver_id === l.driver_id)
          );
          if (!match) return;
          const myKey  = l.team_id ? `t${l.team_id}` : `d${l.driver_id}`;
          const cardId = l.is_rest ? `r${curRestPosByKey[myKey] || 0}` : String(l.lane);
          const value  = match.is_rest
            ? { rest: true, pos: nextRestPosByKey[myKey] || 0, total: nextRestTotal }
            : { lane: match.lane };
          nextLaneByLane[cardId] = value;
        });
      }
    }

    // All-race participant totals + remaining pending mangas (for full-race projection).
    // Includes ALL entities assigned to any manga of the race (even tandas not started yet).
    const allParticipants = Lap.aggregateByRace(race.id);
    const db = require('../config/database');
    const isTeamRace = race.format === 'team';
    const idCol = isTeamRace ? 'ml.team_id' : 'ml.driver_id';
    const nameJoin = isTeamRace
      ? 'JOIN teams e ON e.id = ml.team_id'
      : 'JOIN drivers e ON e.id = ml.driver_id';
    const colorCol = isTeamRace ? 'e.color' : 'NULL';

    const allAssigned = db.prepare(`
      SELECT ${idCol} AS entity_id, e.name AS entity_name, ${colorCol} AS color,
             SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending_mangas,
             COUNT(*) AS planned_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      ${nameJoin}
      WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      GROUP BY entity_id
    `).all(race.id);

    const apMap = new Map(allParticipants.map(p => [p.entity_id, p]));
    allAssigned.forEach(a => {
      let p = apMap.get(a.entity_id);
      if (!p) {
        p = {
          entity_id: a.entity_id, entity_name: a.entity_name,
          entity_type: isTeamRace ? 'team' : 'driver',
          color: a.color,
          total_laps: 0, best_lap_ms: null, avg_lap_ms: null,
          total_time_ms: 0, mangas_raced: 0, exit_count: 0,
        };
        allParticipants.push(p);
        apMap.set(a.entity_id, p);
      }
      p.remaining_mangas = a.pending_mangas || 0;
      p.planned_mangas   = a.planned_mangas || 0;
    });

    const LicenseService = require('../services/LicenseService');
    const hasBestLaps  = LicenseService.has('best_laps');
    const hasQrCheckin = LicenseService.has('qr_checkin');

    const isSimulating = SerialService.isSimulating;
    const isBart       = SerialService.isBart;
    const isPaused     = TimingService.isPaused && isActive;
    res.render('races/live', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, prevLapsByLane, totalMangas, totalTandas, totalRaceMs, effectiveMangaDurationMs, teamMembersByLane, activeDriversByLane, raceBestLaps, hasBestLaps, hasQrCheckin, nextTanda, allParticipants, nextLaneByLane, nextMangaInfo, isSimulating, isBart, isPaused });
  }

  // GET /races/:id/mangas/:mangaId/panel/:type  (standalone popup)
  static panel(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const laps     = Lap.findByManga(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;

    // All-race participants (includes pending tandas) — see live() for details
    const allParticipants = Lap.aggregateByRace(race.id);
    const db = require('../config/database');
    const isTeamRace = race.format === 'team';
    const idCol = isTeamRace ? 'ml.team_id' : 'ml.driver_id';
    const nameJoin = isTeamRace
      ? 'JOIN teams e ON e.id = ml.team_id'
      : 'JOIN drivers e ON e.id = ml.driver_id';
    const colorCol = isTeamRace ? 'e.color' : 'NULL';
    const allAssigned = db.prepare(`
      SELECT ${idCol} AS entity_id, e.name AS entity_name, ${colorCol} AS color,
             SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending_mangas,
             COUNT(*) AS planned_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      ${nameJoin}
      WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      GROUP BY entity_id
    `).all(race.id);
    const apMap = new Map(allParticipants.map(p => [p.entity_id, p]));
    allAssigned.forEach(a => {
      let p = apMap.get(a.entity_id);
      if (!p) {
        p = {
          entity_id: a.entity_id, entity_name: a.entity_name,
          entity_type: isTeamRace ? 'team' : 'driver', color: a.color,
          total_laps: 0, best_lap_ms: null, avg_lap_ms: null,
          total_time_ms: 0, mangas_raced: 0, exit_count: 0,
        };
        allParticipants.push(p);
        apMap.set(a.entity_id, p);
      }
      p.remaining_mangas = a.pending_mangas || 0;
      p.planned_mangas   = a.planned_mangas || 0;
    });

    // ── Carriles SIN entidad asignada (datos de test / pruebas) ───────────
    // El query anterior excluye filas con team_id/driver_id = NULL, lo que
    // colapsa cualquier dato de prueba en una sola "fila null". Para que el
    // popup muestre algo útil, añadimos un participante sintético por LANE
    // basándonos en manga_lanes con entidad nula. Las stats salen de laps.
    const lanesWithoutEntity = db.prepare(`
      SELECT ml.lane,
             COUNT(DISTINCT m.id) AS planned_mangas,
             SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      WHERE m.race_id = ?
        AND ml.is_rest = 0
        AND ml.team_id IS NULL AND ml.driver_id IS NULL
      GROUP BY ml.lane
    `).all(race.id);

    const lapStatsByLane = db.prepare(`
      SELECT lane,
             COUNT(*)                                             AS total_laps,
             MIN(CASE WHEN is_exit = 0 AND is_warmup = 0
                      THEN lap_time_ms END)                       AS best_lap_ms,
             AVG(CASE WHEN is_warmup = 0 THEN lap_time_ms END)    AS avg_lap_ms,
             COUNT(DISTINCT manga_id)                             AS mangas_raced
      FROM laps
      WHERE race_id = ? AND is_ghost = 0
        AND team_id IS NULL AND driver_id IS NULL
      GROUP BY lane
    `).all(race.id);
    const lapByLane = new Map(lapStatsByLane.map(r => [r.lane, r]));

    lanesWithoutEntity.forEach(l => {
      const stats = lapByLane.get(l.lane) || {};
      allParticipants.push({
        entity_id:        `lane_${l.lane}`,
        entity_name:      `Pista ${l.lane}`,
        entity_type:      isTeamRace ? 'team' : 'driver',
        color:            null,
        total_laps:       stats.total_laps  || 0,
        best_lap_ms:      stats.best_lap_ms ?? null,
        avg_lap_ms:       stats.avg_lap_ms  ?? null,
        total_time_ms:    0,
        mangas_raced:     stats.mangas_raced || 0,
        exit_count:       0,
        planned_mangas:   l.planned_mangas  || 0,
        remaining_mangas: l.pending_mangas  || 0,
      });
    });

    // Quita la fila "null" sintética que sale de aggregateByRace cuando hay
    // laps sin team_id ni driver_id: ya están representadas por las "Pista N"
    for (let i = allParticipants.length - 1; i >= 0; i--) {
      if (allParticipants[i].entity_id == null) allParticipants.splice(i, 1);
    }

    // Previous race-wide laps per lane (excludes this manga) — same data the
    // live view uses to project totals; the panel needs it to match exactly.
    const prevLapsByLane = {};
    lanes.filter(l => !l.is_rest && (l.team_id || l.driver_id)).forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    // Mejor vuelta por carril (race-wide) — necesario para el panel fastest
    const raceBestLapsArr = Lap.raceBestByLane(race.id);
    const raceBestLaps = {};
    raceBestLapsArr.forEach(r => { raceBestLaps[r.lane] = { bestLapMs: r.bestLapMs, entityName: r.entityName }; });

    // Minimapa: para el panel `track` necesitamos el trazado del circuito
    // (imagen base64 + polilínea) y, por carril, la última vuelta para
    // calcular la posición inicial al abrir la ventana.
    let circuit = null, trackOutline = [], lastLapByLane = {};
    if (req.params.type === 'track') {
      const Circuit = require('../models/Circuit');
      circuit = race.circuit_id ? Circuit.findById(race.circuit_id) : null;
      if (circuit) trackOutline = Circuit.getTrackOutline(circuit);

      const db = require('../config/database');
      // Última vuelta no-fantasma por carril en esta manga
      const rows = db.prepare(`
        SELECT l.lane, l.lap_time_ms, l.timestamp
        FROM laps l
        INNER JOIN (
          SELECT lane, MAX(id) AS maxId FROM laps
          WHERE manga_id = ? AND is_ghost = 0
          GROUP BY lane
        ) m ON m.lane = l.lane AND m.maxId = l.id
        WHERE l.manga_id = ?
      `).all(manga.id, manga.id);
      rows.forEach(r => {
        lastLapByLane[r.lane] = {
          lapTimeMs:    r.lap_time_ms,
          timestampMs:  r.timestamp ? Date.parse(r.timestamp + 'Z') || Date.parse(r.timestamp) : null,
        };
      });
    }

    let view;
    if (req.params.type === 'fastest')      view = 'races/live-panel-fastest';
    else if (req.params.type === 'track')   view = 'races/live-panel-track';
    else                                    view = 'races/live-panel';

    const effectiveMangaDurationMs = SessionController._getEffectiveMangaDurationMs(race, manga);
    // Totales para la cabecera: "Tanda X/total · Manga Y/total".
    const totalTandas        = Tanda.findByRace(race.id).length;
    const totalMangasInTanda = Manga.findByTanda(manga.tanda_id).length;

    res.render(view, {
      t: req.t, race, manga, tanda, lanes, laps, isActive, standings,
      allParticipants, prevLapsByLane, raceBestLaps,
      circuit, trackOutline, lastLapByLane,
      effectiveMangaDurationMs, totalTandas, totalMangasInTanda,
    });
  }

  // GET /races/:id/mangas/:mangaId/tv  (fullscreen TV projection)
  static tv(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;

    const prevLapsByLane = {};
    lanes.filter(l => !l.is_rest).forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    res.render('races/tv', { t: req.t, race, manga, tanda, lanes, isActive, standings, prevLapsByLane });
  }

  // GET /races/:id/lemans  (Le Mans-style live classification board)
  static lemans(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const db   = require('../config/database');
    const lang = req.session?.lang || 'es';

    // Aggregate laps per unique team name across entire race, enriched with catalog metadata
    const teamRows = db.prepare(`
      SELECT
        t.name,
        MIN(t.color) AS color,
        COUNT(CASE WHEN l.is_ghost=0 AND l.is_exit=0 AND l.lap_number>0 THEN 1 END) AS total_laps,
        MIN(CASE WHEN l.is_ghost=0 AND l.is_exit=0 AND l.lap_number>0 THEN l.lap_time_ms END) AS best_lap_ms,
        MAX(tc.categoria)  AS categoria,
        MAX(tc.coche)      AS coche,
        MAX(tc.car_photo)  AS car_photo,
        MAX(tc.country)    AS country
      FROM teams t
      LEFT JOIN laps l ON l.team_id = t.id
      LEFT JOIN teams_catalog tc ON tc.name = t.name
      WHERE t.race_id = ?
      GROUP BY t.name
      ORDER BY total_laps DESC, best_lap_ms ASC
    `).all(race.id);

    // Laps from completed mangas only (for delta tracking in client)
    const prevLapRows = db.prepare(`
      SELECT t.name, COUNT(*) AS prev_laps
      FROM laps l
      JOIN teams t ON t.id = l.team_id
      JOIN mangas m ON m.id = l.manga_id
      WHERE l.race_id = ? AND l.is_ghost=0 AND l.is_exit=0 AND l.lap_number>0
        AND m.status = 'finished'
      GROUP BY t.name
    `).all(race.id);
    const prevLapMap = {};
    prevLapRows.forEach(r => { prevLapMap[r.name] = r.prev_laps; });

    // Most recent active driver per team (across all driver_shifts for this race)
    const shiftRows = db.prepare(`
      SELECT t.name AS team_name, ds.driver_name
      FROM driver_shifts ds
      JOIN teams t ON t.id = ds.team_id
      WHERE t.race_id = ?
      ORDER BY ds.id DESC
    `).all(race.id);
    const driverMap = {};
    shiftRows.forEach(d => { if (!driverMap[d.team_name]) driverMap[d.team_name] = d.driver_name; });

    // Current active manga lane → team name (for live socket updates)
    let activeMangaId = null;
    let laneToTeam    = {};
    const activeTanda = db.prepare(`
      SELECT id FROM tandas WHERE race_id = ? AND status='active' ORDER BY id DESC LIMIT 1
    `).get(race.id);
    if (activeTanda) {
      const activeManga = db.prepare(`
        SELECT id FROM mangas WHERE tanda_id = ? AND status='active' LIMIT 1
      `).get(activeTanda.id);
      if (activeManga) {
        activeMangaId = activeManga.id;
        db.prepare(`
          SELECT ml.lane, t.name AS team_name
          FROM manga_lanes ml JOIN teams t ON t.id = ml.team_id
          WHERE ml.manga_id = ? AND ml.is_rest = 0
        `).all(activeManga.id).forEach(r => { laneToTeam[r.lane] = r.team_name; });
      }
    }

    const leaderLaps = teamRows[0]?.total_laps ?? 0;
    const standings = teamRows.map((t, i) => ({
      position:      i + 1,
      name:          t.name,
      color:         t.color,
      totalLaps:     t.total_laps,
      prevLaps:      prevLapMap[t.name] ?? 0,
      bestLapMs:     t.best_lap_ms,
      gap:           leaderLaps - t.total_laps,
      currentDriver: driverMap[t.name] ?? null,
      categoria:     t.categoria  ?? null,
      coche:         t.coche      ?? null,
      car_photo:     t.car_photo  ?? null,
      country:       t.country    ?? null,
    }));

    const isActive = TimingService.activeMangaId != null;

    res.render('races/lemans', {
      t: req.t, race, lang, standings,
      activeMangaId, laneToTeam, isActive,
    });
  }

  // GET /races/:id/results
  static results(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const laneSequence = Race.getLaneSequence(race);
    const aggregate    = Lap.aggregateByRace(race.id);

    // Add per-lane breakdown for each entity
    const results = aggregate.map(row => ({
      ...row,
      perLane: Lap.perLaneByEntity(race.id, row.entity_id, row.entity_type)
    }));

    // Starting lane per entity: first non-rest assignment in tanda+manga order.
    // Teams/drivers that start resting will pick up the lane of the manga where
    // they first actually race (works correctly even with multi-circuit rest).
    const db = require('../config/database');
    const startRows = db.prepare(`
      SELECT ml.lane, ml.team_id, ml.driver_id
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND ml.is_rest = 0
      ORDER BY t.number ASC, m.number ASC, ml.lane ASC
    `).all(race.id);
    const startLaneByEntity = {};
    startRows.forEach(r => {
      const key = r.team_id ? `team_${r.team_id}` : `driver_${r.driver_id}`;
      if (startLaneByEntity[key] == null) startLaneByEntity[key] = r.lane;
    });

    // Race overall fastest lap (across all entities & lanes) — for highlight
    let raceBestLapMs = null, raceBestEntity = null, raceBestLane = null;
    for (const r of results) {
      for (const pl of r.perLane) {
        if (pl.best_ms != null && (raceBestLapMs == null || pl.best_ms < raceBestLapMs)) {
          raceBestLapMs = pl.best_ms;
          raceBestEntity = r.entity_name;
          raceBestLane = pl.lane;
        }
      }
    }

    const tandasRaw = Tanda.findByRace(race.id);
    const tandas = tandasRaw.map(t => ({
      ...t,
      mangas: Manga.findByTanda(t.id)
    }));

    // ── Progression chart data ─────────────────────────────────────────────
    // For each entity collect every racing lap with enough context to filter
    // by lane / manga / driver later in the UI. Exits & pit-stops are kept
    // (flagged) so the user can choose whether to include them.
    const progressionRows = db.prepare(`
      SELECT l.id, l.lane, l.lap_number, l.lap_time_ms, l.elapsed_ms,
             l.team_id, l.driver_id, l.is_exit, l.is_pit_stop,
             l.manga_id, m.number AS manga_number, m.started_at AS manga_started_at,
             d.name AS lap_driver_name
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
      ORDER BY t.number ASC, m.number ASC, l.lane ASC, l.lap_number ASC
    `).all(race.id);

    // For team races, resolve which driver was driving each lap from driver_shifts
    let shiftsByMangaLane = {};
    if (race.format === 'team') {
      const shifts = db.prepare(`
        SELECT manga_id, lane, driver_name, started_at
        FROM driver_shifts WHERE race_id = ?
        ORDER BY manga_id, lane, started_at ASC
      `).all(race.id);
      shifts.forEach(s => {
        const k = `${s.manga_id}_${s.lane}`;
        if (!shiftsByMangaLane[k]) shiftsByMangaLane[k] = [];
        shiftsByMangaLane[k].push({ driver: s.driver_name, ts: new Date(s.started_at).getTime() });
      });
    }
    function resolveDriver(row) {
      if (row.lap_driver_name) return row.lap_driver_name;
      if (race.format !== 'team') return null;
      const k = `${row.manga_id}_${row.lane}`;
      const shifts = shiftsByMangaLane[k];
      if (!shifts || shifts.length === 0) return null;
      const mangaStart = new Date(row.manga_started_at).getTime();
      const lapTs = mangaStart + (row.elapsed_ms || 0);
      let driver = shifts[0].driver;
      for (const s of shifts) {
        if (s.ts <= lapTs) driver = s.driver; else break;
      }
      return driver;
    }

    const progressionByEntity = {};
    results.forEach(r => {
      progressionByEntity[`${r.entity_type}_${r.entity_id}`] = {
        name: r.entity_name, color: r.color, laps: [],
      };
    });
    progressionRows.forEach(row => {
      const key = row.team_id ? `team_${row.team_id}` : `driver_${row.driver_id}`;
      const e = progressionByEntity[key];
      if (!e) return;
      e.laps.push({
        lane:      row.lane,
        ms:        row.lap_time_ms,
        manga:     row.manga_number,
        driver:    resolveDriver(row) || '—',
        isExit:    !!row.is_exit,
        isPitStop: !!row.is_pit_stop,
      });
    });

    // ── Position timeline ────────────────────────────────────────────────
    // For each lap inserted in chronological order, recompute the standings
    // of every entity (active or resting) and record their position. Result:
    // one polyline per entity = position over time of the race.
    const allLapsOrdered = db.prepare(`
      SELECT l.team_id, l.driver_id, l.lap_time_ms
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
      ORDER BY t.number ASC, m.number ASC, l.elapsed_ms ASC, l.id ASC
    `).all(race.id);

    const entityKeys = results.map(r => `${r.entity_type}_${r.entity_id}`);
    const entityState = {};
    results.forEach(r => {
      const k = `${r.entity_type}_${r.entity_id}`;
      entityState[k] = { totalLaps: 0, bestMs: null, name: r.entity_name, color: r.color };
    });
    const positionTimeline = {};
    entityKeys.forEach(k => { positionTimeline[k] = []; });

    function snapshotPositions(tick) {
      const sorted = entityKeys
        .map(key => ({ key, ...entityState[key] }))
        .sort((a, b) =>
          b.totalLaps - a.totalLaps ||
          (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity)
        );
      sorted.forEach((row, idx) => {
        const series = positionTimeline[row.key];
        const last = series[series.length - 1];
        if (!last || last.y !== idx + 1) series.push({ x: tick, y: idx + 1 });
      });
    }

    allLapsOrdered.forEach((lap, idx) => {
      const k = lap.team_id ? `team_${lap.team_id}` : `driver_${lap.driver_id}`;
      const s = entityState[k];
      if (!s) return;
      s.totalLaps += 1;
      if (s.bestMs == null || lap.lap_time_ms < s.bestMs) s.bestMs = lap.lap_time_ms;
      snapshotPositions(idx + 1);
    });
    // Add a final point at the last tick for every entity so lines terminate
    // cleanly even if their position hasn't changed in a while.
    const lastTick = allLapsOrdered.length;
    entityKeys.forEach(k => {
      const series = positionTimeline[k];
      const last = series[series.length - 1];
      if (last && last.x < lastTick) series.push({ x: lastTick, y: last.y });
    });

    const positionData = {};
    entityKeys.forEach(k => {
      const s = entityState[k];
      positionData[k] = { name: s.name, color: s.color, points: positionTimeline[k] };
    });

    // ── Advanced stats por entidad (race-wide) ────────────────────────────
    // Repite el cálculo de LiveStatsController.buildEntityStats pero a nivel
    // de carrera completa (no de una manga), y añade evolución por manga.
    const advancedLaps = db.prepare(`
      SELECT l.team_id, l.driver_id, l.manga_id,
             l.lap_time_ms, l.elapsed_ms, l.is_exit, l.is_pit_stop, l.is_ghost,
             m.number AS manga_number
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND l.is_ghost = 0
      ORDER BY t.number ASC, m.number ASC, l.elapsed_ms ASC
    `).all(race.id);

    const advByEntity = new Map();
    results.forEach(r => {
      advByEntity.set(`${r.entity_type}_${r.entity_id}`, {
        key:    `${r.entity_type}_${r.entity_id}`,
        name:   r.entity_name,
        color:  r.color,
        mangas: new Map(),   // mangaNumber -> [laps]
        all:    [],
      });
    });
    advancedLaps.forEach(l => {
      const key = l.team_id ? `team_${l.team_id}` : `driver_${l.driver_id}`;
      const e = advByEntity.get(key);
      if (!e) return;
      e.all.push(l);
      if (!e.mangas.has(l.manga_number)) e.mangas.set(l.manga_number, []);
      e.mangas.get(l.manga_number).push(l);
    });

    function stats(laps) {
      const racing = laps;
      const clean  = racing.filter(l => !l.is_exit);
      const exits  = racing.filter(l => !!l.is_exit);
      const sum  = a => a.reduce((s,l) => s + l.lap_time_ms, 0);
      const min  = a => a.length ? Math.min(...a.map(l => l.lap_time_ms)) : null;
      const avg  = a => a.length ? Math.round(sum(a) / a.length) : null;
      const bestMs   = min(clean);
      const avgAll   = avg(racing);
      const avgClean = avg(clean);
      const ref      = avgClean ?? avgAll ?? 0;
      let lostMs = 0;
      for (const l of exits) { const o = l.lap_time_ms - ref; if (o > 0) lostMs += o; }
      return {
        totalLaps:    racing.length,
        cleanLaps:    clean.length,
        exitCount:    exits.filter(l => !l.is_pit_stop).length,
        pitStopCount: exits.filter(l => l.is_pit_stop).length,
        bestMs, avgAll, avgClean,
        deltaAll:   (bestMs && avgAll  ) ? avgAll   - bestMs : null,
        deltaClean: (bestMs && avgClean) ? avgClean - bestMs : null,
        lostMs,
        lostLapsEquiv: ref > 0 ? +(lostMs / ref).toFixed(2) : 0,
      };
    }

    const advancedStats = [...advByEntity.values()].map(e => {
      const s = stats(e.all);
      const perManga = [...e.mangas.entries()]
        .sort((a,b) => a[0] - b[0])
        .map(([mn, laps]) => ({ manga: mn, ...stats(laps) }));
      return { key: e.key, entityName: e.name, color: e.color, ...s, perManga };
    });

    res.render('races/results', {
      t: req.t, race, results, laneSequence, tandas, LANE_COLORS,
      raceBestLapMs, raceBestEntity, raceBestLane, startLaneByEntity,
      progressionByEntity, positionData,
      totalLapEvents: allLapsOrdered.length,
      advancedStats,
      publicView: !!req._publicResults,
    });
  }

  // ── Resultados públicos ────────────────────────────────────────────────────
  // GET /results — landing pública: lista de carreras finalizadas.
  static resultsIndex(req, res) {
    const lang  = req.session?.lang || 'es';
    const races = Race.findAll()
      .filter(r => r.status === 'finished')
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.render('races/results-index', { t: req.t, lang, races });
  }

  // GET /results/:id — resultados públicos de una carrera (misma vista que
  // /races/:id/results pero sin la sección de corrección de vueltas).
  static publicResults(req, res) {
    req._publicResults = true;
    return SessionController.results(req, res);
  }

  // GET /races/:id/results/xlsx
  static async excel(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const aggregate = Lap.aggregateByRace(race.id);
    const isEs      = (req.query.lang || 'es') === 'es';

    const fmtMs = (ms) => {
      if (ms == null) return '';
      const s = Math.floor(ms / 1000);
      const h = Math.floor((ms % 1000) / 10);
      const m = Math.floor(s / 60);
      return (m > 0 ? m + ':' : '') + String(s % 60).padStart(m > 0 ? 2 : 1, '0') + '.' + String(h).padStart(2,'0');
    };
    const fmtSec = (ms) => ms == null ? '' : (ms / 1000).toFixed(3).replace('.', ',');

    // ── Style palette ────────────────────────────────────────────────────────
    const COL = {
      header:    'FF161B22',   // dark slate
      headerFg:  'FFFFFFFF',
      gold:      'FFFBBF24',
      silver:    'FFD1D5DB',
      bronze:    'FFD97706',
      best:      'FF7EE787',   // green for fastest cells
      worstBg:   'FFFFF1F0',
      raceBest:  'FFFEF3C7',   // highlight for global fastest
      band:      'FFF6F8FA',
      rowTotal:  'FFEEF1F4',   // light gray — entity total row
      rowBest:   'FFE7F8EC',   // light green — fastest row
      rowAvg:    'FFFFFBE6',   // light yellow — average row
      rowExits:  'FFFDECEC',   // light red — exits row
      muted:     'FF6E7681',
      exit:      'FFF85149',
      border:    'FFD0D7DE',
    };
    const thinBorder = {
      top:    { style: 'thin', color: { argb: COL.border } },
      left:   { style: 'thin', color: { argb: COL.border } },
      bottom: { style: 'thin', color: { argb: COL.border } },
      right:  { style: 'thin', color: { argb: COL.border } },
    };
    const fillSolid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const headerStyle = {
      font: { bold: true, color: { argb: COL.headerFg }, size: 11 },
      fill: fillSolid(COL.header),
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: thinBorder,
    };
    const podiumFill = (pos) => pos === 1 ? fillSolid(COL.gold) : pos === 2 ? fillSolid(COL.silver) : pos === 3 ? fillSolid(COL.bronze) : null;
    const applyBorder = (ws, range) => {
      ws.getCell(range).border = thinBorder;
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SloTime';
    wb.created = new Date();

    // Date shown in header: prefer finished_at, fall back to started_at, then created_at
    const raceDateRaw = race.finished_at || race.started_at || race.created_at;
    const raceDate = raceDateRaw ? new Date(raceDateRaw) : null;
    const raceDateStr = raceDate
      ? raceDate.toLocaleString(isEs ? 'es-ES' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const titleLabel = isEs ? 'Carrera' : 'Race';
    const dateLabel  = isEs ? 'Fecha'   : 'Date';

    // Adds 2 header rows (title + date) to a sheet across `cols` columns
    function addRaceHeader(ws, cols) {
      const r1 = ws.addRow([`🏁 ${race.name}`]);
      r1.height = 24;
      ws.mergeCells(r1.number, 1, r1.number, cols);
      const c1 = r1.getCell(1);
      c1.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      c1.fill = fillSolid(COL.header);
      c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

      if (raceDateStr) {
        const r2 = ws.addRow([`${dateLabel}: ${raceDateStr}`]);
        r2.height = 18;
        ws.mergeCells(r2.number, 1, r2.number, cols);
        const c2 = r2.getCell(1);
        c2.font = { italic: true, size: 10, color: { argb: COL.muted } };
        c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      }
      ws.addRow([]);
    }

    // ── Sheet 1 — Clasificación ─────────────────────────────────────────────
    const byTotal = [...aggregate].sort((a,b) => b.total_laps - a.total_laps || (a.best_lap_ms||Infinity)-(b.best_lap_ms||Infinity));
    const s1 = wb.addWorksheet(isEs ? 'Clasificación' : 'Standings');
    s1.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }];
    addRaceHeader(s1, 6);
    const s1Header = s1.addRow(['#', isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Total vueltas' : 'Total laps', isEs ? 'Mejor vuelta' : 'Best lap', isEs ? 'Vuelta media' : 'Avg lap', isEs ? 'Mangas' : 'Heats']);
    s1Header.height = 22;
    s1Header.eachCell(c => Object.assign(c, headerStyle));
    s1.views = [{ state: 'frozen', ySplit: s1Header.number }];
    byTotal.forEach((r, i) => {
      const row = s1.addRow([i+1, r.entity_name, r.total_laps, fmtMs(r.best_lap_ms), fmtMs(Math.round(r.avg_lap_ms)), r.mangas_raced]);
      const fill = podiumFill(i+1);
      row.eachCell(c => {
        c.border = thinBorder;
        if (fill) c.fill = fill;
        if (fill && i < 3) c.font = { bold: true };
      });
      row.getCell(3).font = { bold: true };
      if (i % 2 === 1 && !fill) row.eachCell(c => c.fill = fillSolid(COL.band));
    });

    // ── Sheet 2 — Mejor vuelta ──────────────────────────────────────────────
    const byBest = [...aggregate].filter(r => r.best_lap_ms).sort((a,b) => a.best_lap_ms - b.best_lap_ms);
    const s2 = wb.addWorksheet(isEs ? 'Mejor vuelta' : 'Best lap');
    s2.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }];
    addRaceHeader(s2, 4);
    const s2Header = s2.addRow(['#', isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Mejor vuelta' : 'Best lap', isEs ? 'Total vueltas' : 'Total laps']);
    s2Header.height = 22;
    s2Header.eachCell(c => Object.assign(c, headerStyle));
    s2.views = [{ state: 'frozen', ySplit: s2Header.number }];
    byBest.forEach((r, i) => {
      const row = s2.addRow([i+1, r.entity_name, fmtMs(r.best_lap_ms), r.total_laps]);
      const fill = podiumFill(i+1);
      row.eachCell(c => {
        c.border = thinBorder;
        if (fill) c.fill = fill;
        if (fill) c.font = { bold: true };
      });
      row.getCell(3).font = { bold: true, color: { argb: 'FF1A7F37' } };
      if (i % 2 === 1 && !fill) row.eachCell(c => c.fill = fillSolid(COL.band));
    });

    // ── Sheet 3 — Por carril ────────────────────────────────────────────────
    const s3 = wb.addWorksheet(isEs ? 'Por carril' : 'Per lane');
    s3.columns = [{ width: 30 }, { width: 8 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 10 }];
    addRaceHeader(s3, 6);
    const s3Header = s3.addRow([isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Carril' : 'Lane', isEs ? 'Vueltas' : 'Laps', isEs ? 'Mejor' : 'Best', isEs ? 'Media' : 'Avg', isEs ? 'Salidas' : 'Exits']);
    s3Header.height = 22;
    s3Header.eachCell(c => Object.assign(c, headerStyle));
    s3.views = [{ state: 'frozen', ySplit: s3Header.number }];
    aggregate.forEach(r => {
      const perLane = Lap.perLaneByEntity(race.id, r.entity_id, r.entity_type);
      perLane.forEach(pl => {
        const row = s3.addRow([r.entity_name, pl.lane, pl.laps, fmtMs(pl.best_ms), fmtMs(Math.round(pl.avg_ms)), pl.exit_count || 0]);
        row.eachCell(c => c.border = thinBorder);
        row.getCell(4).font = { color: { argb: 'FF1A7F37' }, bold: true };
        if (pl.exit_count > 0) row.getCell(6).font = { color: { argb: COL.exit }, bold: true };
      });
    });

    // ── Sheet 4 — Comparativa (PDF style with colors) ───────────────────────
    const laneSeq = (Race.getLaneSequence(race) || []).filter(l => l > 0);
    const entityData = aggregate.map(r => ({
      ...r,
      perLane: Lap.perLaneByEntity(race.id, r.entity_id, r.entity_type)
    }));
    let raceBestLapMs = null, raceBestEntity = null, raceBestLane = null;
    for (const r of entityData) {
      for (const pl of r.perLane) {
        if (pl.best_ms != null && (raceBestLapMs == null || pl.best_ms < raceBestLapMs)) {
          raceBestLapMs = pl.best_ms; raceBestEntity = r.entity_name; raceBestLane = pl.lane;
        }
      }
    }
    const byTotalM = [...entityData].sort((a,b) => b.total_laps - a.total_laps || (a.best_lap_ms||Infinity)-(b.best_lap_ms||Infinity));

    // Starting lane per entity — first non-rest assignment in tanda+manga order
    const db = require('../config/database');
    const startRows = db.prepare(`
      SELECT ml.lane, ml.team_id, ml.driver_id
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND ml.is_rest = 0
      ORDER BY t.number ASC, m.number ASC, ml.lane ASC
    `).all(race.id);
    const startLaneByEntity = {};
    startRows.forEach(r => {
      const key = r.team_id ? `team_${r.team_id}` : `driver_${r.driver_id}`;
      if (startLaneByEntity[key] == null) startLaneByEntity[key] = r.lane;
    });

    const s4 = wb.addWorksheet(isEs ? 'Comparativa' : 'Comparison', {
      properties: { outlineProperties: { summaryBelow: false, summaryRight: false } }
    });
    const numLaneCols = laneSeq.length;
    s4.columns = [
      { width: 5 },   // #
      { width: 28 },  // name / label
      { width: 12 },  // total / per-row value
      ...laneSeq.map(() => ({ width: 12 })),
    ];
    addRaceHeader(s4, 3 + numLaneCols);

    // Banner row
    if (raceBestLapMs != null) {
      s4.addRow([`⚡ ${isEs ? 'Vuelta rápida de la carrera' : 'Race fastest lap'}`,
                 `${fmtSec(raceBestLapMs)}s — ${raceBestEntity} (${isEs ? 'Pista' : 'Lane'} ${raceBestLane})`]);
      const r = s4.lastRow;
      r.height = 26;
      r.eachCell(c => {
        c.fill = fillSolid(COL.gold);
        c.font = { bold: true, size: 12, color: { argb: 'FF1A1A1A' } };
        c.alignment = { vertical: 'middle' };
      });
      s4.mergeCells(r.number, 2, r.number, 3 + numLaneCols);
      s4.addRow([]);
    }

    // Header
    const headerRow = s4.addRow(['#', isEs ? 'Equipo / Piloto' : 'Team / Driver', isEs ? 'Vueltas' : 'Laps', ...laneSeq.map(l => `${isEs ? 'Pista' : 'Lane'} ${l}`)]);
    headerRow.height = 22;
    headerRow.eachCell(c => Object.assign(c, headerStyle));
    s4.views = [{ state: 'frozen', ySplit: headerRow.number }];

    const startLaneFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }; // light blue
    const startLaneBorder = {
      top:    { style: 'thin',   color: { argb: COL.border } },
      left:   { style: 'medium', color: { argb: 'FF58A6FF' } },
      bottom: { style: 'thin',   color: { argb: COL.border } },
      right:  { style: 'thin',   color: { argb: COL.border } },
    };

    byTotalM.forEach((r, i) => {
      const laneMap = new Map(r.perLane.map(pl => [pl.lane, pl]));
      const totalExits = r.perLane.reduce((s,pl)=>s+(pl.exit_count||0),0);
      const totalPits  = r.perLane.reduce((s,pl)=>s+(pl.pit_stop_count||0),0);
      const startLane  = startLaneByEntity[`${r.entity_type}_${r.entity_id}`];
      const pos = i+1;
      const podium = podiumFill(pos);

      // Entity header row (light gray on lane cells)
      const nameDisplay = startLane ? `${r.entity_name}   🚦 P${startLane}` : r.entity_name;
      const rowA = s4.addRow([pos, nameDisplay, r.total_laps, ...laneSeq.map(l => laneMap.get(l)?.laps ?? '')]);
      rowA.height = 20;
      rowA.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.font = { bold: true, size: 11 };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = fillSolid(COL.rowTotal);
      });
      rowA.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
      if (podium) {
        rowA.getCell(1).fill = podium;
        rowA.getCell(2).fill = podium;
        rowA.getCell(3).fill = podium;
      }
      rowA.getCell(3).font = { bold: true, size: 12, color: { argb: pos === 1 ? 'FF8A6D00' : pos === 2 ? 'FF374151' : pos === 3 ? 'FFFFFFFF' : 'FF0969DA' } };

      // Mark the starting-lane cell on the entity header row
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) {
          const cell = rowA.getCell(4 + idx);
          cell.fill   = startLaneFill;
          cell.border = startLaneBorder;
        }
      }

      // Fastest row
      const fastestVals = laneSeq.map(l => {
        const pl = laneMap.get(l); return (pl && pl.best_ms != null) ? fmtSec(pl.best_ms) : '';
      });
      const rowB = s4.addRow(['', `⚡ ${isEs ? 'Vuelta rápida' : 'Fastest'}`, fmtSec(r.best_lap_ms), ...fastestVals]);
      rowB.outlineLevel = 1;
      rowB.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.font = { color: { argb: 'FF1A7F37' }, bold: true };
        c.alignment = { horizontal: 'center' };
        c.fill = fillSolid(COL.rowBest);
      });
      rowB.getCell(2).alignment = { horizontal: 'left' };
      rowB.getCell(2).font = { color: { argb: COL.muted }, italic: true };
      // Highlight race-best cell (overrides green row bg)
      laneSeq.forEach((l, idx) => {
        const pl = laneMap.get(l);
        if (pl && pl.best_ms != null && pl.best_ms === raceBestLapMs) {
          const cell = rowB.getCell(4 + idx);
          cell.fill = fillSolid(COL.raceBest);
          cell.font = { bold: true, color: { argb: 'FF8A6D00' }, size: 12 };
          cell.value = `${fmtSec(pl.best_ms)} ★`;
        }
      });
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowB.getCell(4 + idx).border = startLaneBorder;
      }

      // Average row
      const avgVals = laneSeq.map(l => {
        const pl = laneMap.get(l); return (pl && pl.avg_ms != null) ? fmtSec(Math.round(pl.avg_ms)) : '';
      });
      const rowC = s4.addRow(['', isEs ? 'Vuelta media' : 'Average', fmtSec(Math.round(r.avg_lap_ms)), ...avgVals]);
      rowC.outlineLevel = 1;
      rowC.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.fill = fillSolid(COL.rowAvg);
      });
      rowC.getCell(2).alignment = { horizontal: 'left' };
      rowC.getCell(2).font = { color: { argb: COL.muted }, italic: true };
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowC.getCell(4 + idx).border = startLaneBorder;
      }

      // Exits row
      const exitVals = laneSeq.map(l => {
        const pl = laneMap.get(l);
        if (!pl || pl.worst_ms == null) return '';
        return `(${pl.exit_count||0}) ${fmtSec(pl.worst_ms)}`;
      });
      const rowD = s4.addRow(['', `${isEs ? 'Salidas' : 'Exits'} (${totalExits})`, '', ...exitVals]);
      rowD.outlineLevel = 1;
      rowD.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { size: 10, color: { argb: COL.muted } };
        c.fill = fillSolid(COL.rowExits);
      });
      rowD.getCell(2).alignment = { horizontal: 'left' };
      rowD.getCell(2).font = { color: { argb: totalExits > 0 ? COL.exit : COL.muted }, italic: true, bold: totalExits > 0 };
      // Highlight cells with exits in red
      laneSeq.forEach((l, idx) => {
        const pl = laneMap.get(l);
        if (pl && pl.exit_count > 0) {
          const cell = rowD.getCell(4 + idx);
          cell.font = { size: 10, color: { argb: COL.exit }, bold: true };
        }
      });
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowD.getCell(4 + idx).border = startLaneBorder;
      }

      // Pit-stops row
      const pitVals = laneSeq.map(l => {
        const pl = laneMap.get(l);
        if (!pl || !pl.pit_stop_count) return '';
        const laps = pl.pit_stop_laps
          ? pl.pit_stop_laps.split(',').filter(Boolean).map(n => 'V' + n).join(', ')
          : '';
        return `(${pl.pit_stop_count}) ${laps}`;
      });
      const rowE = s4.addRow(['', `🔧 ${isEs ? 'Pit-stops' : 'Pit-stops'} (${totalPits})`, '', ...pitVals]);
      rowE.outlineLevel = 1;
      rowE.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { size: 10, color: { argb: COL.muted } };
        c.fill = fillSolid('FFFFF4E5'); // light orange
      });
      rowE.getCell(2).alignment = { horizontal: 'left' };
      rowE.getCell(2).font = { color: { argb: totalPits > 0 ? 'FFFF9800' : COL.muted }, italic: true, bold: totalPits > 0 };
      laneSeq.forEach((l, idx) => {
        const pl = laneMap.get(l);
        if (pl && pl.pit_stop_count > 0) {
          const cell = rowE.getCell(4 + idx);
          cell.font = { size: 10, color: { argb: 'FFFF9800' }, bold: true };
        }
      });
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowE.getCell(4 + idx).border = startLaneBorder;
      }

      // Spacer
      s4.addRow([]);
    });

    // ── One sheet per entity with lap-by-lap progression ───────────────────
    const progressionRows = db.prepare(`
      SELECT l.lane, l.lap_time_ms, l.team_id, l.driver_id, l.is_exit, l.is_pit_stop
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
      ORDER BY t.number ASC, m.number ASC, l.lane ASC, l.lap_number ASC
    `).all(race.id);
    const progByEntity = {};
    entityData.forEach(e => {
      progByEntity[`${e.entity_type}_${e.entity_id}`] = { name: e.entity_name, lanes: {}, laneAvg: {} };
    });
    progressionRows.forEach(row => {
      const key = row.team_id ? `team_${row.team_id}` : `driver_${row.driver_id}`;
      const e = progByEntity[key];
      if (!e) return;
      if (!e.lanes[row.lane]) e.lanes[row.lane] = [];
      e.lanes[row.lane].push({ ms: row.lap_time_ms, isExit: !!row.is_exit, isPitStop: !!row.is_pit_stop });
    });
    Object.values(progByEntity).forEach(e => {
      Object.entries(e.lanes).forEach(([lane, arr]) => {
        if (arr.length === 0) return;
        e.laneAvg[lane] = Math.round(arr.reduce((s,v)=>s+v.ms,0) / arr.length);
      });
    });

    // ── Chart renderer (PNG via Chart.js on server) ──────────────────────
    const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
    const LANE_DASH = [[], [8,4], [2,4], [12,3,2,3]];
    const ENTITY_PALETTE = ['#1F6FEB','#F6C90E','#2DA44E','#FB6A6B','#A371F7','#16BDCA','#F97316','#E63946','#FBBF24','#34D399'];
    async function renderProgressionChart({ width, height, entities, mode = 'abs' }) {
      // entities: [{ name, color, lanes: { laneNumber: [{ms, isExit, isPitStop}] } }]
      const datasets = [];
      entities.forEach((ent, ei) => {
        const color = ent.color || ENTITY_PALETTE[ei % ENTITY_PALETTE.length];
        const lanes = Object.keys(ent.lanes).map(Number).sort((a,b)=>a-b);
        lanes.forEach((lane, li) => {
          const laps = ent.lanes[lane];
          if (!laps || laps.length === 0) return;
          const avg = laps.reduce((s,l)=>s+l.ms,0) / laps.length;
          const points = laps.map((l, idx) => ({
            x: idx + 1,
            y: mode === 'abs' ? l.ms / 1000 : (l.ms - avg) / 1000
          }));
          const pointColors = laps.map(l =>
            l.isPitStop ? '#ff9800' :
            l.isExit    ? '#e63946' : color);
          const pointRadius = laps.map(l => (l.isPitStop || l.isExit) ? 5 : 2);
          datasets.push({
            label: (entities.length > 1 ? ent.name + ' · ' : '') + 'P' + lane,
            data: points,
            borderColor: color,
            backgroundColor: color + '22',
            borderDash: LANE_DASH[li % LANE_DASH.length],
            pointBackgroundColor: pointColors,
            pointBorderColor: pointColors,
            pointRadius, tension: 0.2, borderWidth: 2, fill: false,
          });
        });
      });
      const canvas = new ChartJSNodeCanvas({
        width, height,
        backgroundColour: '#FFFFFF',
        chartCallback: (ChartJS) => {
          ChartJS.defaults.font.family = 'Arial';
        },
      });
      return canvas.renderToBuffer({
        type: 'line',
        data: { datasets },
        options: {
          responsive: false, animation: false,
          plugins: {
            legend: { position: 'top', labels: { color: '#1F2328', font: { size: 11 } } },
            title: { display: true, color: '#1F2328',
              text: mode === 'abs' ? 'Tiempo absoluto por vuelta (s)' : 'Δ vs media de carril (s)' },
          },
          scales: {
            x: { type: 'linear', title: { display: true, text: 'Vuelta', color: '#57606A' },
                 ticks: { color: '#57606A', stepSize: 1 }, grid: { color: '#D8DEE4' } },
            y: { title: { display: true, color: '#57606A',
                  text: mode === 'abs' ? 'Segundos' : 'Δ (s)' },
                 ticks: { color: '#57606A' }, grid: { color: '#D8DEE4' } },
          },
        },
      }, 'image/png');
    }

    function sanitizeSheetName(name) {
      // Excel: max 31 chars, no \ / ? * [ ] :
      let n = String(name).replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 28);
      return n.length ? n : 'Equipo';
    }
    const usedNames = new Set();
    for (let idx = 0; idx < byTotalM.length; idx++) {
      const entity = byTotalM[idx];
      const key = `${entity.entity_type}_${entity.entity_id}`;
      const prog = progByEntity[key];
      if (!prog) continue;
      const lanes = Object.keys(prog.lanes).map(Number).sort((a,b)=>a-b);
      if (lanes.length === 0) continue;

      let base = sanitizeSheetName((idx+1).toString().padStart(2,'0') + '_' + entity.entity_name);
      let nm = base, i = 2;
      while (usedNames.has(nm)) { nm = base.slice(0, 26) + '_' + (i++); }
      usedNames.add(nm);

      const sE = wb.addWorksheet(nm);
      sE.columns = [{ width: 8 }, ...lanes.map(() => ({ width: 14 }))];
      addRaceHeader(sE, 1 + lanes.length);

      // Title row for entity
      const tRow = sE.addRow([`${idx+1}. ${entity.entity_name}`]);
      tRow.height = 22;
      sE.mergeCells(tRow.number, 1, tRow.number, 1 + lanes.length);
      const tc = tRow.getCell(1);
      tc.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      tc.fill = fillSolid(COL.header);
      tc.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      sE.addRow([]);

      // ── Section: Absolute times ─────────────────────────────────────────
      const absTitle = sE.addRow([isEs ? '⏱ Tiempo absoluto (s)' : '⏱ Absolute time (s)']);
      sE.mergeCells(absTitle.number, 1, absTitle.number, 1 + lanes.length);
      absTitle.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1F6FEB' } };
      absTitle.getCell(1).alignment = { vertical: 'middle', indent: 1 };

      const absHeader = sE.addRow([isEs ? 'Vuelta' : 'Lap', ...lanes.map(l => `${isEs ? 'Pista' : 'Lane'} ${l}`)]);
      absHeader.height = 20;
      absHeader.eachCell({ includeEmpty: true }, c => Object.assign(c, headerStyle));

      const maxLapCount = Math.max(...lanes.map(l => prog.lanes[l].length));
      const absStartRow = sE.lastRow.number + 1;
      for (let li = 0; li < maxLapCount; li++) {
        const values = [li + 1, ...lanes.map(l => {
          const lap = prog.lanes[l][li];
          return lap != null ? Number((lap.ms / 1000).toFixed(3)) : '';
        })];
        const row = sE.addRow(values);
        row.eachCell({ includeEmpty: true }, (c, colNum) => {
          c.border = thinBorder;
          c.alignment = { horizontal: 'center' };
          if (colNum === 1) {
            c.font = { color: { argb: COL.muted }, size: 10 };
            c.fill = fillSolid(COL.band);
          }
        });
        // Tint exit/pit-stop cells so they stand out in the absolute table
        lanes.forEach((l, ci) => {
          const lap = prog.lanes[l][li];
          if (!lap) return;
          const c = row.getCell(2 + ci);
          if (lap.isPitStop) {
            c.font = { bold: true, color: { argb: 'FFFF9800' } };
            c.fill = fillSolid('FFFFF4E5');
          } else if (lap.isExit) {
            c.font = { bold: true, color: { argb: COL.exit } };
            c.fill = fillSolid('FFFDECEC');
          } else if (li % 2 === 1) {
            c.fill = fillSolid(COL.band);
          }
        });
      }

      // Avg row at the bottom of absolute section
      const avgRow = sE.addRow([isEs ? 'Media' : 'Avg', ...lanes.map(l => {
        const v = prog.laneAvg[l];
        return v != null ? Number((v / 1000).toFixed(3)) : '';
      })]);
      avgRow.eachCell({ includeEmpty: true }, (c, colNum) => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { bold: true, color: { argb: 'FF8A6D00' } };
        c.fill = fillSolid(COL.rowAvg);
      });

      sE.addRow([]);

      // ── Section: Delta vs lane average ─────────────────────────────────
      const dTitle = sE.addRow([isEs ? 'Δ Delta vs media de carril (s)' : 'Δ Delta vs lane avg (s)']);
      sE.mergeCells(dTitle.number, 1, dTitle.number, 1 + lanes.length);
      dTitle.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1F6FEB' } };
      dTitle.getCell(1).alignment = { vertical: 'middle', indent: 1 };

      const dHeader = sE.addRow([isEs ? 'Vuelta' : 'Lap', ...lanes.map(l => `${isEs ? 'Pista' : 'Lane'} ${l}`)]);
      dHeader.height = 20;
      dHeader.eachCell({ includeEmpty: true }, c => Object.assign(c, headerStyle));

      for (let li = 0; li < maxLapCount; li++) {
        const values = [li + 1, ...lanes.map(l => {
          const lap = prog.lanes[l][li];
          if (lap == null) return '';
          const avg = prog.laneAvg[l] || 0;
          return Number(((lap.ms - avg) / 1000).toFixed(3));
        })];
        const row = sE.addRow(values);
        row.eachCell({ includeEmpty: true }, (c, colNum) => {
          c.border = thinBorder;
          c.alignment = { horizontal: 'center' };
          if (colNum === 1) {
            c.font = { color: { argb: COL.muted }, size: 10 };
            c.fill = fillSolid(COL.band);
          } else if (typeof c.value === 'number') {
            if (c.value < -0.05) {
              c.font = { bold: true, color: { argb: 'FF1A7F37' } };
              c.fill = fillSolid('FFE7F8EC');
            } else if (c.value > 0.05) {
              c.font = { bold: true, color: { argb: COL.exit } };
              c.fill = fillSolid('FFFDECEC');
            }
          }
        });
      }

      // ── Embedded chart (absolute time) at the right of the tables ──────
      try {
        const chartPng = await renderProgressionChart({
          width: 900, height: 500, mode: 'abs',
          entities: [{ name: entity.entity_name, color: entity.color, lanes: prog.lanes }],
        });
        const imgId = wb.addImage({ buffer: chartPng, extension: 'png' });
        const startRow = absStartRow - 2; // anchor above the absolute table
        const startCol = 2 + lanes.length; // first empty column to the right
        sE.addImage(imgId, {
          tl: { col: startCol, row: startRow },
          ext: { width: 900, height: 500 },
        });
        const chartPngDelta = await renderProgressionChart({
          width: 900, height: 500, mode: 'delta',
          entities: [{ name: entity.entity_name, color: entity.color, lanes: prog.lanes }],
        });
        const imgIdD = wb.addImage({ buffer: chartPngDelta, extension: 'png' });
        sE.addImage(imgIdD, {
          tl: { col: startCol, row: startRow + 28 },
          ext: { width: 900, height: 500 },
        });
      } catch (err) {
        console.error('[results.xlsx] chart render error:', err.message);
      }
    }

    // ── Final sheet: multi-entity comparison chart ──────────────────────────
    try {
      const top = byTotalM.slice(0, 6).map(e => ({
        name: e.entity_name,
        color: e.color,
        lanes: progByEntity[`${e.entity_type}_${e.entity_id}`]?.lanes || {},
      })).filter(e => Object.keys(e.lanes).length > 0);
      if (top.length > 0) {
        const sC = wb.addWorksheet(isEs ? '📊 Comparativa gráfica' : '📊 Chart comparison');
        sC.columns = [{ width: 2 }];
        addRaceHeader(sC, 16);
        const t = sC.addRow([isEs ? 'Top 6 — Tiempo absoluto por vuelta' : 'Top 6 — Absolute time per lap']);
        sC.mergeCells(t.number, 1, t.number, 16);
        t.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF1F6FEB' } };
        const png1 = await renderProgressionChart({ width: 1400, height: 700, mode: 'abs', entities: top });
        const id1 = wb.addImage({ buffer: png1, extension: 'png' });
        sC.addImage(id1, { tl: { col: 0, row: t.number }, ext: { width: 1400, height: 700 } });

        const t2 = sC.getRow(t.number + 38);
        t2.getCell(1).value = isEs ? 'Top 6 — Δ vs media de carril' : 'Top 6 — Δ vs lane avg';
        sC.mergeCells(t2.number, 1, t2.number, 16);
        t2.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF1F6FEB' } };
        const png2 = await renderProgressionChart({ width: 1400, height: 700, mode: 'delta', entities: top });
        const id2 = wb.addImage({ buffer: png2, extension: 'png' });
        sC.addImage(id2, { tl: { col: 0, row: t2.number }, ext: { width: 1400, height: 700 } });
      }
    } catch (err) {
      console.error('[results.xlsx] comparison chart error:', err.message);
    }

    // ── Position timeline sheet ─────────────────────────────────────────────
    try {
      const allLapsOrdered = db.prepare(`
        SELECT l.team_id, l.driver_id, l.lap_time_ms
        FROM laps l
        JOIN mangas m ON m.id = l.manga_id
        JOIN tandas t ON t.id = m.tanda_id
        WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
        ORDER BY t.number ASC, m.number ASC, l.elapsed_ms ASC, l.id ASC
      `).all(race.id);
      const eKeys = entityData.map(r => `${r.entity_type}_${r.entity_id}`);
      const eState = {};
      entityData.forEach(r => {
        eState[`${r.entity_type}_${r.entity_id}`] = { totalLaps: 0, bestMs: null, name: r.entity_name, color: r.color };
      });
      const timeline = {};
      eKeys.forEach(k => { timeline[k] = []; });
      allLapsOrdered.forEach((lap, idx) => {
        const k = lap.team_id ? `team_${lap.team_id}` : `driver_${lap.driver_id}`;
        const s = eState[k];
        if (!s) return;
        s.totalLaps += 1;
        if (s.bestMs == null || lap.lap_time_ms < s.bestMs) s.bestMs = lap.lap_time_ms;
        const sorted = eKeys.map(key => ({ key, ...eState[key] }))
          .sort((a,b) => b.totalLaps - a.totalLaps || (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity));
        sorted.forEach((row, pi) => {
          const series = timeline[row.key];
          const last = series[series.length - 1];
          if (!last || last.y !== pi + 1) series.push({ x: idx + 1, y: pi + 1 });
        });
      });
      const lastTick = allLapsOrdered.length;
      eKeys.forEach(k => {
        const series = timeline[k];
        const last = series[series.length - 1];
        if (last && last.x < lastTick) series.push({ x: lastTick, y: last.y });
      });
      const datasets = eKeys.map((k, i) => {
        const s = eState[k];
        const color = s.color || ['#1F6FEB','#F6C90E','#2DA44E','#FB6A6B','#A371F7','#16BDCA','#F97316','#E63946','#FBBF24','#34D399'][i % 10];
        return {
          label: s.name,
          data: timeline[k],
          borderColor: color,
          backgroundColor: color + '22',
          tension: 0, stepped: 'before',
          pointRadius: 0, borderWidth: 2.5, fill: false,
        };
      });
      const canvasPos = new (require('chartjs-node-canvas').ChartJSNodeCanvas)({
        width: 1500, height: 800, backgroundColour: '#FFFFFF',
      });
      const png = await canvasPos.renderToBuffer({
        type: 'line',
        data: { datasets },
        options: {
          responsive: false, animation: false,
          plugins: {
            legend: { position: 'right', labels: { color: '#1F2328', font: { size: 11 } } },
            title: { display: true, color: '#1F2328', text: isEs ? 'Evolución de posiciones durante la carrera' : 'Position evolution through the race' },
          },
          scales: {
            x: { type: 'linear', title: { display: true, text: isEs ? 'Vueltas acumuladas' : 'Cumulative laps', color: '#57606A' },
                 ticks: { color: '#57606A' }, grid: { color: '#D8DEE4' } },
            y: { reverse: true, min: 1, max: eKeys.length,
                 title: { display: true, text: isEs ? 'Posición' : 'Position', color: '#57606A' },
                 ticks: { color: '#57606A', stepSize: 1, callback: (v) => 'P' + v },
                 grid: { color: '#D8DEE4' } },
          }
        }
      }, 'image/png');

      const sP = wb.addWorksheet(isEs ? '🏁 Posiciones' : '🏁 Positions');
      sP.columns = [{ width: 2 }];
      addRaceHeader(sP, 16);
      const tH = sP.addRow([isEs ? 'Evolución de posiciones' : 'Position evolution']);
      sP.mergeCells(tH.number, 1, tH.number, 16);
      tH.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF1F6FEB' } };
      const imgId = wb.addImage({ buffer: png, extension: 'png' });
      sP.addImage(imgId, { tl: { col: 0, row: tH.number }, ext: { width: 1500, height: 800 } });
    } catch (err) {
      console.error('[results.xlsx] positions chart error:', err.message);
    }

    const buf = await wb.xlsx.writeBuffer();
    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_resultados.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  }

  // ── Puntos de clasificación ─────────────────────────────────────────────
  // Tabla fija (pos 1..64). Posiciones por encima de 64 → 0 puntos.
  static _pointsFor(position) {
    const T = SessionController._POINTS_TABLE;
    if (position < 1 || position > T.length) return 0;
    return T[position - 1];
  }

  // GET /races/:id/results/points.xlsx
  static async pointsExcel(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const isEs = (req.query.lang || 'es') === 'es';
    const rows = SessionController._buildPointsRanking(race.id);

    const fmtMs = (ms) => {
      if (ms == null) return '';
      const s = Math.floor(ms / 1000);
      const h = Math.floor((ms % 1000) / 10);
      const m = Math.floor(s / 60);
      return (m > 0 ? m + ':' : '') + String(s % 60).padStart(m > 0 ? 2 : 1, '0') + '.' + String(h).padStart(2,'0');
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SloTime';
    wb.created = new Date();
    const ws = wb.addWorksheet(isEs ? 'Puntos' : 'Points');
    ws.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 12 }];

    const hdr = ws.addRow(['#', isEs ? 'Piloto / Equipo' : 'Driver / Team',
                           isEs ? 'Total vueltas' : 'Total laps',
                           isEs ? 'Mejor vuelta'  : 'Best lap',
                           isEs ? 'Vuelta media'  : 'Avg lap',
                           isEs ? 'Mangas'        : 'Heats',
                           isEs ? 'Puntos'        : 'Points']);
    hdr.height = 22;
    hdr.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF161B22' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    ws.views = [{ state: 'frozen', ySplit: hdr.number }];

    const podium = (p) => p === 1 ? 'FFFBBF24' : p === 2 ? 'FFD1D5DB' : p === 3 ? 'FFD97706' : null;
    rows.forEach((r, i) => {
      const row = ws.addRow([r.position, r.entity_name, r.total_laps, fmtMs(r.best_lap_ms),
                             fmtMs(Math.round(r.avg_lap_ms || 0)), r.mangas_raced, r.points]);
      const fill = podium(r.position);
      row.eachCell(c => {
        if (fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      });
      row.getCell(7).font = { bold: true };
    });

    const buf = await wb.xlsx.writeBuffer();
    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_puntos.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  }

  // GET /races/:id/results/points.csv
  static pointsCsv(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const isEs = (req.query.lang || 'es') === 'es';
    const rows = SessionController._buildPointsRanking(race.id);

    const head = isEs
      ? ['Posicion','Piloto/Equipo','TotalVueltas','MejorVueltaMs','VueltaMediaMs','Mangas','Puntos']
      : ['Position','DriverTeam','TotalLaps','BestLapMs','AvgLapMs','Heats','Points'];

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(';')];
    for (const r of rows) {
      lines.push([
        r.position, r.entity_name, r.total_laps,
        r.best_lap_ms ?? '', r.avg_lap_ms != null ? Math.round(r.avg_lap_ms) : '',
        r.mangas_raced, r.points,
      ].map(esc).join(';'));
    }

    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_puntos.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // BOM para que Excel detecte UTF-8 al abrir el CSV directamente
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }

  static _buildPointsRanking(raceId) {
    const aggregate = Lap.aggregateByRace(raceId);
    const sorted = [...aggregate].sort((a, b) =>
      b.total_laps - a.total_laps
      || (a.best_lap_ms || Infinity) - (b.best_lap_ms || Infinity));
    return sorted.map((r, i) => ({
      ...r,
      position: i + 1,
      points:   SessionController._pointsFor(i + 1),
    }));
  }

  // POST /races/:id/mangas/:mangaId/checkin
  // Body: { qr_code } or { driver_id, lane, force? } (manual override)
  //
  // Reglas (solo carreras de tipo 'championship'):
  //   1. Si manga.status === 'pending' (standby) → PRE-ARME: crea el shift
  //      con pre_armed=1, started_at_ms=null. Se activará al GO.
  //   2. Si manga.status === 'active' Y TimingService la gestiona Y running:
  //      → SWAP en runtime. Verifica lockout (últimos N ms bloqueados).
  //   3. Si manga.status === 'active' Y TimingService.isPaused:
  //      → SWAP permitido (sin lockout). El contador no avanza hasta resume.
  //   4. Si manga.status === 'finished'/'cancelled' → rechazo.
  static driverCheckin(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).json({ error: 'not_found' });
    if (race.type !== 'championship') return res.status(400).json({ error: 'not_championship_race' });
    if (race.format !== 'team') return res.status(400).json({ error: 'not_team_race' });

    const db = require('../config/database');

    // ── Validar estado de la manga para aceptar el scan ────────────────
    const mangaStatus = manga.status;
    let mode = null;        // 'pre_arm' | 'swap_running' | 'swap_paused'
    let remainingMs = null;

    if (mangaStatus === 'pending') {
      mode = 'pre_arm';
    } else if (mangaStatus === 'active') {
      const tsRunsThisManga = TimingService.activeMangaId === manga.id;
      if (!tsRunsThisManga) {
        return res.status(409).json({ error: 'manga_active_but_not_timing' });
      }
      if (TimingService.isRunning) {
        remainingMs = TimingService.getRemainingMs();
        const lockoutMs = race.driver_change_lockout_ms || 120000;
        const forceOverride = req.body.qr_code ? false : !!req.body.force;
        if (remainingMs != null && remainingMs <= lockoutMs && !forceOverride) {
          return res.status(409).json({
            error: 'change_locked_final_minutes',
            remainingMs,
            lockoutMs,
          });
        }
        mode = 'swap_running';
      } else if (TimingService.isPaused) {
        mode = 'swap_paused';
      } else {
        return res.status(409).json({ error: 'manga_active_but_not_running' });
      }
    } else {
      return res.status(409).json({ error: 'manga_status_invalid', status: mangaStatus });
    }

    // ── Resolver piloto + carril ────────────────────────────────────────
    let assignment = null;
    let profileName = null;

    if (req.body.qr_code) {
      const qr = (req.body.qr_code || '').trim();
      const profile = db.prepare('SELECT * FROM driver_profiles WHERE qr_code = ?').get(qr);
      if (!profile) return res.status(404).json({ error: 'unknown_qr', qr });
      profileName = profile.name;

      const assignments = DriverShift.findAssignmentsByProfile(profile.id, manga.id);
      if (assignments.length === 0) {
        return res.status(404).json({ error: 'driver_not_in_manga', name: profile.name });
      }
      if (assignments.length > 1) {
        // Caso raro: piloto en varios equipos del catálogo que coinciden
        // con equipos diferentes en esta manga → ambigüedad. El staff
        // debe usar override manual (driver_id + lane).
        return res.status(409).json({
          error: 'ambiguous_team',
          name: profile.name,
          candidates: assignments.map(a => ({ lane: a.lane, teamId: a.team_id })),
        });
      }
      assignment = assignments[0];
    } else {
      // Override manual
      const lane     = parseInt(req.body.lane, 10);
      const driverId = parseInt(req.body.driver_id, 10);
      if (!lane || !driverId) return res.status(400).json({ error: 'missing_params' });

      const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
      if (!driver) return res.status(404).json({ error: 'driver_not_found' });
      assignment = {
        lane,
        team_id: driver.team_id,
        driver_id: driver.id,
        driver_name: driver.name,
      };
      profileName = driver.name;
    }

    // ── Aplicar el cambio según el modo ────────────────────────────────
    let shiftId = null;

    if (mode === 'pre_arm') {
      // Cierra cualquier shift pre-armado previo para este carril
      // (el equipo cambió de idea antes del GO).
      const prev = DriverShift.findOpenByLane(manga.id, assignment.lane);
      if (prev) {
        DriverShift.closeShift(prev.id, Date.now(), prev.driving_ms || 0);
      }
      shiftId = DriverShift.openShift({
        mangaId:    manga.id,
        raceId:     race.id,
        lane:       assignment.lane,
        teamId:     assignment.team_id,
        driverId:   assignment.driver_id,
        driverName: assignment.driver_name,
        preArmed:   true,
      });
    } else if (mode === 'swap_running') {
      shiftId = TimingService.swapDriverOnLane({
        lane:       assignment.lane,
        raceId:     race.id,
        mangaId:    manga.id,
        teamId:     assignment.team_id,
        driverId:   assignment.driver_id,
        driverName: assignment.driver_name,
      });
    } else if (mode === 'swap_paused') {
      // Manga pausada: cierra el shift abierto (driving_ms se quedó al
      // valor actual en BD desde el último persist en pauseManga) y abre
      // uno nuevo. El nuevo no avanza hasta el resume.
      const prev = DriverShift.findOpenByLane(manga.id, assignment.lane);
      if (prev) DriverShift.closeShift(prev.id, Date.now(), prev.driving_ms || 0);
      shiftId = DriverShift.openShift({
        mangaId:    manga.id,
        raceId:     race.id,
        lane:       assignment.lane,
        teamId:     assignment.team_id,
        driverId:   assignment.driver_id,
        driverName: assignment.driver_name,
        startedAtMs: Date.now(),
        preArmed:   false,
      });
      // Actualizar el mapa en memoria del TimingService para que al
      // reanudar incremente el shift correcto.
      TimingService._activeShiftsByLane && (TimingService._activeShiftsByLane[assignment.lane] = { shiftId, drivingMs: 0 });
    }

    SocketService.emit('driver_checkin', {
      mangaId:    manga.id,
      lane:       assignment.lane,
      driverName: assignment.driver_name,
      driverId:   assignment.driver_id,
      teamId:     assignment.team_id,
      mode,
    });

    return res.json({
      ok: true,
      mode,
      lane: assignment.lane,
      driverName: assignment.driver_name,
      shiftId,
    });
  }

  // ── Activate next tanda: register its first manga for DS-300 GO ──────────────
  static activateNextTanda(req, res) {
    const raceId  = parseInt(req.params.id, 10);
    const tandaId = parseInt(req.params.tandaId, 10);

    const race  = Race.findById(raceId);
    const tanda = Tanda.findById(tandaId);
    if (!race || !tanda) return res.status(404).json({ error: 'Not found' });

    const nextTanda = Tanda.findNextPending(raceId, tanda.number);
    if (!nextTanda) return res.status(404).json({ error: 'No next tanda' });

    const manga = Manga.nextPending(nextTanda.id);
    if (!manga) return res.status(404).json({ error: 'No pending manga in next tanda' });

    const lanes   = Manga.getLanes(manga.id);
    const teams   = Team.findByTanda(nextTanda.id);
    const drivers = Driver.findByTanda(nextTanda.id);

    TimingService.setPendingManga(manga, race, lanes, teams, drivers);
    TimingService._tandaBoundary = false;

    return res.json({ ok: true, mangaId: manga.id, tandaId: nextTanda.id, tandaNumber: nextTanda.number });
  }
}

// Tabla de puntos por posición final (1..64). Posiciones 53-64 = 1 pt; >64 = 0.
SessionController._POINTS_TABLE = [
  70,64,59,55,52,50,48,46,44,43,42,41,40,39,38,37,36,35,34,33,
  32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,
  12,11,10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
   1, 1, 1, 1,
];

module.exports = SessionController;
