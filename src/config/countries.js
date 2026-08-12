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
// Lista de países con su bandera (emoji o '__SVG__' para la senyera).
// Compartida entre el form de equipos (cliente) y el importador CSV (server).
const COUNTRIES = [
  ['Catalunya', '__SVG__'],
  ['Euskadi', '__SVG_EUS__'],
  ['Afghanistan','🇦🇫'],['Albania','🇦🇱'],['Algeria','🇩🇿'],['Andorra','🇦🇩'],['Angola','🇦🇴'],
  ['Argentina','🇦🇷'],['Armenia','🇦🇲'],['Australia','🇦🇺'],['Austria','🇦🇹'],['Azerbaijan','🇦🇿'],
  ['Bahrain','🇧🇭'],['Bangladesh','🇧🇩'],['Belarus','🇧🇾'],['Belgium','🇧🇪'],['Bolivia','🇧🇴'],
  ['Bosnia','🇧🇦'],['Brazil','🇧🇷'],['Bulgaria','🇧🇬'],['Canada','🇨🇦'],['Chile','🇨🇱'],
  ['China','🇨🇳'],['Colombia','🇨🇴'],['Croatia','🇭🇷'],['Cuba','🇨🇺'],['Cyprus','🇨🇾'],
  ['Czech Republic','🇨🇿'],['Denmark','🇩🇰'],['Ecuador','🇪🇨'],['Egypt','🇪🇬'],['Estonia','🇪🇪'],
  ['Finland','🇫🇮'],['France','🇫🇷'],['Georgia','🇬🇪'],['Germany','🇩🇪'],['Ghana','🇬🇭'],
  ['Greece','🇬🇷'],['Guatemala','🇬🇹'],['Honduras','🇭🇳'],['Hungary','🇭🇺'],['Iceland','🇮🇸'],
  ['India','🇮🇳'],['Indonesia','🇮🇩'],['Iran','🇮🇷'],['Iraq','🇮🇶'],['Ireland','🇮🇪'],
  ['Israel','🇮🇱'],['Italy','🇮🇹'],['Jamaica','🇯🇲'],['Japan','🇯🇵'],['Jordan','🇯🇴'],
  ['Kazakhstan','🇰🇿'],['Kenya','🇰🇪'],['Kuwait','🇰🇼'],['Latvia','🇱🇻'],['Lebanon','🇱🇧'],
  ['Libya','🇱🇾'],['Lithuania','🇱🇹'],['Luxembourg','🇱🇺'],['Malaysia','🇲🇾'],['Malta','🇲🇹'],
  ['Mexico','🇲🇽'],['Moldova','🇲🇩'],['Monaco','🇲🇨'],['Morocco','🇲🇦'],['Netherlands','🇳🇱'],
  ['New Zealand','🇳🇿'],['Nigeria','🇳🇬'],['North Korea','🇰🇵'],['Norway','🇳🇴'],['Pakistan','🇵🇰'],
  ['Panama','🇵🇦'],['Paraguay','🇵🇾'],['Peru','🇵🇪'],['Philippines','🇵🇭'],['Poland','🇵🇱'],
  ['Portugal','🇵🇹'],['Qatar','🇶🇦'],['Romania','🇷🇴'],['Russia','🇷🇺'],['Saudi Arabia','🇸🇦'],
  ['Serbia','🇷🇸'],['Singapore','🇸🇬'],['Slovakia','🇸🇰'],['Slovenia','🇸🇮'],['South Africa','🇿🇦'],
  ['South Korea','🇰🇷'],['Spain','🇪🇸'],['Sweden','🇸🇪'],['Switzerland','🇨🇭'],['Thailand','🇹🇭'],
  ['Tunisia','🇹🇳'],['Turkey','🇹🇷'],['Ukraine','🇺🇦'],['United Arab Emirates','🇦🇪'],
  ['United Kingdom','🇬🇧'],['United States','🇺🇸'],['Uruguay','🇺🇾'],['Venezuela','🇻🇪'],
  ['Vietnam','🇻🇳'],
];

// Aliases en español → nombre canónico inglés, para el importador CSV.
const ALIASES = {
  'cataluña': 'Catalunya', 'catalunya': 'Catalunya',
  'país vasco': 'Euskadi', 'pais vasco': 'Euskadi', 'euskadi': 'Euskadi', 'euskal herria': 'Euskadi', 'vascongadas': 'Euskadi', 'basque country': 'Euskadi',
  'españa': 'Spain', 'espana': 'Spain', 'spain': 'Spain',
  'reino unido': 'United Kingdom', 'inglaterra': 'United Kingdom', 'uk': 'United Kingdom',
  'estados unidos': 'United States', 'eeuu': 'United States', 'usa': 'United States', 'us': 'United States',
  'emiratos árabes unidos': 'United Arab Emirates', 'emiratos': 'United Arab Emirates', 'uae': 'United Arab Emirates',
  'alemania': 'Germany', 'francia': 'France', 'italia': 'Italy', 'portugal': 'Portugal',
  'países bajos': 'Netherlands', 'holanda': 'Netherlands',
  'japón': 'Japan', 'china': 'China', 'corea del sur': 'South Korea', 'corea del norte': 'North Korea',
  'brasil': 'Brazil', 'argentina': 'Argentina', 'méxico': 'Mexico', 'mexico': 'Mexico',
  'chile': 'Chile', 'colombia': 'Colombia', 'perú': 'Peru', 'venezuela': 'Venezuela', 'uruguay': 'Uruguay',
  'rusia': 'Russia', 'ucrania': 'Ukraine', 'polonia': 'Poland',
  'república checa': 'Czech Republic', 'chequia': 'Czech Republic',
  'suecia': 'Sweden', 'noruega': 'Norway', 'finlandia': 'Finland', 'dinamarca': 'Denmark',
  'austria': 'Austria', 'suiza': 'Switzerland', 'bélgica': 'Belgium', 'belgica': 'Belgium',
  'grecia': 'Greece', 'turquía': 'Turkey', 'turquia': 'Turkey',
  'australia': 'Australia', 'nueva zelanda': 'New Zealand',
  'irlanda': 'Ireland', 'islandia': 'Iceland', 'sudáfrica': 'South Africa', 'sudafrica': 'South Africa',
  'arabia saudí': 'Saudi Arabia', 'arabia saudita': 'Saudi Arabia',
  'andorra': 'Andorra', 'mónaco': 'Monaco', 'monaco': 'Monaco',
};

const BY_LOWER = new Map(COUNTRIES.map(([name, flag]) => [name.toLowerCase(), { name, flag }]));

/**
 * Resuelve un nombre de país (en cualquier idioma soportado) al formato
 * que guarda el form: "Nombre|🇫🇱". Si no encuentra el país devuelve null
 * (no se establece país).
 */
function resolveCountry(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // Si el usuario ya escribió el formato "Nombre|🇫🇱", aceptarlo tal cual.
  if (trimmed.includes('|')) return trimmed;

  const lc = trimmed.toLowerCase();
  // Match directo
  let match = BY_LOWER.get(lc);
  if (!match) {
    const canonical = ALIASES[lc];
    if (canonical) match = BY_LOWER.get(canonical.toLowerCase());
  }
  if (!match) return null;
  return `${match.name}|${match.flag}`;
}

// Windows no pinta banderas emoji (regional indicator symbols) salvo en
// builds muy recientes: se ve el código ISO en texto o directamente nada. Por
// eso las vistas NO pintan el emoji tal cual — lo convierten a su código ISO
// 3166-1 alfa-2 (cada emoji de bandera son 2 "regional indicator symbols",
// uno por letra: 🇪🇸 = 🇪+🇸 = "ES") y sirven el SVG ya copiado en
// public/flags/4x3/{iso}.svg (de flag-icons, ver public/flags/LICENSE).
// Catalunya/Euskadi no tienen código ISO — siguen siendo el marcador
// '__SVG__'/'__SVG_EUS__' con el SVG dibujado a mano de siempre.
function flagEmojiToIso(flag) {
  const codePoints = [...flag].map(c => c.codePointAt(0));
  if (codePoints.length !== 2) return null;
  return codePoints.map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join('').toLowerCase();
}

module.exports = { COUNTRIES, resolveCountry, flagEmojiToIso };
