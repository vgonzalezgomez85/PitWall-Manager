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
//
// Registro de sucesos de carrera — página de histórico completo.
//   /races/:id/events       → página (abre en pestaña nueva desde live.ejs)
//   /races/:id/events.json  → mismo histórico en JSON (refresco en vivo)
const Race      = require('../models/Race');
const Manga     = require('../models/Manga');
const RaceEvent = require('../models/RaceEvent');

class RaceEventController {

  static page(req, res) {
    const race = Race.findById(parseInt(req.params.id, 10));
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });
    const activeManga = Manga.findActive(race.id);
    res.render('races/events', {
      t: req.t,
      race,
      log: RaceEvent.groupedByRace(race.id),
      activeMangaNumber: activeManga ? activeManga.number : null,
    });
  }

  static json(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const race = Race.findById(raceId);
    if (!race) return res.status(404).json({ ok: false });
    const activeManga = Manga.findActive(raceId);
    res.json(Object.assign(
      { ok: true, raceId, activeMangaNumber: activeManga ? activeManga.number : null },
      RaceEvent.groupedByRace(raceId)
    ));
  }
}

module.exports = RaceEventController;
