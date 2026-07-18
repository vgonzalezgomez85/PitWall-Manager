#!/usr/bin/env node
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
// Descarga las tipografías de Google Fonts que usa PitWall y genera el CSS
// local `public/css/fonts.css`, para que la app NO dependa de internet para
// las fuentes (en un circuito no siempre hay línea). Se ejecuta a mano cuando
// cambian las familias o los pesos usados en las vistas:
//
//     node scripts/fetch-fonts.js
//
// Pide a la API css2 de Google con un User-Agent de navegador moderno (así
// devuelve woff2), se queda con los subconjuntos latin y latin-ext (cubren
// ES/EN/FR/IT: acentos, ñ, ç…), baja cada woff2 a public/fonts/ y reescribe las
// src url() a rutas locales. Los ficheros resultantes SÍ se versionan (son la
// razón de ser: PitWall offline).
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT       = path.join(__dirname, '..');
const FONTS_DIR  = path.join(ROOT, 'public', 'fonts');
const CSS_PATH   = path.join(ROOT, 'public', 'css', 'fonts.css');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Familias y pesos usados en las vistas (unión). Si añades una fuente nueva a
// una vista, súmala aquí y vuelve a ejecutar el script.
const FAMILIES = [
  'family=Inter:wght@400;500;600;700;800',
  'family=Rajdhani:wght@500;600;700',
  'family=Share+Tech+Mono',
  'family=Barlow+Condensed:wght@300;400;600',
  'family=Saira+Condensed:wght@500;600;700;800;900',
  'family=Saira:wght@400;500;600;700',
  'family=IBM+Plex+Mono:wght@400;500;600',
];
const URL = 'https://fonts.googleapis.com/css2?' + FAMILIES.join('&') + '&display=swap';

// Google entrega un @font-face por subconjunto; nos quedamos con estos.
const KEEP = new Set(['latin', 'latin-ext']);

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': UA } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return get(r.headers.location).then(res, rej);
      }
      if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode} en ${url}`));
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

(async () => {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  const css = (await get(URL)).toString('utf8');

  // Cada @font-face viene precedido de un comentario /* subset */.
  const parts = css.split(/\/\*\s*([\w-]+)\s*\*\//).slice(1);   // [subset, block, ...]
  const out = [];
  const downloads = [];
  const seen = new Set();

  for (let i = 0; i < parts.length; i += 2) {
    const subset = parts[i].trim();
    const block  = parts[i + 1];
    if (!KEEP.has(subset)) continue;

    const family = (block.match(/font-family:\s*'([^']+)'/) || [])[1];
    const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1] || '400';
    const woff2  = (block.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
    if (!family || !woff2) continue;

    const fname = `${slug(family)}-${weight}-${subset}.woff2`;
    if (!seen.has(fname)) { seen.add(fname); downloads.push({ woff2, fname }); }
    out.push(block.replace(/url\(https:\/\/[^)]+\.woff2\)/, `url(/fonts/${fname})`).trim());
  }

  for (const d of downloads) {
    fs.writeFileSync(path.join(FONTS_DIR, d.fname), await get(d.woff2));
    console.log(`  ${d.fname}`);
  }

  const header = '/* Fuentes locales de PitWall — generadas de Google Fonts (subconjuntos\n'
    + '   latin + latin-ext). Servidas por el propio PitWall para no depender de\n'
    + '   internet. Regenerar con scripts/fetch-fonts.js si cambian familias/pesos. */\n\n';
  fs.writeFileSync(CSS_PATH, header + out.join('\n\n') + '\n');
  console.log(`\n${downloads.length} fuentes + ${path.relative(ROOT, CSS_PATH)}`);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
