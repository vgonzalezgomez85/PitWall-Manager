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
const Race               = require('../models/Race');
const PoleSession        = require('../models/PoleSession');
const PoleTimingService  = require('../services/PoleTimingService');
const Driver             = require('../models/Driver');
const Team               = require('../models/Team');
const Tanda              = require('../models/Tanda');
const Manga              = require('../models/Manga');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

// Tamaños de cada circuito (caja) de la carrera: [8,8,8] = 3 cajas de 8. Prefiere
// la config del circuito asignado; si no, circuits_config; si no, todo en uno.
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

function parseTimeMs(str) {
  str = (str || '').trim();
  if (!str) return null;
  let ms;
  if (str.includes(':')) {
    const [m, s] = str.split(':');
    ms = parseInt(m, 10) * 60000 + parseFloat(s) * 1000;
  } else {
    ms = parseFloat(str) * 1000;
  }
  return isNaN(ms) ? null : Math.round(ms);
}

class PoleController {

  // GET /races/:id/pole/setup  — choose lane, view participant list
  static setup(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });
    if (!race.has_pole) return res.redirect(`/races/${race.id}`);

    const session = PoleSession.findByRace(race.id);
    if (!session) return res.redirect(`/races/${race.id}`);

    // Allow setup when: not started yet ('setup'), or in_progress/timing but no participant timed yet
    const canSetup = session.status === 'setup' ||
      (['in_progress', 'timing'].includes(session.status) && session.current_idx === 0);
    if (!canSetup) {
      if (session.status === 'done') return res.redirect(`/races/${race.id}/pole/results`);
      return res.redirect(`/races/${race.id}/pole/timing`);
    }

    const entries = PoleSession.getEntriesOrdered(session.id);
    res.render('races/pole-setup', {
      t: req.t, race, session, entries, LANE_COLORS, errors: [], body: {}
    });
  }

  // POST /races/:id/pole/start  — set lane, shuffle, begin
  static startPole(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    // Allow start/reset if no participant has been timed yet
    const canStart = session && session.current_idx === 0 && session.status !== 'done';
    if (!canStart) return res.redirect(`/races/${race.id}/pole/timing`);

    const lane = parseInt(req.body.pole_lane, 10);
    if (isNaN(lane) || lane < 1 || lane > race.lanes_count) {
      const entries = PoleSession.getEntriesOrdered(session.id);
      return res.render('races/pole-setup', {
        t: req.t, race, session, entries, LANE_COLORS, errors: ['pole_lane_invalid'], body: req.body
      });
    }

    // Orden explícito desde el form (lo decide el usuario con el botón 🎲);
    // si no llega, se respeta el orden ya guardado en BD.
    const orderRaw = (req.body.entry_order || '').trim();
    const orderedIds = orderRaw
      ? orderRaw.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
      : null;

    PoleSession.startPole(session.id, lane, orderedIds);
    res.redirect(`/races/${race.id}/pole/timing`);
  }

  // GET /races/:id/pole/timing  — live timing page
  static timing(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session) return res.redirect(`/races/${race.id}`);
    if (session.status === 'setup') return res.redirect(`/races/${race.id}/pole/setup`);
    if (session.status === 'done')  return res.redirect(`/races/${race.id}/pole/results`);

    const entries = PoleSession.getEntriesOrdered(session.id);
    const current = entries[session.current_idx] || null;
    const next    = entries[session.current_idx + 1] || null;
    const done    = entries.filter(e => e.order_idx < session.current_idx);

    const durationMs      = (race.manga_duration_minutes || 5) * 60000;

    // Si hay piloto pendiente y el servicio no está activo/standby, lo dejamos
    // ya en standby aquí — así un GO físico inmediato no se pierde por la
    // race condition del POST async desde el cliente.
    if (current && !PoleTimingService.isRunning && !PoleTimingService.isStandby) {
      PoleTimingService.start({
        poleSessionId: session.id,
        entryId:       current.id,
        entryName:     current.entity_name,
        poleLane:      session.lane,
        durationMs,
        minLapMs:      race.min_lap_ms || 0,
      });
    }
    const isTimingRunning = PoleTimingService.isRunning;

    // Mejor tiempo de la sesión (tiempo a batir para el piloto actual)
    const timedEntries = entries.filter(e => e.lap_time_ms != null);
    const poleBestMs   = timedEntries.length > 0
      ? Math.min(...timedEntries.map(e => e.lap_time_ms))
      : null;
    const poleHolder   = timedEntries.length > 0
      ? timedEntries.reduce((a, b) => a.lap_time_ms <= b.lap_time_ms ? a : b)
      : null;

    res.render('races/pole-timing', {
      t: req.t, race, session, entries, current, next, done,
      LANE_COLORS, isTimingRunning, durationMs, poleBestMs, poleHolder,
      omitFirstCrossing: PoleTimingService.omitFirstCrossing,
      poleLocked: timedEntries.length > 0,   // ya hay tiempos → no se puede cambiar la regla
    });
  }

  // POST /races/:id/pole/omit-first  — la organización decide si se omite el
  // primer cruce (out-lap) de cada piloto. Flag de servicio (toda la sesión).
  static setOmitFirstCrossing(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });
    // Bloqueado si ya hay algún tiempo registrado: la regla no puede cambiar a
    // mitad de pole (las vueltas crudas no se guardan → no se puede recalcular
    // a los pilotos ya hechos, quedaría una clasificación incoherente).
    const session = PoleSession.findByRace(race.id);
    const entries = session ? PoleSession.getEntriesOrdered(session.id) : [];
    if (entries.some(e => e.lap_time_ms != null)) {
      return res.status(409).json({ ok: false, locked: true, omitFirstCrossing: PoleTimingService.omitFirstCrossing });
    }
    const value = req.body.value === true || req.body.value === 'true' || req.body.value === '1' || req.body.value === 'on';
    PoleTimingService.omitFirstCrossing = value;
    res.json({ ok: true, omitFirstCrossing: PoleTimingService.omitFirstCrossing });
  }

  // POST /races/:id/pole/participant/start  — begin timing for current participant
  static startParticipant(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });

    const session = PoleSession.findByRace(race.id);
    if (!session || !['in_progress', 'timing'].includes(session.status)) return res.status(400).json({ error: 'not_in_progress' });

    const entries = PoleSession.getEntriesOrdered(session.id);
    const current = entries[session.current_idx];
    if (!current) return res.status(400).json({ error: 'no_current_entry' });

    // Si ya está en standby/running para ESTE mismo piloto, no reiniciamos
    // (el GET /pole/timing pudo prepararlo antes y un abort aquí abriría una
    // ventana donde el GO físico se perdería). Si es otro piloto o estaba
    // inactivo, abortamos para arrancar limpio.
    if (PoleTimingService.currentEntryId === current.id) {
      return res.json({ ok: true, entryName: current.entity_name, alreadyPrepared: true });
    }
    if (PoleTimingService.isRunning || PoleTimingService.isStandby) PoleTimingService.abort();

    const durationMs = (race.manga_duration_minutes || 5) * 60000;
    PoleTimingService.start({
      poleSessionId: session.id,
      entryId:       current.id,
      entryName:     current.entity_name,
      poleLane:      session.lane,
      durationMs,
      minLapMs:      race.min_lap_ms || 0,
    });

    res.json({ ok: true, entryName: current.entity_name, durationMs });
  }

  // POST /races/:id/pole/participant/stop  — stop manual (aborta y reinicia
  // la pole del piloto actual sin guardar tiempo).
  static stopParticipant(req, res) {
    PoleTimingService.abort();
    res.json({ ok: true });
  }

  // POST /races/:id/pole/next  — advance to next participant
  static advanceParticipant(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session || !['in_progress', 'timing'].includes(session.status)) return res.redirect(`/races/${race.id}/pole/results`);

    // Si la pole sigue corriendo, finalizar persistiendo la mejor vuelta
    if (PoleTimingService.isRunning) PoleTimingService.finish(false);

    const entries = PoleSession.getEntriesOrdered(session.id);
    const nextIdx = session.current_idx + 1;

    if (nextIdx >= entries.length) {
      PoleSession.finish(session.id);
      return res.redirect(`/races/${race.id}/pole/results`);
    }

    PoleSession.advanceIdx(session.id, nextIdx);
    res.redirect(`/races/${race.id}/pole/timing`);
  }

  // GET /races/:id/pole/results
  static results(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session) return res.redirect(`/races/${race.id}`);
    if (session.status === 'setup')       return res.redirect(`/races/${race.id}/pole/setup`);
    if (session.status === 'in_progress') return res.redirect(`/races/${race.id}/pole/timing`);

    const entries  = PoleSession.getEntriesSorted(session.id);
    const allTimed = entries.every(e => e.lap_time_ms != null);

    res.render('races/pole-results', {
      t: req.t, race, session, entries, allTimed, LANE_COLORS
    });
  }

  // POST /races/:id/pole/times  — edit times after the fact
  static saveTimes(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session) return res.redirect(`/races/${race.id}`);

    const times = req.body.times || {};
    Object.entries(times).forEach(([entryId, val]) => {
      PoleSession.updateEntryTime(parseInt(entryId, 10), parseTimeMs(val));
    });

    res.redirect(`/races/${race.id}/pole/results`);
  }

  // GET /races/:id/pole/lanes
  static laneSelection(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session || session.status !== 'done') return res.redirect(`/races/${race.id}/pole/results`);

    const entries     = PoleSession.getEntriesSorted(session.id);
    const laneSeq     = Race.getLaneSequence(race);
    const activeLanes = laneSeq.filter(l => l > 0);

    // Carriles agrupados por CIRCUITO (cada caja DS/BART = un bloque de carriles
    // consecutivos, según circuits_config). Dentro de cada circuito, en orden
    // NUMÉRICO (no en la secuencia de cambio de carril). Con un solo circuito no
    // se etiqueta; con varios, la vista rotula "Circuito 1", "Circuito 2", …
    const sizes = _circuitSizesFor(race);
    const circuits = [];
    let off = 0;
    sizes.forEach((size, i) => {
      const lanes = [];
      for (let l = off + 1; l <= off + size; l++) if (activeLanes.includes(l)) lanes.push(l);
      if (lanes.length) circuits.push({ index: i + 1, lanes });
      off += size;
    });

    res.render('races/pole-lanes', {
      t: req.t, race, session, entries, laneSequence: laneSeq, activeLanes, LANE_COLORS, circuits
    });
  }

  // Crea UNA tanda a partir de una lista de entradas ya ordenadas (posición 0 →
  // laneSeq[0], y así). Persiste sus mangas con la rotación de carriles del
  // circuito. Devuelve el id de la tanda. Compartido por el flujo clásico (una
  // tanda) y el multi-tanda: la plantilla de carriles (laneSeq) es la misma en
  // todas, aplicada al orden de pole de cada grupo.
  static _createTandaFromEntries(race, laneSeq, orderedEntries) {
    const tandaId  = Tanda.create(race.id);
    const entities = [];

    if (race.format === 'individual') {
      orderedEntries.forEach((entry, idx) => {
        const driverId = Driver.create({
          race_id: race.id, tanda_id: tandaId, team_id: null,
          name: entry.entity_name, lane: idx + 1, car_number: idx + 1
        });
        entities.push({ id: driverId, type: 'driver', name: entry.entity_name });
      });
    } else {
      orderedEntries.forEach((entry, idx) => {
        const teamId = Team.create({
          race_id: race.id, tanda_id: tandaId,
          name: entry.entity_name, lane: 0, color: LANE_COLORS[idx % LANE_COLORS.length]
        });
        let members = [];
        try { members = JSON.parse(entry.members_json || '[]'); } catch {}
        members.forEach(mName => {
          if (mName?.trim()) Driver.create({ race_id: race.id, tanda_id: tandaId, team_id: teamId, name: mName.trim() });
        });
        entities.push({ id: teamId, type: 'team', name: entry.entity_name });
      });
    }

    const schedule = Manga.buildSchedule(laneSeq, entities);
    Manga.persistSchedule(tandaId, race.id, schedule);
    return tandaId;
  }

  // POST /races/:id/pole/lanes  — create tanda(s) from lane assignments
  static assignLanes(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session) return res.redirect(`/races/${race.id}`);

    const laneSeq    = Race.getLaneSequence(race);
    const allEntries = PoleSession.getEntriesSorted(session.id);   // ya en orden de pole
    const byName     = Object.fromEntries(allEntries.map(e => [e.entity_name, e]));
    const mkEntry    = n => byName[n] || { entity_name: n, entity_type: race.format === 'team' ? 'team' : 'driver', members_json: null };

    // ── Modo multi-tanda ─────────────────────────────────────────────────────
    // La página envía `num_tandas` y, por cada participante colocado,
    // `slot[<nombre>] = "<tanda>:<carril>"` (carril 0 = descanso). El operador
    // coloca a cada piloto en un carril concreto de una tanda (arrastrar/clic).
    // Cada tanda se construye con SU propia secuencia de carriles: el piloto del
    // carril elegido arranca ahí en la manga 1 y rota desde esa posición.
    const numTandas = parseInt(req.body.num_tandas, 10) || 1;
    const slot      = req.body.slot || null;   // { nombre: "tanda:carril" }

    // La pantalla nueva envía `slot` para cualquier nº de tandas (incluida UNA).
    // Sin `slot` (peticiones antiguas con `order[]`) cae al modo clásico de abajo.
    if (slot && typeof slot === 'object' && numTandas >= 1) {
      const activeLanes = laneSeq.filter(l => l > 0);
      const posOfLane   = new Map(activeLanes.map((l, i) => [l, i]));   // carril → orden en laneSeq
      const grupos = Array.from({ length: numTandas }, () => ({ carriles: [], descansos: [] }));

      allEntries.forEach(e => {
        const raw = slot[e.entity_name];
        if (raw == null) return;
        const [tStr, laneStr] = String(raw).split(':');
        const t = parseInt(tStr, 10), lane = parseInt(laneStr, 10);
        if (!(t >= 1 && t <= numTandas)) return;
        if (lane > 0) grupos[t - 1].carriles.push({ lane, entry: e });
        else          grupos[t - 1].descansos.push(e);
      });

      grupos.forEach(g => {
        // Carriles en el orden de la secuencia del circuito; luego los descansos.
        g.carriles.sort((a, b) => (posOfLane.get(a.lane) ?? 99) - (posOfLane.get(b.lane) ?? 99));
        const customSeq = [...g.carriles.map(c => c.lane), ...g.descansos.map(() => 0)];
        const entities  = [...g.carriles.map(c => c.entry), ...g.descansos];
        if (entities.length) PoleController._createTandaFromEntries(race, customSeq, entities);
      });

      if (race.status === 'pending') Race.updateStatus(race.id, 'active');
      return res.redirect(`/races/${race.id}`);
    }

    // ── Modo clásico (una tanda) ─────────────────────────────────────────────
    // order[] = nombres en orden de posición de carril (índice 0 → laneSeq[0]).
    const order         = Array.isArray(req.body.order) ? req.body.order : [req.body.order].filter(Boolean);
    const activeLanes   = laneSeq.filter(l => l > 0);
    const pickedNames   = order.slice(0, activeLanes.length).filter(Boolean);
    const remaining     = allEntries.filter(e => !pickedNames.includes(e.entity_name));
    const orderedEntries = [
      ...pickedNames.map(mkEntry),
      ...remaining
    ];

    PoleController._createTandaFromEntries(race, laneSeq, orderedEntries);

    if (race.status === 'pending') Race.updateStatus(race.id, 'active');
    res.redirect(`/races/${race.id}`);
  }
}

module.exports = PoleController;
