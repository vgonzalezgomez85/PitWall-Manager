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
const Race    = require('../models/Race');
const Manga   = require('../models/Manga');
const Tanda   = require('../models/Tanda');
const Lap     = require('../models/Lap');
const db      = require('../config/database');
const Settori = require('../utils/settori');

// Resumen de fin de tanda (idea de Emanuele Palena): vueltas de cada piloto/equipo
// (solo lectura) y sus SETTORI FINALES, dónde se quedó el coche al acabarse el
// tiempo. Se escriben una vez por participante y se guardan en SU última manga de
// la tanda (`manga_lanes.coma_manual`, como fracción), el dato que Lap y
// utils/tieBreak ya usan a igualdad de vueltas. Vacío = vuelve la coma automática.
// Solo se escribe con Ajustes → Preferencias → coma manual activa y la tanda acabada.

const keyOf = (type, id) => type + ':' + id;

function tandaOf(req, res) {
  const race  = Race.findById(req.params.id);
  const tanda = Tanda.findById(req.params.tandaId);
  if (!race || !tanda || tanda.race_id !== race.id) {
    res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });
    return null;
  }
  return { race, tanda };
}

/** Participantes de la tanda con su última manga corrida (mayor manga_id sin descanso). */
function participantsOf(tanda) {
  const mangas = Manga.findByTanda(tanda.id).slice().sort((a, b) => a.id - b.id);
  const byKey = new Map();
  for (const m of mangas) {
    for (const l of Manga.getLanes(m.id)) {
      if (l.is_rest) continue;
      const type = l.team_id != null ? 'team' : 'driver';
      const id   = l.team_id != null ? l.team_id : l.driver_id;
      if (id == null) continue;
      const key = keyOf(type, id);
      let p = byKey.get(key);
      if (!p) {
        p = { key, type, id, name: l.team_id != null ? l.team_name : l.driver_name, color: l.team_color || null };
        byKey.set(key, p);
      }
      p.lastMangaId = m.id;
      p.lastLane    = l.lane;
      p.coma        = Number(l.coma) || 0;
      p.comaManual  = l.coma_manual != null ? Number(l.coma_manual) : null;
    }
  }
  return { mangas, participants: [...byKey.values()] };
}

const tandaFinished = (mangas) => mangas.length > 0 && mangas.every(m => m.status === 'finished');

class TandaSummaryController {

  // GET /races/:id/tandas/:tandaId/summary
  static show(req, res) {
    const ctx = tandaOf(req, res);
    if (!ctx) return;
    const { race, tanda } = ctx;

    const { mangas, participants } = participantsOf(tanda);
    const enabled = Lap.manualComaEnabled();
    const per = Settori.perLap();

    // Vueltas válidas (sin fantasmas, como la clasificación) por manga y participante.
    const lapsBy = new Map();
    if (mangas.length) {
      const ids = mangas.map(m => m.id);
      db.prepare(`
        SELECT CASE WHEN team_id IS NOT NULL THEN 'team' ELSE 'driver' END AS etype,
               COALESCE(team_id, driver_id) AS eid, manga_id, COUNT(*) AS n
        FROM laps
        WHERE manga_id IN (${ids.map(() => '?').join(',')}) AND is_ghost = 0
        GROUP BY 1, 2, 3
      `).all(...ids).forEach(r => {
        const k = keyOf(r.etype, r.eid);
        if (!lapsBy.has(k)) lapsBy.set(k, new Map());
        lapsBy.get(k).set(r.manga_id, r.n);
      });
    }

    const totals = {};
    try {
      Lap.aggregateByRace(race.id).forEach(r => { totals[keyOf(r.entity_type, r.entity_id)] = r.total_laps; });
    } catch (err) { console.error('[TandaSummary] totales:', err.message); }

    const rows = participants.map(p => {
      const perManga = lapsBy.get(p.key) || new Map();
      const auto   = Settori.fromComa(p.coma, per);
      const manual = p.comaManual != null ? Settori.fromComa(p.comaManual, per) : null;
      return {
        key: p.key, name: p.name, color: p.color,
        perManga: mangas.map(m => perManga.get(m.id) ?? null),
        laps: mangas.reduce((s, m) => s + (perManga.get(m.id) || 0), 0),
        total: totals[p.key] ?? null,
        manual, auto,
        effective: enabled && manual != null ? manual : auto,
      };
    });
    rows.sort((a, b) => b.laps - a.laps || b.effective - a.effective || String(a.name).localeCompare(String(b.name)));

    res.render('races/tanda-summary', {
      t: req.t, race, tanda, mangas, rows,
      tandaOptions: Tanda.findByRace(race.id).map(td => ({ id: td.id, number: td.number })),
      enabled,
      editable: enabled && tandaFinished(mangas),
      saved: req.query.saved === '1',
      errorKeys: String(req.query.error || '').split(',').filter(Boolean),
      MAX_SETTORI: per - 1,
    });
  }

  // POST /races/:id/tandas/:tandaId/summary
  // Guarda los settori de toda la tanda (campos `s_<type>_<id>`). Si alguno no es
  // válido no se guarda ninguno y se avisa de cuáles.
  static save(req, res) {
    const ctx = tandaOf(req, res);
    if (!ctx) return;
    const { race, tanda } = ctx;

    const back = (qs) => res.redirect(`/races/${race.id}/tandas/${tanda.id}/summary${qs || ''}`);
    const { mangas, participants } = participantsOf(tanda);
    if (!Lap.manualComaEnabled()) return back();
    // Con una manga por cerrar, TimingService.stopManga aún reescribe la coma.
    if (!tandaFinished(mangas)) return back();
    const per = Settori.perLap();

    const changes = [];
    const invalid = [];
    for (const p of participants) {
      const field = 's_' + p.type + '_' + p.id;
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) continue;
      const raw = String(req.body[field] ?? '').trim();
      let value = null;
      if (raw !== '') {
        if (!/^\d{1,4}$/.test(raw) || Number(raw) > per - 1) { invalid.push(p.key); continue; }
        value = Number(raw);
      }
      const current = p.comaManual != null ? Settori.fromComa(p.comaManual, per) : null;
      if (value !== current) changes.push({ p, value });
    }
    if (invalid.length) return back('?error=' + encodeURIComponent(invalid.join(',')));

    // setLaneComa ya invalida las cachés por contador (la coma no vive en `laps`).
    const touched = new Set();
    changes.forEach(({ p, value }) => {
      Manga.setLaneComa(p.lastMangaId, p.lastLane, value == null ? null : Settori.toComa(value, per));
      touched.add(p.lastMangaId);
    });
    touched.forEach(mid => {
      try { require('../services/TimingService').applyLapCorrection(race.id, mid); }
      catch (err) { console.error('[TandaSummary] refresco del directo:', err.message); }
    });
    back('?saved=1');
  }
}

module.exports = TandaSummaryController;
