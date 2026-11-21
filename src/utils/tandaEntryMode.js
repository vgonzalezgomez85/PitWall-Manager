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
// Cómo se apuntan los participantes en la pantalla de tandas (Ajustes → Preferencias).
const Settings = require('../models/Settings');

const MODES = ['write', 'drag'];

/** 'write' (escribir en el carril, por defecto) | 'drag' (arrastrar pilotos). */
function get() {
  const v = Settings.get('tanda_entry_mode');
  return MODES.includes(v) ? v : MODES[0];
}

module.exports = { get, MODES };
