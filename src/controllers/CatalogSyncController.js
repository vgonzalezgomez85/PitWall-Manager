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
      pageTitle: req.t('common.sincronizar_catalogo'),
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
        text: req.t('catalogsync.no_has_seleccionado_ninguna_carrera'),
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
    if (added)   parts.push(req.t('catalogsync.added_piloto_s_anadido_s', { added: added }));
    if (removed) parts.push(req.t('catalogsync.removed_piloto_s_quitado_s', { removed: removed }));
    if (country) parts.push(req.t('catalogsync.country_pais_es_actualizado_s', { country: country }));
    if (parts.length === 0) parts.push(req.t('client.log.sin_cambios'));

    let text = (req.t('catalogsync.catalogo_sincronizado_en_done_carrera_s', { done: done })) + parts.join(', ') + '.';
    if (failed.length) {
      text += req.t('catalogsync.no_se_pudo_sincronizar_v', { v: failed.join(', ') });
    }

    req.session.flash = { type: failed.length ? 'error' : 'success', text };

    const back = typeof req.body.return === 'string' && req.body.return.startsWith('/')
      ? req.body.return
      : '/catalog-sync';
    return res.redirect(back);
  }
}

module.exports = CatalogSyncController;
