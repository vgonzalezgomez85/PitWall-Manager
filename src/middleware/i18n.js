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

function makeTranslator(lang) {
  const dict = locales[lang] || locales['es'];
  return function t(key, vars = {}) {
    const val = key.split('.').reduce((o, k) => o?.[k], dict);
    if (typeof val !== 'string') return key;
    return val.replace(/\{\{(\w+)\}\}/g, (_, v) => vars[v] ?? '');
  };
}

module.exports = function i18nMiddleware(req, res, next) {
  const acceptLang = req.headers['accept-language'] || '';
  const defaultLang = acceptLang.startsWith('en') ? 'en' : 'es';
  const lang = req.query.lang || req.session.lang || defaultLang;

  if (req.query.lang) req.session.lang = req.query.lang;

  req.lang = lang;
  req.t = makeTranslator(lang);
  res.locals.lang = lang;
  res.locals.t    = req.t;
  next();
};
