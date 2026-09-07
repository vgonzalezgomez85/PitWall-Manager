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
const CatalogSync = require('../models/CatalogSync');

class CatalogSyncController {

  // GET /catalog-sync  (?race=ID solo para resaltar/enfocar una carrera)
  static index(req, res) {
    const lang  = res.locals.lang;
    const focus = parseInt(req.query.race, 10) || null;

    const diffs = CatalogSync.eligibleRaces()
      .map(r => CatalogSync.computeDiff(r.id))
      .filter(Boolean);

    res.render('catalog-sync/index', {
      t: req.t, diffs, focus,
      pageTitle: lang === 'es' ? 'Sincronizar catálogo' : 'Sync catalog',
    });
  }

  // POST /catalog-sync/apply   body: race_ids[]=1&race_ids[]=2 [&return=/races/1]
  static apply(req, res) {
    const lang = res.locals.lang;
    const ids  = [].concat(req.body.race_ids || [])
      .map(id => parseInt(id, 10))
      .filter(Boolean);

    if (ids.length === 0) {
      req.session.flash = {
        type: 'error',
        text: lang === 'es' ? 'No has seleccionado ninguna carrera.' : 'No race selected.',
      };
      return res.redirect('/catalog-sync');
    }

    let added = 0, removed = 0, country = 0, done = 0;
    const failed = [];
    for (const id of ids) {
      try {
        const r = CatalogSync.apply(id);
        added += r.added; removed += r.removed; country += r.countryUpdated;
        done++;
      } catch (e) {
        failed.push(`#${id}`);
      }
    }

    const parts = [];
    if (added)   parts.push(lang === 'es' ? `${added} piloto(s) añadido(s)`   : `${added} driver(s) added`);
    if (removed) parts.push(lang === 'es' ? `${removed} piloto(s) quitado(s)` : `${removed} driver(s) removed`);
    if (country) parts.push(lang === 'es' ? `${country} país(es) actualizado(s)` : `${country} country field(s) updated`);
    if (parts.length === 0) parts.push(lang === 'es' ? 'sin cambios' : 'no changes');

    let text = (lang === 'es'
      ? `Catálogo sincronizado en ${done} carrera(s): `
      : `Catalog synced on ${done} race(s): `) + parts.join(', ') + '.';
    if (failed.length) {
      text += lang === 'es'
        ? ` No se pudo sincronizar: ${failed.join(', ')}.`
        : ` Could not sync: ${failed.join(', ')}.`;
    }

    req.session.flash = { type: failed.length ? 'error' : 'success', text };

    const back = typeof req.body.return === 'string' && req.body.return.startsWith('/')
      ? req.body.return
      : '/catalog-sync';
    return res.redirect(back);
  }
}

module.exports = CatalogSyncController;
