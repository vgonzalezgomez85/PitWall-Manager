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
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

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

    // ¿Esta manga es la última que corrió cada entidad? Solo entonces su coma
    // decide el desempate; en una anterior, corregirla solo cambia la suma de
    // referencia (Excel/Control) y la pantalla lo avisa.
    const lastManga = Lap._lastMangaByEntity(race.id);
    const decidesTie = {};
    laneGroups.forEach(g => {
      const k = g.info.team_id != null ? 'team:' + g.info.team_id : 'driver:' + g.info.driver_id;
      decidesTie[g.info.lane] = lastManga[k]?.mid === manga.id;
    });

    res.render('races/lap-corrections', {
      t: req.t, race, manga, tanda, laneGroups, activeLanes, LANE_COLORS: LaneColors.forRace(race), mangaOptions,
      // Corrección manual de la coma (Ajustes → Preferencias): el control solo
      // sale con el ajuste activo y la manga cerrada.
      manualComa: Lap.manualComaEnabled(),
      decidesTie,
    });
  }

  // POST /races/:id/mangas/:mangaId/corrections/coma
  // Fija (o borra, con el campo vacío) la coma manual de un carril. Solo mangas
  // cerradas: en una viva, TimingService.stopManga la reescribe al caer la bandera.
  static setComa(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

    const redirect = () => res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
    if (manga.race_id !== race.id) return redirect();   // URL de otra carrera: no tocar
    if (!Lap.manualComaEnabled() || manga.status !== 'finished') return redirect();

    const lane = parseInt(req.body.lane, 10);
    const laneRow = Manga.getLanes(manga.id).find(l => l.lane === lane && !l.is_rest);
    if (!laneRow) return redirect();

    const raw = String(req.body.coma ?? '').trim().replace(',', '.');
    let coma = null;
    if (raw !== '') {
      coma = Number(raw);
      if (!Number.isFinite(coma) || coma < 0 || coma > 0.99) return redirect();
      coma = +coma.toFixed(3);
    }

    // setLaneComa ya invalida las cachés por contador (la coma no vive en `laps`);
    // corrected() limpia las del motor y las del worker, y refresca el directo.
    Manga.setLaneComa(manga.id, lane, coma);
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/ghost/:lapId
  static markGhost(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

    Lap.markGhost(parseInt(req.params.lapId));
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/restore/:lapId
  static restore(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

    Lap.restore(parseInt(req.params.lapId));
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/transfer/:lapId
  static transfer(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

    const toLane = parseInt(req.body.to_lane);
    if (!toLane) return res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);

    Lap.transfer(parseInt(req.params.lapId), toLane, manga.id, race.id);
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/add
  static addManual(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

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
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

    Lap.deleteLap(parseInt(req.params.lapId));
    corrected(res, race, manga);
  }

  // POST /races/:id/mangas/:mangaId/corrections/edit/:lapId
  static editTime(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });

    const lapTimeS = parseFloat(req.body.lap_time_s);
    if (!isNaN(lapTimeS) && lapTimeS > 0) {
      Lap.updateTime(parseInt(req.params.lapId), Math.round(lapTimeS * 1000));
      return corrected(res, race, manga);
    }
    res.redirect(`/races/${race.id}/mangas/${manga.id}/corrections`);
  }
}

module.exports = LapCorrectionController;
