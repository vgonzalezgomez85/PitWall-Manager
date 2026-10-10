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
// Idioma de la app ('es' | 'en' | 'it') → etiqueta BCP-47 que esperan `Intl` y la
// síntesis de voz.
//
// Por qué un helper: los ~29 sitios que formatean fecha/hora/número tenían el
// locale escrito a mano, y encima mezclado (es-ES / en-GB / en-US según el
// fichero). Con eso, añadir un idioma obligaba a acordarse de todos.
//
// El inglés se fija en `en-GB` (día/mes/año), que es lo que usaba la mayoría de
// los sitios; `en-US` quedaba en los que muestran tamaños de fichero y vueltas.
const LOCALES = {
  es: 'es-ES',
  en: 'en-GB',
  it: 'it-IT',
};

/** Locale BCP-47 para `Intl`/`toLocaleString`. Cae a español si no se conoce. */
function localeFor(lang) {
  return LOCALES[lang] || LOCALES.es;
}

module.exports = { localeFor, LOCALES };
