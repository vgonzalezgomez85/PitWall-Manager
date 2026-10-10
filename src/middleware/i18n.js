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

// Claves que el navegador pide de verdad, sacadas de los `I18N.t('…')` que hay
// escritos en las vistas y en el JS de cliente.
//
// Se calcula una vez al arrancar y se cachea. Es más preciso que mandar todo el
// subárbol `client.*`: hay claves que el cliente usa y NO llevan ese prefijo
// (porque el mismo texto ya se había dado de alta desde el servidor), y con el
// subárbol a secas salían como clave cruda en pantalla. Y de paso pesa menos.
let _clavesCliente = null;
function clavesDeCliente() {
  if (_clavesCliente) return _clavesCliente;
  const fs   = require('fs');
  const path = require('path');
  const raiz = path.join(__dirname, '..', '..');
  const set  = new Set();
  const leer = (dir, filtro) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) leer(p, filtro);
      else if (filtro(p)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/I18N\.t\(\s*'([\w.]+)'/g)) set.add(m[1]);
      }
    }
  };
  leer(path.join(raiz, 'src', 'views'),      p => p.endsWith('.ejs'));
  leer(path.join(raiz, 'public', 'js'),      p => p.endsWith('.js'));
  _clavesCliente = set;
  return set;
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
  // Diccionario que viaja al navegador: SOLO las claves que el cliente pide, con
  // el idioma activo encima del español para que un idioma a medio traducir
  // muestre español y no la clave. Mandar el diccionario entero sería mucho peso
  // para algo que se sirve por LAN a móviles.
  {
    const es  = locales[DEFAULT_LANG] || {};
    const mio = locales[lang] || {};
    const dict = {};
    for (const clave of clavesDeCliente()) {
      const partes = clave.split('.');
      const valor = (o) => partes.reduce((x, k) => (x == null ? x : x[k]), o);
      const v = valor(mio);
      const texto = typeof v === 'string' ? v : valor(es);
      if (typeof texto !== 'string') continue;
      let o = dict;
      for (let i = 0; i < partes.length - 1; i++) {
        if (typeof o[partes[i]] !== 'object' || o[partes[i]] === null) o[partes[i]] = {};
        o = o[partes[i]];
      }
      o[partes[partes.length - 1]] = texto;
    }
    res.locals.i18nClient = dict;
  }
  next();
};

module.exports.LANGS  = LANGS;
module.exports.locales = locales;
