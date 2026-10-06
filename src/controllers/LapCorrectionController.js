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
const Race  = require('../models/Race');
const Manga = require('../models/Manga');
const Tanda = require('../models/Tanda');
const Lap   = require('../models/Lap');

const LaneColors = require('../services/LaneColors');

// Tras cada cambio: el motor rehace sus contadores y el directo se repinta ya.
function corrected(res, race, manga) {
  try { require('../services/TimingService').applyLapCorrection(race.id, manga.id); }
  catch (err) { console.error('[LapCorrection] refresco del directo:', err.message); }
  res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
}

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

    // Lista de mangas de la carrera para el selector (poder corregir una manga
    // pasada sin salir de la vista). Solo las que tienen datos: activas o
    // finalizadas (las 'pending' aún no tienen vueltas que corregir).
    const mangaOptions = [];
    Tanda.findByRace(race.id).forEach(tnd => {
      Manga.findByTanda(tnd.id).forEach(m => {
        if (m.status === 'pending') return;
        mangaOptions.push({ id: m.id, number: m.number, tandaNumber: tnd.number, status: m.status });
      });
    });

    res.render('races/lap-corrections', {
      t: req.t, race, manga, tanda, laneGroups, activeLanes, LANE_COLORS: LaneColors.forRace(race), mangaOptions
    });
  }

  // POST /races/:id/mangas/:mangaId/corrections/ghost/:lapId
  static markGhost(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    Lap.markGhost(parseInt(req.params.lapId));
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/restore/:lapId
  static restore(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    Lap.restore(parseInt(req.params.lapId));
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/transfer/:lapId
  static transfer(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const toLane = parseInt(req.body.to_lane);
    if (!toLane) return res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);

    Lap.transfer(parseInt(req.params.lapId), toLane, manga.id, race.id);
    corrected(res, race, manga);
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
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/delete/:lapId
  static deleteLap(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    Lap.deleteLap(parseInt(req.params.lapId));
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/edit/:lapId
  static editTime(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const lapTimeS = parseFloat(req.body.lap_time_s);
    if (!isNaN(lapTimeS) && lapTimeS > 0) {
      Lap.updateTime(parseInt(req.params.lapId), Math.round(lapTimeS * 1000));
      return corrected(res, race, manga);
    }
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }
}

module.exports = LapCorrectionController;
