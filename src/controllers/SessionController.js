const Race           = require('../models/Race');
const Manga          = require('../models/Manga');
const Tanda          = require('../models/Tanda');
const Lap            = require('../models/Lap');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
const DriverShift    = require('../models/DriverShift');
const SocketService  = require('../services/SocketService');
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

    TimingService.startManga(manga, race, lanes, teams, drivers);
    Tanda.updateStatus(tanda.id, 'active');
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
      TimingService.setPendingManga(manga, race, lanes, teams, drivers);
    }

    const totalMangas = Manga.findByTanda(manga.tanda_id).length;
    const totalTandas = Tanda.findByRace(race.id).length;

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

    res.render('races/live', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, prevLapsByLane, totalMangas, totalTandas, teamMembersByLane, activeDriversByLane, raceBestLaps, hasBestLaps, hasQrCheckin, nextTanda, allParticipants, nextLaneByLane, nextMangaInfo });
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

    res.render('races/live-panel', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, allParticipants });
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

    res.render('races/results', {
      t: req.t, race, results, laneSequence, tandas, LANE_COLORS,
      raceBestLapMs, raceBestEntity, raceBestLane
    });
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

    byTotalM.forEach((r, i) => {
      const laneMap = new Map(r.perLane.map(pl => [pl.lane, pl]));
      const totalExits = r.perLane.reduce((s,pl)=>s+(pl.exit_count||0),0);
      const pos = i+1;
      const podium = podiumFill(pos);

      // Entity header row (light gray on lane cells)
      const rowA = s4.addRow([pos, r.entity_name, r.total_laps, ...laneSeq.map(l => laneMap.get(l)?.laps ?? '')]);
      rowA.height = 20;
      rowA.eachCell(c => {
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

      // Fastest row
      const fastestVals = laneSeq.map(l => {
        const pl = laneMap.get(l); return (pl && pl.best_ms != null) ? fmtSec(pl.best_ms) : '';
      });
      const rowB = s4.addRow(['', `⚡ ${isEs ? 'Vuelta rápida' : 'Fastest'}`, fmtSec(r.best_lap_ms), ...fastestVals]);
      rowB.outlineLevel = 1;
      rowB.eachCell(c => {
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

      // Average row
      const avgVals = laneSeq.map(l => {
        const pl = laneMap.get(l); return (pl && pl.avg_ms != null) ? fmtSec(Math.round(pl.avg_ms)) : '';
      });
      const rowC = s4.addRow(['', isEs ? 'Vuelta media' : 'Average', fmtSec(Math.round(r.avg_lap_ms)), ...avgVals]);
      rowC.outlineLevel = 1;
      rowC.eachCell(c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.fill = fillSolid(COL.rowAvg);
      });
      rowC.getCell(2).alignment = { horizontal: 'left' };
      rowC.getCell(2).font = { color: { argb: COL.muted }, italic: true };

      // Exits row
      const exitVals = laneSeq.map(l => {
        const pl = laneMap.get(l);
        if (!pl || pl.worst_ms == null) return '';
        return `(${pl.exit_count||0}) ${fmtSec(pl.worst_ms)}`;
      });
      const rowD = s4.addRow(['', `${isEs ? 'Salidas' : 'Exits'} (${totalExits})`, '', ...exitVals]);
      rowD.outlineLevel = 1;
      rowD.eachCell(c => {
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

      // Spacer
      s4.addRow([]);
    });

    const buf = await wb.xlsx.writeBuffer();
    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_resultados.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  }
  // POST /races/:id/mangas/:mangaId/checkin
  // Body: { qr_code } or { driver_id, lane } (manual override)
  static driverCheckin(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).json({ error: 'not_found' });
    if (race.format !== 'team') return res.status(400).json({ error: 'not_team_race' });

    const db = require('../config/database');

    // ── QR scan path ────────────────────────────────────────────────────────
    if (req.body.qr_code) {
      const qr      = (req.body.qr_code || '').trim();
      const profile = db.prepare('SELECT * FROM driver_profiles WHERE qr_code = ?').get(qr);
      if (!profile) return res.status(404).json({ error: 'unknown_qr', qr });

      // Find the race driver linked to this profile in this tanda
      // Match by driver_id in teams_catalog_members → driver name in drivers table
      const assignment = db.prepare(`
        SELECT d.id AS driver_id, d.name AS driver_name, d.team_id,
               ml.lane
        FROM drivers d
        JOIN manga_lanes ml ON ml.team_id = d.team_id AND ml.manga_id = ? AND ml.is_rest = 0
        JOIN teams_catalog_members tcm ON tcm.driver_id = ? AND tcm.name = d.name
        LIMIT 1
      `).get(manga.id, profile.id);

      if (!assignment) return res.status(404).json({ error: 'driver_not_in_manga', name: profile.name });

      DriverShift.checkin({
        mangaId:    manga.id,
        raceId:     race.id,
        lane:       assignment.lane,
        teamId:     assignment.team_id,
        driverId:   assignment.driver_id,
        driverName: assignment.driver_name,
      });

      SocketService.emit('driver_checkin', {
        mangaId:    manga.id,
        lane:       assignment.lane,
        driverName: assignment.driver_name,
        driverId:   assignment.driver_id,
        teamId:     assignment.team_id,
      });

      return res.json({ ok: true, lane: assignment.lane, driverName: assignment.driver_name });
    }

    // ── Manual override path ─────────────────────────────────────────────────
    const lane     = parseInt(req.body.lane, 10);
    const driverId = parseInt(req.body.driver_id, 10);
    if (!lane || !driverId) return res.status(400).json({ error: 'missing_params' });

    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
    if (!driver) return res.status(404).json({ error: 'driver_not_found' });

    DriverShift.checkin({
      mangaId:    manga.id,
      raceId:     race.id,
      lane,
      teamId:     driver.team_id,
      driverId:   driver.id,
      driverName: driver.name,
    });

    SocketService.emit('driver_checkin', {
      mangaId:    manga.id,
      lane,
      driverName: driver.name,
      driverId:   driver.id,
      teamId:     driver.team_id,
    });

    return res.json({ ok: true, lane, driverName: driver.name });
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

module.exports = SessionController;
