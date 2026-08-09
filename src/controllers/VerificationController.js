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
// Verificaciones técnicas de PitWall Control:
//   POST /import/verificaciones — recibe el payload por LAN (mismo PIN/
//     interruptor de ecosistema que /import/tanda; ver ImportController).
//   GET  /races/:id/verificaciones — pantalla de solo consulta (operador
//     local): lo que Control tiene verificado, agrupado por manga.
const Race = require('../models/Race');
const Verification = require('../models/Verification');
const ImportController = require('./ImportController');
const VerificationImport = require('../services/VerificationImport');

const VerificationController = {
  // POST /import/verificaciones
  create(req, res) {
    if (!ImportController.importAuthorized(req)) {
      return res.status(403).json({ ok: false, error: 'PIN de importación incorrecto o dispositivo no autorizado.' });
    }
    try {
      const payload = req.body && req.body.payload ? req.body.payload : req.body;
      const result = VerificationImport.importPayload(payload);
      res.json({ ok: true, ...result });
    } catch (e) {
      const code = e instanceof VerificationImport.VerificationImportError ? 400 : 500;
      res.status(code).json({ ok: false, error: e.message });
    }
  },

  // GET /races/:id/verificaciones
  race(req, res) {
    const race = Race.findById(parseInt(req.params.id, 10));
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });
    const verifs = Verification.findByRace(race.id);

    const porManga = new Map();
    for (const v of verifs) {
      if (!porManga.has(v.manga_numero)) porManga.set(v.manga_numero, []);
      porManga.get(v.manga_numero).push(v);
    }
    const mangas = [...porManga.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([numero, items]) => ({ numero, items }));

    res.render('verifications/race', { t: req.t, race, mangas, total: verifs.length });
  },
};

module.exports = VerificationController;
