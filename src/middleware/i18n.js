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
const path = require('path');
const fs   = require('fs');

const LOCALES_DIR = path.join(__dirname, '../locales');
const locales = {};

fs.readdirSync(LOCALES_DIR)
  .filter(f => f.endsWith('.json'))
  .forEach(f => {
    locales[f.replace('.json', '')] = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, f), 'utf-8')
    );
  });

const DEFAULT_LANG = 'es';

// Orden del selector de idioma. Un idioma que esté en src/locales/ y no en esta
// lista se añade igualmente (detrás, alfabético): añadir un idioma es dejar el
// JSON en la carpeta y, si se quiere que salga el primero, tocar esta lista.
const ORDEN = ['es', 'en', 'it'];
const LANGS = [
  ...ORDEN.filter(l => locales[l]),
  ...Object.keys(locales).filter(l => !ORDEN.includes(l)).sort(),
];

// Negociación real de Accept-Language: «it-IT,it;q=0.9,en;q=0.8» → 'it'.
// Antes era `startsWith('en')`, que con más de dos idiomas manda a español todo
// lo que no empiece por «en» — un navegador italiano caía a español.
function negociar(header) {
  const pedidos = String(header || '')
    .split(',')
    .map(parte => {
      const [tag, ...params] = parte.trim().split(';');
      const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q.slice(2)) : 1 };
    })
    .filter(x => x.tag && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q);

  for (const { tag } of pedidos) {
    const base = tag.split('-')[0];
    if (locales[base]) return base;
  }
  return DEFAULT_LANG;
}

function makeTranslator(lang) {
  const dict = locales[lang] || locales[DEFAULT_LANG];
  return function t(key, vars = {}) {
    const val = key.split('.').reduce((o, k) => o?.[k], dict);
    if (typeof val !== 'string') return key;
    return val.replace(/\{\{(\w+)\}\}/g, (_, v) => vars[v] ?? '');
  };
}

// URL de la página actual en otro idioma, conservando el resto del query string
// (vista, filtros, orden…). Antes el selector era un `?lang=x` pelado: cambiaba
// de idioma y de paso borraba los filtros y volvía a la vista por defecto.
function urlEnIdioma(originalUrl, code) {
  const [ruta, qs] = String(originalUrl || '/').split('?');
  const params = new URLSearchParams(qs || '');
  params.set('lang', code);
  return `${ruta}?${params.toString()}`;
}

module.exports = function i18nMiddleware(req, res, next) {
  // `?lang=` solo se guarda si el idioma existe: antes se persistía cualquier
  // cosa en sesión (un `?lang=xx` dejaba la sesión en un idioma inexistente).
  const pedido = req.query.lang;
  if (pedido && locales[pedido]) req.session.lang = pedido;

  const lang = req.session.lang || negociar(req.headers['accept-language']);

  req.lang = lang;
  req.t = makeTranslator(lang);
  res.locals.lang  = lang;
  res.locals.langs = LANGS;
  res.locals.t     = req.t;
  res.locals.langUrl = (code) => urlEnIdioma(req.originalUrl, code);
  next();
};

module.exports.LANGS  = LANGS;
module.exports.locales = locales;
