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
// Página "Conexión ecosistema": un único interruptor que decide si PitWall
// Control puede alcanzar a este Manager desde la LAN (envío de tandas con PIN
// vía POST /import/tanda, y lectura de resultados por tanda vía
// GET /link/races/:id/results.json). El operador local (localhost/allowlist)
// nunca se ve afectado. Ver accessControl.ecosystemBridgeEnabled().
const Settings = require('../models/Settings');
const ImportController = require('./ImportController');

const EcosystemController = {
  page(req, res) {
    res.render('ecosystem/index', {
      t: req.t,
      enabled: Settings.get('ecosystem_control_enabled', '1') === '1',
      pin: ImportController.ensureImportPin(),
    });
  },

  save(req, res) {
    const on = req.body.ecosystem_control_enabled === '1' || req.body.ecosystem_control_enabled === 'on';
    Settings.set('ecosystem_control_enabled', on ? '1' : '0');
    const isEs = (req.session && req.session.lang) !== 'en';
    req.session.flash = {
      type: 'success',
      text: on
        ? (isEs ? 'Conexión ecosistema activada.' : 'Ecosystem connection enabled.')
        : (isEs ? 'Conexión ecosistema desactivada.' : 'Ecosystem connection disabled.'),
    };
    res.redirect('/ecosystem');
  },
};

module.exports = EcosystemController;
