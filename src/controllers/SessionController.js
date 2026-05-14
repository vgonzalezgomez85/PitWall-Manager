const Race           = require('../models/Race');
const Manga          = require('../models/Manga');
const Tanda          = require('../models/Tanda');
const Lap            = require('../models/Lap');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
const DriverShift    = require('../models/DriverShift');
const SocketService  = require('../services/SocketService');
const TimingService  = require('../services/TimingService');
const XLSX           = require('xlsx');

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

    res.render('races/live', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, prevLapsByLane, totalMangas, totalTandas, teamMembersByLane, activeDriversByLane, raceBestLaps, hasBestLaps, hasQrCheckin, nextTanda, allParticipants });
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

    const tandasRaw = Tanda.findByRace(race.id);
    const tandas = tandasRaw.map(t => ({
      ...t,
      mangas: Manga.findByTanda(t.id)
    }));

    res.render('races/results', { t: req.t, race, results, laneSequence, tandas, LANE_COLORS });
  }

  // GET /races/:id/results/xlsx
  static excel(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const aggregate = Lap.aggregateByRace(race.id);
    const isEs      = (req.query.lang || 'es') === 'es';

    function fmtMs(ms) {
      if (ms == null) return '';
      const s = Math.floor(ms / 1000);
      const h = Math.floor((ms % 1000) / 10);
      const m = Math.floor(s / 60);
      return (m > 0 ? m + ':' : '') + String(s % 60).padStart(m > 0 ? 2 : 1, '0') + '.' + String(h).padStart(2,'0');
    }

    // Sheet 1 — total laps ranking
    const byTotal = [...aggregate].sort((a,b) => b.total_laps - a.total_laps || (a.best_lap_ms||Infinity)-(b.best_lap_ms||Infinity));
    const sheet1 = XLSX.utils.aoa_to_sheet([
      ['#', isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Total vueltas' : 'Total laps', isEs ? 'Mejor vuelta' : 'Best lap', isEs ? 'Vuelta media' : 'Avg lap', isEs ? 'Mangas' : 'Heats'],
      ...byTotal.map((r, i) => [i+1, r.entity_name, r.total_laps, fmtMs(r.best_lap_ms), fmtMs(Math.round(r.avg_lap_ms)), r.mangas_raced])
    ]);

    // Sheet 2 — best lap ranking
    const byBest = [...aggregate].filter(r => r.best_lap_ms).sort((a,b) => a.best_lap_ms - b.best_lap_ms);
    const sheet2 = XLSX.utils.aoa_to_sheet([
      ['#', isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Mejor vuelta' : 'Best lap', isEs ? 'Total vueltas' : 'Total laps'],
      ...byBest.map((r, i) => [i+1, r.entity_name, fmtMs(r.best_lap_ms), r.total_laps])
    ]);

    // Sheet 3 — per-lane breakdown
    const perLaneRows = [
      [isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Carril' : 'Lane', isEs ? 'Vueltas' : 'Laps', isEs ? 'Mejor' : 'Best', isEs ? 'Media' : 'Avg', isEs ? 'Salidas' : 'Exits']
    ];
    aggregate.forEach(r => {
      const perLane = Lap.perLaneByEntity(race.id, r.entity_id, r.entity_type);
      perLane.forEach(pl => {
        perLaneRows.push([r.entity_name, pl.lane, pl.laps, fmtMs(pl.best_ms), fmtMs(Math.round(pl.avg_ms)), pl.exit_count || 0]);
      });
    });
    const sheet3 = XLSX.utils.aoa_to_sheet(perLaneRows);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet1, isEs ? 'Clasificación' : 'Standings');
    XLSX.utils.book_append_sheet(wb, sheet2, isEs ? 'Mejor vuelta' : 'Best lap');
    XLSX.utils.book_append_sheet(wb, sheet3, isEs ? 'Por carril' : 'Per lane');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_resultados.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
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
