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
// Settori: la coma de la última manga en sectores de pista. La coma se guarda
// siempre como FRACCIÓN de vuelta (0–0,99…); los settori son esa fracción en la
// escala de Ajustes → Preferencias (`coma_sectors`, 100 por defecto = la regla
// de Area Corse). Cambiar la escala reescala en proporción lo ya escrito.

const DEFAULT_PER_LAP = 100;
const MIN_PER_LAP = 2;
const MAX_PER_LAP = 1000;

function perLap() {
  const n = parseInt(require('../models/Settings').get('coma_sectors', DEFAULT_PER_LAP), 10);
  return Number.isFinite(n) && n >= MIN_PER_LAP && n <= MAX_PER_LAP ? n : DEFAULT_PER_LAP;
}

/** Fracción de vuelta → settori enteros (0 … escala − 1). */
function fromComa(coma, n = DEFAULT_PER_LAP) {
  const c = Number(coma);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.min(n - 1, Math.round(c * n));
}

/** Settori enteros → fracción de vuelta que se guarda. */
function toComa(settori, n = DEFAULT_PER_LAP) {
  return Number(settori) / n;
}

module.exports = { DEFAULT_PER_LAP, MIN_PER_LAP, MAX_PER_LAP, perLap, fromComa, toComa };
