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
// Alta y edición de tandas a partir de «casillas» (slots): la casilla i es la
// posición i de la secuencia de carriles de la carrera; null = carril libre.
// Una casilla es { id?, name, categoria?, coche?, catalogId?, members?: [{id?, name}] }.
// Es el único camino que crea participantes y mangas de una tanda: la pantalla
// de tandas (una o varias a la vez), el formulario antiguo y los tests pasan por aquí.

const db            = require('../config/database');
const Race          = require('../models/Race');
const Tanda         = require('../models/Tanda');
const Manga         = require('../models/Manga');
const Team          = require('../models/Team');
const Driver        = require('../models/Driver');
const TeamCatalog   = require('../models/TeamCatalog');
const Names         = require('../utils/participantNames');
const LaneColors    = require('./LaneColors');

const MAX_TANDAS = 40;

// Un fallo por tanda: { key, tanda } (key = errors.<key> en los locales).
class TandaBatchError extends Error {
  constructor(errors) {
    super(errors.map(e => `${e.key}@${e.tanda}`).join(','));
    this.errors = errors;
  }
}

const txt = (v) => String(v ?? '').trim();
const optAttr = (v) => (v === undefined ? undefined : (txt(v) || null));

function normMembers(raw) {
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  return list.map(m => (typeof m === 'string'
    ? { id: null, name: txt(m) }
    : { id: parseInt(m?.id, 10) || null, name: txt(m?.name) }));
}

function normSlot(raw) {
  if (raw == null) return null;
  const s = typeof raw === 'string' ? { name: raw } : raw;
  const name = txt(s.name);
  const catalogId = parseInt(s.catalogId, 10) || null;
  if (!name && !catalogId) return null;
  return {
    id: parseInt(s.id, 10) || null,
    name, catalogId,
    categoria: optAttr(s.categoria),
    coche:     optAttr(s.coche),
    members:   s.members === undefined ? undefined : normMembers(s.members),
  };
}

function normSlots(rawSlots) {
  return (Array.isArray(rawSlots) ? rawSlots : Object.values(rawSlots || {})).slice(0, 200).map(normSlot);
}

function resolvedName(slot) {
  if (!slot) return '';
  if (slot.name) return slot.name;
  return slot.catalogId ? (TeamCatalog.findById(slot.catalogId)?.name || '') : '';
}

function checkSlots(slots, tandaNumber) {
  const errors = [];
  if (!slots.some(Boolean)) errors.push({ key: 'no_participants', tanda: tandaNumber });
  if (Names.duplicatesIn(slots.map(resolvedName).filter(Boolean)).length) {
    errors.push({ key: 'duplicate_participant_form', tanda: tandaNumber });
  }
  return errors;
}

// Crea los participantes de la tanda y devuelve las entidades en el orden de
// las casillas (null = hueco), listas para Manga.buildSchedule.
function insertEntities(race, laneSequence, tandaId, slots) {
  const entities = [];
  if (race.format === 'team') {
    const palette = LaneColors.forRace(race);
    let n = -1;
    slots.forEach((slot, i) => {
      if (!slot) { if (i < laneSequence.length) entities.push(null); return; }
      n++;
      const cat = slot.catalogId ? TeamCatalog.findById(slot.catalogId) : null;
      const base = cat && (!slot.name || Names.normName(cat.name) === Names.normName(slot.name)) ? cat : null;
      const name = slot.name || base?.name || `Equipo ${n + 1}`;
      const teamId = Team.create({
        race_id: race.id, tanda_id: tandaId, name, lane: 0, color: palette[n % palette.length],
        country:   base ? base.country : null,
        // Copa/coche del catálogo como valor de partida (snapshot): editar el
        // catálogo después ya no cambia la carrera.
        categoria: slot.categoria !== undefined ? slot.categoria : (base ? (base.categoria || null) : null),
        coche:     slot.coche     !== undefined ? slot.coche     : (base ? (base.coche     || null) : null),
      });
      const members = slot.members !== undefined ? slot.members.map(m => m.name) : (base ? base.members.map(m => txt(m.name)) : []);
      members.filter(Boolean).forEach(mName => Driver.create({ race_id: race.id, tanda_id: tandaId, team_id: teamId, name: mName }));
      entities.push({ id: teamId, type: 'team', name });
    });
  } else {
    slots.forEach((slot, i) => {
      if (!slot) { if (i < laneSequence.length) entities.push(null); return; }
      const name = resolvedName(slot);
      const id = Driver.create({
        race_id: race.id, tanda_id: tandaId, team_id: null,
        name, lane: i + 1, car_number: i + 1,
        categoria: slot.categoria || null, coche: slot.coche || null,
      });
      entities.push({ id, type: 'driver', name });
    });
  }
  return entities;
}

function normMode(mode) {
  return ['fixed', 'skip'].includes(mode) ? mode : 'rotate';
}

/**
 * Crea varias tandas de golpe: todas o ninguna. `specs` = [{ slots }].
 * Si alguna no vale lanza TandaBatchError con un error por tanda (el número es
 * el que tendrá cada una al crearse). Devuelve los ids creados.
 */
function createTandas(race, specs, mode) {
  const laneSequence = Race.getLaneSequence(race);
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > MAX_TANDAS) {
    throw new TandaBatchError([{ key: 'no_participants', tanda: Tanda.nextNumber(race.id) }]);
  }
  const first = Tanda.nextNumber(race.id);
  const parsed = specs.map(sp => normSlots(sp?.slots));
  const errors = parsed.flatMap((slots, i) => checkSlots(slots, first + i));
  if (errors.length) throw new TandaBatchError(errors);

  const emptyLaneMode = normMode(mode);
  const ids = db.transaction(() => parsed.map(slots => {
    const tandaId = Tanda.create(race.id, emptyLaneMode);
    const entities = insertEntities(race, laneSequence, tandaId, slots);
    Manga.persistSchedule(tandaId, race.id, Manga.buildSchedule(laneSequence, entities, race.passes, race.lane_repeat, emptyLaneMode));
    return tandaId;
  }))();
  if (race.status === 'pending') Race.updateStatus(race.id, 'active');
  return ids;
}

function attrSets(slot) {
  const sets = [], vals = [];
  if (slot.categoria !== undefined) { sets.push('categoria = ?'); vals.push(slot.categoria); }
  if (slot.coche !== undefined)     { sets.push('coche = ?');     vals.push(slot.coche); }
  return { sets, vals };
}

// Solo renombrar (la tanda ya tiene mangas empezadas): no toca el calendario.
// Categoría/coche solo se tocan si se envían: un formulario viejo no los borra.
function renameOnly(race, slots) {
  slots.forEach(slot => {
    if (!slot || !slot.id) return;
    const { sets, vals } = attrSets(slot);
    if (race.format === 'team') {
      if (slot.name) db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(slot.name, slot.id);
      // Por NOMBRE dentro de la carrera: la fila de la tanda y la «maestra» que
      // crea la pole son filas distintas con el mismo nombre.
      if (slot.name && sets.length) {
        db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE race_id = ? AND name = ?`).run(...vals, race.id, slot.name);
      }
      (slot.members || []).forEach(m => {
        if (m.id && m.name) db.prepare('UPDATE drivers SET name = ? WHERE id = ?').run(m.name, m.id);
      });
    } else {
      if (slot.name) db.prepare('UPDATE drivers SET name = ? WHERE id = ?').run(slot.name, slot.id);
      if (sets.length) db.prepare(`UPDATE drivers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, slot.id);
    }
  });
}

/**
 * Guarda los cambios de una tanda. `rawSlots` en posiciones de la secuencia, o,
 * con `compact`, una lista sin huecos que se recoloca en los carriles que la
 * tanda tenía en su 1ª manga (formulario antiguo).
 * Devuelve { restructured }. Lanza TandaBatchError si no vale.
 */
function updateTanda(race, tanda, rawSlots, { mode, compact = false } = {}) {
  const laneSequence = Race.getLaneSequence(race);
  const mangas = Manga.findByTanda(tanda.id);
  const canRestructure = mangas.every(m => m.status === 'pending');
  let slots = normSlots(rawSlots);

  const errors = [];
  if (Names.duplicatesIn(slots.map(resolvedName).filter(Boolean)).length) {
    errors.push({ key: 'duplicate_participant_form', tanda: tanda.number });
  }
  if (canRestructure && !slots.some(Boolean)) errors.push({ key: 'no_participants', tanda: tanda.number });
  if (errors.length) throw new TandaBatchError(errors);

  if (!canRestructure) {
    db.transaction(() => renameOnly(race, slots))();
    return { restructured: false };
  }

  const firstMangaId = mangas.slice().sort((a, b) => a.number - b.number)[0]?.id;
  const firstLanes = firstMangaId ? db.prepare(
    'SELECT lane FROM manga_lanes WHERE manga_id = ? AND is_rest = 0 AND lane > 0'
  ).all(firstMangaId).map(r => r.lane) : [];
  const emptyLaneMode = mode ? normMode(mode) : (tanda.empty_lane_mode || 'fixed');
  if (compact) slots = slots.filter(Boolean);

  db.transaction(() => {
    db.prepare('DELETE FROM laps WHERE manga_id IN (SELECT id FROM mangas WHERE tanda_id = ?)').run(tanda.id);
    require('../models/Lap').markExternalMutation();
    db.prepare('DELETE FROM mangas WHERE tanda_id = ?').run(tanda.id);
    db.prepare('DELETE FROM drivers WHERE tanda_id = ?').run(tanda.id);
    if (race.format === 'team') db.prepare('DELETE FROM teams WHERE tanda_id = ?').run(tanda.id);
    if (mode) Tanda.setEmptyLaneMode(tanda.id, emptyLaneMode);
    let entities = insertEntities(race, laneSequence, tanda.id, slots);
    if (compact) entities = Manga.placeInLanes(laneSequence, firstLanes, entities);
    Manga.persistSchedule(tanda.id, race.id, Manga.buildSchedule(laneSequence, entities, race.passes, race.lane_repeat, emptyLaneMode));
  })();
  return { restructured: true };
}

module.exports = { createTandas, updateTanda, normSlots, TandaBatchError, MAX_TANDAS };
