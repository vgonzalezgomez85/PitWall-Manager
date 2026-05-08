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
