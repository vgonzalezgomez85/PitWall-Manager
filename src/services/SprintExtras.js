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
// Extras de las carreras sprint (aportación de Emanuele): warm-up antes de la
// manga y añadir pilotos a la pole ya empezada. Cada uno tiene su interruptor en
// Ajustes → Preferencias, apagado por defecto, y solo vale en sprint individual
// (resistencia queda fuera: el control de pilotos por QR necesita el catálogo).
const Settings = require('../models/Settings');

const KEYS = { warmup: 'sprint_warmup', poleAdd: 'sprint_pole_add' };

const isSprint = (race) => !!race && race.type === 'club' && race.format !== 'team';
const on = (key) => Settings.get(key, 'off') === 'on';

module.exports = {
  KEYS,
  isSprint,
  warmupEnabled:  (race) => isSprint(race) && on(KEYS.warmup),
  poleAddEnabled: (race) => isSprint(race) && on(KEYS.poleAdd),
};
