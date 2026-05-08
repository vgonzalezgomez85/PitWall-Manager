const Race  = require('../models/Race');
const Manga = require('../models/Manga');
const Tanda = require('../models/Tanda');
const Lap   = require('../models/Lap');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

class LapCorrectionController {

  // GET /races/:id/mangas/:mangaId/corrections
  static show(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda = Tanda.findById(manga.tanda_id);
    const lanes = Manga.getLanes(manga.id);
    const laps  = Lap.findByMangaAll(manga.id);

    const laneMap = {};
    lanes.filter(l => !l.is_rest).forEach(l => {
      laneMap[l.lane] = { info: l, laps: [] };
    });
    laps.forEach(lap => {
      if (laneMap[lap.lane]) laneMap[lap.lane].laps.push(lap);
    });
    const laneGroups  = Object.values(laneMap).sort((a, b) => a.info.lane - b.info.lane);
    const activeLanes = lanes.filter(l => !l.is_rest).map(l => l.lane).sort((a, b) => a - b);

    res.render('races/lap-corrections', {
      t: req.t, race, manga, tanda, laneGroups, activeLanes, LANE_COLORS
    });
  }

  // POST /races/:id/mangas/:mangaId/corrections/ghost/:lapId
  static markGhost(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    Lap.markGhost(parseInt(req.params.lapId));
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }

  // POST /races/:id/mangas/:mangaId/corrections/restore/:lapId
  static restore(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    Lap.restore(parseInt(req.params.lapId));
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }

  // POST /races/:id/mangas/:mangaId/corrections/transfer/:lapId
  static transfer(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const toLane = parseInt(req.body.to_lane);
    if (!toLane) return res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);

    Lap.transfer(parseInt(req.params.lapId), toLane, manga.id, race.id);
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }

  // POST /races/:id/mangas/:mangaId/corrections/add
  static addManual(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const lane     = parseInt(req.body.lane);
    const lapTimeS = parseFloat(req.body.lap_time_s);
    const count    = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 20);
    if (!lane || isNaN(lapTimeS) || lapTimeS <= 0) {
      return res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
    }

    const lapTimeMs = Math.round(lapTimeS * 1000);
    for (let i = 0; i < count; i++) {
      Lap.addManual({ mangaId: manga.id, raceId: race.id, lane, lapTimeMs });
    }
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }

  // POST /races/:id/mangas/:mangaId/corrections/delete/:lapId
  static deleteLap(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    Lap.deleteLap(parseInt(req.params.lapId));
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }
}

module.exports = LapCorrectionController;
