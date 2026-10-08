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
// Desempate a igualdad de vueltas. Fuente única: Lap, el motor de proyección, los
// controladores y results.ejs lo comparten para no ordenar distinto según la pantalla.
//
// Misma manga final y ambos con instante del último cruce → delante quien cruzó
// antes. Si no (mangas distintas o sin dato), la coma de la última manga.
// Campos: last_manga_id, last_manga_cross_ms (desde el GO de su circuito), last_manga_coma.

function compareLastManga(x, y) {
  const mx = x.last_manga_id, cx = x.last_manga_cross_ms;
  const my = y.last_manga_id, cy = y.last_manga_cross_ms;
  if (mx != null && mx === my && cx != null && cy != null && cx !== cy) return cx - cy;
  return (y.last_manga_coma || 0) - (x.last_manga_coma || 0);
}

module.exports = { compareLastManga };
