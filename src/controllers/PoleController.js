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
      LANE_COLORS, isTimingRunning, durationMs, poleBestMs, poleHolder
    });
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

    res.render('races/pole-lanes', {
      t: req.t, race, session, entries, laneSequence: laneSeq, activeLanes, LANE_COLORS
    });
  }

  // POST /races/:id/pole/lanes  — create tanda from lane assignments
  static assignLanes(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const session = PoleSession.findByRace(race.id);
    if (!session) return res.redirect(`/races/${race.id}`);

    // order[] = entity names in laneSequence position order (index 0 → laneSeq[0], etc.)
    const order      = Array.isArray(req.body.order) ? req.body.order : [req.body.order].filter(Boolean);
    const laneSeq    = Race.getLaneSequence(race);
    const allEntries = PoleSession.getEntriesSorted(session.id);
    const byName     = Object.fromEntries(allEntries.map(e => [e.entity_name, e]));

    const activeLanes   = laneSeq.filter(l => l > 0);
    const pickedNames   = order.slice(0, activeLanes.length).filter(Boolean);
    const remaining     = allEntries.filter(e => !pickedNames.includes(e.entity_name));
    const orderedEntries = [
      ...pickedNames.map(n => byName[n] || { entity_name: n, entity_type: race.format === 'team' ? 'team' : 'driver', members_json: null }),
      ...remaining
    ];

    const tandaId = Tanda.create(race.id);
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

    if (race.status === 'pending') Race.updateStatus(race.id, 'active');

    res.redirect(`/races/${race.id}`);
  }
}

module.exports = PoleController;
