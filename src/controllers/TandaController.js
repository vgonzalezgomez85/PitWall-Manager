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
const Race           = require('../models/Race');
const Tanda          = require('../models/Tanda');
const Manga          = require('../models/Manga');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
const DriverProfile  = require('../models/DriverProfile');
const TeamCatalog    = require('../models/TeamCatalog');
const Names          = require('../utils/participantNames');
const EntryMode      = require('../utils/tandaEntryMode');
const TandaBatch     = require('../services/TandaBatch');

const LaneColors = require('../services/LaneColors');

// Devuelve el array de tamaños de sub-circuitos. Si no hay circuito asignado
// o la config no es válida, devuelve [lanes_count] (un solo sub-circuito).
// Con pole, las tandas salen de sus resultados (Asignar carriles): una tanda hecha
// a mano antes de acabarla corre con otros participantes que los de la pole.
function _poleBlocksTandas(race) {
  if (!race.has_pole) return false;
  const session = require('../models/PoleSession').findByRace(race.id);
  return !!session && session.status !== 'done';
}

function _renderPoleFirst(req, res) {
  return res.status(409).render('error', { t: req.t, code: 409, message: req.t('show.tienes_que_terminar_la_sesion_de_pole_position') });
}

function _circuitSizesFor(race) {
  try {
    if (race.circuit_id) {
      const Circuit = require('../models/Circuit');
      const c = Circuit.findById(race.circuit_id);
      if (c) {
        const sizes = Circuit.getConfig(c);
        if (Array.isArray(sizes) && sizes.length > 0) return sizes;
      }
    }
    if (race.circuits_config) {
      const arr = JSON.parse(race.circuits_config);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch {}
  return [race.lanes_count || 6];
}

// ── Pantalla de tandas (nueva, varias a la vez y edición) ─────────────────────

function _payloadOf(body) {
  if (body.payload == null) return null;
  try {
    const p = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
    return p && typeof p === 'object' ? p : { tandas: [] };
  } catch { return { tandas: [] }; }
}

function _asList(v) { return Array.isArray(v) ? v : Object.values(v || {}); }

// Formulario antiguo → casillas. Individual: la fila i es la posición i (una
// fila vacía = hueco). Equipos: team_catalog_ids[] ('' = carril libre).
function _legacyCreateSlots(race, body) {
  if (race.format === 'team') {
    let n = 0;
    return [].concat(body.team_catalog_ids || []).map(id => {
      const catalogId = parseInt(id, 10) || null;
      if (!catalogId) return null;
      n++;
      return { catalogId, name: TeamCatalog.findById(catalogId)?.name || `Equipo ${n}` };
    });
  }
  return _asList(body.drivers);
}

function _legacyEditSlots(race, body) {
  return _asList(race.format === 'team' ? body.teams : body.drivers);
}

function _parseBody(race, body) {
  const payload = _payloadOf(body);
  if (payload) return { mode: payload.mode, tandas: _asList(payload.tandas) };
  return { mode: body.empty_lane_mode, tandas: [{ slots: _legacyCreateSlots(race, body) }] };
}

// Posiciones de la secuencia en el orden de pantalla: carriles de menor a mayor
// y los descansos (0) al final. `ci` = circuito del carril.
function _laneRows(laneSequence, circuitSizes, colors) {
  const info = {};
  let end = 0;
  circuitSizes.forEach((size, ci) => { for (let l = end + 1; l <= end + size; l++) info[l] = ci; end += size; });
  const rows = laneSequence.map((lane, pos) => {
    const color = lane > 0 ? colors[(lane - 1) % colors.length] : null;
    return { pos, lane, ci: lane > 0 ? (info[lane] ?? 0) : null, color, ink: color ? LaneColors.ink(color) : null };
  });
  return rows.sort((a, b) => (a.lane > 0 ? 0 : 1) - (b.lane > 0 ? 0 : 1) || (a.lane > 0 ? a.lane - b.lane : b.pos - a.pos));
}

// Casillas de una tanda guardada. Con carriles libres cada participante vuelve
// a su carril de la 1ª manga (no a la fila i de la secuencia).
function _slotsOfTanda(race, tanda, laneSequence) {
  const mangas = Manga.findByTanda(tanda.id);
  const ents = race.format === 'team'
    ? Team.findByTandaWithMembers(tanda.id)
    : Driver.findByTanda(tanda.id).filter(d => !d.team_id);
  const firstLanes = mangas.length
    ? Manga.getLanes(mangas.slice().sort((a, b) => a.number - b.number)[0].id).filter(l => !l.is_rest && l.lane > 0).map(l => l.lane)
    : [];
  const placed = Manga.placeInLanes(laneSequence, firstLanes, ents.map((_, i) => i));
  const slots = Array(Math.max(laneSequence.length, ents.length)).fill(null);
  const posOf = (k) => {
    if (placed.length <= ents.length) return k;
    const at = placed.indexOf(k);
    return at >= 0 ? at : k;
  };
  ents.forEach((e, k) => {
    slots[posOf(k)] = {
      id: e.id, name: e.name, categoria: e.categoria || '', coche: e.coche || '',
      members: race.format === 'team' ? (e.members || []).map(m => ({ id: m.id, name: m.name })) : undefined,
    };
  });
  return slots;
}

function _renderScreen(req, res, race, { tanda = null, createdNumber = null, errorDetail = [], body = {}, initial = null } = {}) {
  const laneSequence = Race.getLaneSequence(race);
  const circuitSizes = _circuitSizesFor(race);
  const isTeam = race.format === 'team';
  const existing = Tanda.findByRace(race.id);
  const canRestructure = tanda ? Manga.findByTanda(tanda.id).every(m => m.status === 'pending') : true;

  let tandas;
  if (initial) tandas = initial.tandas.map(t => ({ slots: TandaBatch.normSlots(t?.slots) }));
  else if (tanda) tandas = [{ slots: _slotsOfTanda(race, tanda, laneSequence) }];
  else tandas = [{ slots: [] }];

  const emptyMode = ['rotate', 'skip', 'fixed'].includes(initial?.mode) ? initial.mode
    : (tanda ? (tanda.empty_lane_mode || 'fixed') : 'rotate');

  const catalog = isTeam
    ? TeamCatalog.findAll().map(c => ({
        id: c.id, name: c.name, country: c.country || null, categoria: c.categoria || '', coche: c.coche || '',
        members: c.members.map(m => m.name).filter(Boolean),
      }))
    : DriverProfile.findAll().map(p => ({ name: p.name, category: p.category || null }));

  const config = {
    raceId: race.id, isTeam, isEdit: !!tanda, canRestructure,
    mode: EntryMode.get(), emptyMode,
    createAll: !tanda && existing.length === 0,
    baseNumber: tanda ? tanda.number : Tanda.nextNumber(race.id),
    seqLen: laneSequence.length,
    rows: _laneRows(laneSequence, circuitSizes, LaneColors.forRace(race)),
    multiCircuit: circuitSizes.length > 1,
    colors: LaneColors.forRace(race),
    showCat: !!race.has_categoria, showCar: !!race.has_coche,
    catalog, otherNames: Names.inOtherTandas(race, tanda ? tanda.id : null),
    tandas,
    errors: errorDetail,
  };

  const errors = [...new Set(errorDetail.map(e => e.key))];
  res.render('races/tandas', {
    t: req.t, race, tanda, laneSequence, config, errors, errorDetail, body,
    createdNumber, existingTandas: existing.length, canRestructure,
    otherNames: config.otherNames,
  });
}

class TandaController {

  // GET /races/:id/tandas/new
  static newForm(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.race_not_found') });
    if (_poleBlocksTandas(race)) return _renderPoleFirst(req, res);
    const createdNumber = parseInt(req.query?.created, 10) || null;
    _renderScreen(req, res, race, { createdNumber });
  }

  // POST /races/:id/tandas — crea una o varias tandas a la vez (todas o ninguna).
  // Cuerpo nuevo: { payload: JSON {mode, tandas:[{slots}]} }. Se sigue aceptando
  // el formulario antiguo (drivers[] / team_catalog_ids[] / empty_lane_mode).
  static create(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.race_not_found') });
    if (_poleBlocksTandas(race)) return _renderPoleFirst(req, res);

    const body = req.body || {};
    const parsed = _parseBody(race, body);
    try {
      const ids = TandaBatch.createTandas(race, parsed.tandas, parsed.mode);
      if (body.after === 'another') {
        return res.redirect(`/races/${race.id}/tandas/new?created=${Tanda.findById(ids[ids.length - 1])?.number || ''}`);
      }
      return res.redirect(`/races/${race.id}`);
    } catch (e) {
      if (!(e instanceof TandaBatch.TandaBatchError)) throw e;
      return _renderScreen(req, res, race, { errorDetail: e.errors, body, initial: parsed });
    }
  }

  // POST /races/:id/tandas/preview — las mangas que saldrían, sin guardar nada.
  // Usa el mismo Manga.buildSchedule que create(), así la vista previa no puede
  // divergir del calendario real. slots[i] = nombre o null (hueco), en el mismo
  // orden que el formulario envía los participantes.
  static preview(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });
    const laneSequence = Race.getLaneSequence(race);
    const mode = ['fixed', 'skip'].includes(req.body?.mode) ? req.body.mode : 'rotate';
    const slots = Array.isArray(req.body?.slots) ? req.body.slots.slice(0, 200) : [];
    const entities = slots.map((n, i) => {
      const name = typeof n === 'string' ? n.trim() : '';
      return name ? { id: i, name } : null;
    });
    const schedule = Manga.buildSchedule(laneSequence, entities, race.passes, race.lane_repeat, mode);
    const lanes = [...new Set(laneSequence.filter(l => l > 0))].sort((a, b) => a - b);
    const used = new Set();
    const mangas = schedule.map(slotsOf => {
      const byLane = {}, rests = [];
      slotsOf.forEach(sl => {
        if (sl.lane > 0) used.add(sl.lane);
        if (sl.isRest) { if (sl.entity) rests.push(sl.entity.name); return; }
        if (sl.entity) byLane[sl.lane] = sl.entity.name;
      });
      return { byLane, rests };
    });
    res.json({ lanes, usedLanes: [...used], mangas });
  }

  // GET /races/:id/mangas/:mangaId/edit
  static editManga(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.race_not_found') });

    const manga = Manga.findById(req.params.mangaId);
    if (!manga || manga.status !== 'pending') return res.redirect(`/races/${race.id}`);

    const lanes = Manga.getLanes(manga.id);

    // Get all participants for this tanda (for the dropdowns)
    const db = require('../config/database');
    const participants = race.format === 'team'
      ? db.prepare('SELECT id, name, color FROM teams WHERE tanda_id = ? ORDER BY name').all(manga.tanda_id)
      : db.prepare('SELECT id, name FROM drivers WHERE tanda_id = ? AND team_id IS NULL ORDER BY name').all(manga.tanda_id);

    res.render('races/manga-edit', {
      t: req.t, race, manga, lanes, participants, LANE_COLORS: LaneColors.forRace(race)
    });
  }

  // POST /races/:id/mangas/:mangaId/edit
  static updateManga(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.race_not_found') });

    const manga = Manga.findById(req.params.mangaId);
    if (!manga || manga.status !== 'pending') return res.redirect(`/races/${race.id}`);

    // assignments: { [mlId]: entityId }
    const raw = req.body.assignment || {};
    const assignments = Object.entries(raw).map(([mlId, entityId]) => ({
      mlId:     parseInt(mlId, 10),
      teamId:   race.format === 'team'       ? parseInt(entityId, 10) : null,
      driverId: race.format === 'individual' ? parseInt(entityId, 10) : null,
    }));

    // Cascade rebuild: only if NO manga of any tanda in this race has started.
    const db = require('../config/database');
    const allPending = db.prepare(
      `SELECT COUNT(*) AS n FROM mangas WHERE race_id = ? AND status != 'pending'`
    ).get(race.id).n === 0;

    if (allPending) {
      // Read this manga's slots in their original DB order (by id) so we
      // know the position of each slot in the rotation.
      const originalSlots = db.prepare(
        'SELECT id, lane, is_rest FROM manga_lanes WHERE manga_id = ? ORDER BY id ASC'
      ).all(manga.id);

      // For each slot, find the participant the user assigned to it.
      const assignMap = new Map(assignments.map(a => [a.mlId, a]));
      const laneSequence = Race.getLaneSequence(race);
      const activeLanes  = laneSequence.filter(l => l > 0);
      const entities = [];
      const byLane   = Array(activeLanes.length).fill(null);
      for (const slot of originalSlots) {
        const a = assignMap.get(slot.id);
        if (!a) continue; // shouldn't happen — form sends every slot
        let ent = null;
        if (race.format === 'team') {
          const t = Team.findById(a.teamId);
          if (t) ent = { id: t.id, type: 'team', name: t.name };
        } else {
          const d = Driver.findById(a.driverId);
          if (d) ent = { id: d.id, type: 'driver', name: d.name };
        }
        if (!ent) continue;
        entities.push(ent);
        const k = slot.is_rest ? -1 : activeLanes.indexOf(slot.lane);
        if (k >= 0) byLane[k] = ent;
      }
      // Con carriles libres, esta manga pasa a ser la 1ª con sus mismos huecos.
      const placedOk = !laneSequence.includes(0) && entities.length < activeLanes.length
        && byLane.filter(Boolean).length === entities.length;

      const mode = Tanda.findById(manga.tanda_id)?.empty_lane_mode || 'fixed';
      const schedule = Manga.buildSchedule(laneSequence, placedOk ? byLane : entities, race.passes, race.lane_repeat, mode);

      // Drop all mangas of this tanda (cascade kills manga_lanes) and re-persist.
      // Las vueltas se borran explícitamente: la FK es ON DELETE SET NULL y
      // quedarían huérfanas (manga_id NULL) contaminando medias/proyección.
      db.prepare('DELETE FROM laps WHERE manga_id IN (SELECT id FROM mangas WHERE tanda_id = ?)').run(manga.tanda_id);
      require('../models/Lap').markExternalMutation();
      db.prepare('DELETE FROM mangas WHERE tanda_id = ?').run(manga.tanda_id);
      Manga.persistSchedule(manga.tanda_id, race.id, schedule);

      // Keep tanda status pending after rebuild.
      Tanda.updateStatus(manga.tanda_id, 'pending');
    } else {
      // Some manga has started elsewhere → don't cascade; just save this one.
      Manga.updateLaneAssignments(assignments);
    }

    res.redirect(`/races/${race.id}`);
  }

  // GET /races/:id/tandas/:tandaId/edit
  static editTanda(req, res) {
    const race  = Race.findById(req.params.id);
    const tanda = Tanda.findById(req.params.tandaId);
    if (!race || !tanda || tanda.race_id !== race.id) {
      return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });
    }
    _renderScreen(req, res, race, { tanda });
  }

  // POST /races/:id/tandas/:tandaId/edit
  static updateTanda(req, res) {
    const race  = Race.findById(req.params.id);
    const tanda = Tanda.findById(req.params.tandaId);
    if (!race || !tanda || tanda.race_id !== race.id) {
      return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });
    }
    const body = req.body || {};
    const payload = _payloadOf(body);
    const slots = payload ? payload.tandas?.[0]?.slots : _legacyEditSlots(race, body);
    try {
      TandaBatch.updateTanda(race, tanda, slots, { mode: payload ? payload.mode : undefined, compact: !payload });
    } catch (e) {
      if (!(e instanceof TandaBatch.TandaBatchError)) throw e;
      return _renderScreen(req, res, race, { tanda, errorDetail: e.errors, body, initial: { tandas: [{ slots: TandaBatch.normSlots(slots) }], mode: payload?.mode } });
    }

    // La categoría/coche no mueven los contadores de `laps`: si hay un directo
    // abierto, invalida sus cachés para que el cambio se vea sin esperar.
    try { require('../services/TimingService').invalidateStandingsCaches(); } catch {}

    res.redirect(`/races/${race.id}`);
  }

  // DELETE /races/:id/tandas/:tandaId
  static delete(req, res) {
    Tanda.delete(req.params.tandaId);
    res.redirect(`/races/${req.params.id}`);
  }
}

module.exports = TandaController;
