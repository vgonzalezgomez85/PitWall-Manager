const Race           = require('../models/Race');
const Manga          = require('../models/Manga');
const Tanda          = require('../models/Tanda');
const Lap            = require('../models/Lap');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
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
    lanes.filter(l => !l.is_rest).forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    // Pre-register this manga so DS hardware GO button can start it
    if (manga.status === 'pending' && !TimingService.isRunning) {
      const teams   = Team.findByTanda(manga.tanda_id);
      const drivers = Driver.findByTanda(manga.tanda_id);
      TimingService.setPendingManga(manga, race, lanes, teams, drivers);
    }

    res.render('races/live', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, prevLapsByLane });
  }

  // GET /races/:id/mangas/:mangaId/panel/:type  (standalone popup)
  static panel(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const type = req.params.type;
    if (!['standings','projected','ticker'].includes(type)) {
      return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    }

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const laps     = Lap.findByManga(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;

    res.render('races/live-panel', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, type });
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
}

module.exports = SessionController;
