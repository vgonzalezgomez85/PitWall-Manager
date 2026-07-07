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
// Control del túnel público (Cloudflare) desde Ajustes. Rutas de CONTROL:
// no están en isPublicPath, así que solo el operador (localhost/allowlist)
// puede tocarlas — nunca desde el propio túnel.

const TunnelService = require('../services/TunnelService');

const TunnelController = {
  status(req, res) { res.json(TunnelService.status()); },
  start(req, res)  { res.json(TunnelService.start()); },
  stop(req, res)   { res.json(TunnelService.stop()); },
};

module.exports = TunnelController;
