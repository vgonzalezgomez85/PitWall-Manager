const Race         = require('../models/Race');
const Driver       = require('../models/Driver');
const Team         = require('../models/Team');
const Tanda        = require('../models/Tanda');
const Manga        = require('../models/Manga');
const Lap          = require('../models/Lap');
const PoleSession  = require('../models/PoleSession');
const Circuit      = require('../models/Circuit');
const TimingService = require('../services/TimingService');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

// Default lane sequence: odd lanes ascending, then even lanes descending
// e.g. 6 lanes → [1,3,5,6,4,2]
function defaultSequence(n) {
  const odds  = [];
  const evens = [];
  for (let i = 1; i <= n; i++) {
    if (i % 2 !== 0) odds.push(i); else evens.push(i);
  }
  return [...odds, ...evens.reverse()];
}

class RaceController {

  static index(req, res) {
    const races = Race.findAll();
    res.render('races/index', { t: req.t, races });
  }

  // ─── Step 1: name + type + lanes + manga duration ─────────────────────────

  static newStep1(req, res) {
    req.session.wizard = {};
    res.render('races/new-step1', { t: req.t, errors: [], body: {}, savedCircuits: Circuit.findAll() });
  }

  static postStep1(req, res) {
    const { name, type } = req.body;
    const errors = [];

    const trimmedName = (name || '').trim();
    if (trimmedName.length < 2) errors.push('name_required');
    if (!['club', 'championship'].includes(type)) errors.push('type_required');

    const duration = 99; // DS-300 controls actual duration via GO signal

    // Parse circuit configuration
    const circuitId = parseInt(req.body.circuit_id, 10) || null;
    let circuits = [];
    let minLapMs = 0;

    if (circuitId) {
      const savedCircuit = Circuit.findById(circuitId);
      if (savedCircuit) {
        circuits  = Circuit.getConfig(savedCircuit);
        minLapMs  = savedCircuit.min_lap_ms || 0;
      }
    }

    if (!circuits.length) {
      const numCircuits = Math.max(1, Math.min(6, parseInt(req.body.circuits_count, 10) || 1));
      for (let i = 1; i <= numCircuits; i++) {
        const n = parseInt(req.body[`circuit_lanes_${i}`], 10);
        if (isNaN(n) || n < 2 || n > 8) { errors.push('lanes_invalid'); break; }
        circuits.push(n);
      }
      const minLapS = parseFloat(req.body.min_lap_s);
      minLapMs = (!isNaN(minLapS) && minLapS > 0) ? Math.round(minLapS * 1000) : 0;
    }

    const totalLanes = circuits.reduce((a, b) => a + b, 0);
    if (!errors.includes('lanes_invalid') && (totalLanes < 2 || totalLanes > 32)) {
      errors.push('lanes_invalid');
    }

    if (errors.length) {
      return res.render('races/new-step1', { t: req.t, errors, body: req.body, savedCircuits: Circuit.findAll() });
    }

    req.session.wizard = {
      name: trimmedName, type,
      lanes_count: totalLanes,
      circuits,
      manga_duration_minutes: duration,
      has_pole: req.body.has_pole === '1' ? 1 : 0,
      circuit_id: circuitId,
      min_lap_ms: minLapMs,
    };
    res.redirect('/races/new/step2');
  }

  // ─── Step 2: format ───────────────────────────────────────────────────────

  static newStep2(req, res) {
    if (!req.session.wizard?.name) return res.redirect('/races/new');
    res.render('races/new-step2', { t: req.t, wizard: req.session.wizard, errors: [] });
  }

  static postStep2(req, res) {
    if (!req.session.wizard?.name) return res.redirect('/races/new');
    const { format } = req.body;
    if (!['individual', 'team'].includes(format)) {
      return res.render('races/new-step2', { t: req.t, wizard: req.session.wizard, errors: ['format_required'] });
    }
    const LicenseService = require('../services/LicenseService');
    if (format === 'team' && !LicenseService.has('team_races')) {
      const lang = req.session?.lang || 'es';
      req.session.flash = { type: 'error', text: (lang === 'es'
        ? 'Las carreras por equipos requieren licencia Pro.'
        : 'Team races require a Pro license.')
        + ' <a href="/license">Ver licencia</a>' };
      return res.redirect('/races/new/step2');
    }
    req.session.wizard.format = format;
    res.redirect('/races/new/step3');
  }

  // ─── Step 3: lane rotation sequence ──────────────────────────────────────

  static newStep3(req, res) {
    if (!req.session.wizard?.format) return res.redirect('/races/new');
    const w = req.session.wizard;
    const seq = w.lane_sequence || defaultSequence(w.lanes_count);
    const circuits = w.circuits || [w.lanes_count];
    res.render('races/new-step3-sequence', { t: req.t, wizard: w, sequence: seq, circuits, errors: [] });
  }

  static postStep3(req, res) {
    if (!req.session.wizard?.format) return res.redirect('/races/new');
    const raw = req.body.lane_sequence || '';
    // Allow 0 for explicit rest slots
    const seq = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 0);

    const errors = [];
    const lanes = req.session.wizard.lanes_count;
    const nonRest = seq.filter(n => n > 0);
    const unique  = [...new Set(nonRest)];
    if (unique.length !== lanes || unique.some(n => n < 1 || n > lanes)) {
      errors.push('sequence_invalid');
    }
    if (errors.length) {
      const circuits = req.session.wizard.circuits || [req.session.wizard.lanes_count];
      return res.render('races/new-step3-sequence', {
        t: req.t, wizard: req.session.wizard, sequence: seq, circuits, errors
      });
    }

    req.session.wizard.lane_sequence = seq;
    // If pole enabled, collect participants in step 4 before confirm
    if (req.session.wizard.has_pole) return res.redirect('/races/new/step4');
    res.redirect('/races/new/confirm');
  }

  // ─── Step 4: participants (only when has_pole=1) ──────────────────────────

  static newStep4(req, res) {
    const w = req.session.wizard;
    if (!w?.lane_sequence) return res.redirect('/races/new');
    if (!w.has_pole)       return res.redirect('/races/new/confirm');
    const DriverProfile = require('../models/DriverProfile');
    res.render('races/new-step4', {
      t: req.t, wizard: w, LANE_COLORS, profiles: DriverProfile.findAll(), errors: [], body: {}
    });
  }

  static postStep4(req, res) {
    const w = req.session.wizard;
    if (!w?.lane_sequence) return res.redirect('/races/new');

    const DriverProfile = require('../models/DriverProfile');
    const errors = [];
    let participants = [];

    if (w.format === 'individual') {
      const names = Array.isArray(req.body.drivers) ? req.body.drivers : Object.values(req.body.drivers || {});
      const filled = names.filter(n => n?.trim());
      if (filled.length < 2) errors.push('not_enough_drivers');
      filled.forEach(name => participants.push({ name: name.trim(), members: [] }));
    } else {
      const rawTeams = req.body.teams || {};
      const teamsArr = Array.isArray(rawTeams) ? rawTeams : Object.values(rawTeams);
      const filled   = teamsArr.filter(t => t?.name?.trim());
      if (filled.length < 2) errors.push('not_enough_teams');
      filled.forEach(team => {
        const members = Array.isArray(team.members) ? team.members : Object.values(team.members || {});
        participants.push({
          name: team.name.trim(),
          members: members.filter(m => m?.trim()).map(m => m.trim())
        });
      });
    }

    if (errors.length) {
      return res.render('races/new-step4', {
        t: req.t, wizard: w, LANE_COLORS, profiles: DriverProfile.findAll(), errors, body: req.body
      });
    }

    req.session.wizard.participants = participants;
    res.redirect('/races/new/confirm');
  }

  // ─── Confirm ──────────────────────────────────────────────────────────────

  static newConfirm(req, res) {
    const w = req.session.wizard;
    if (!w?.lane_sequence) return res.redirect('/races/new');
    if (w.has_pole && !w.participants) return res.redirect('/races/new/step4');
    res.render('races/confirm', { t: req.t, wizard: w, LANE_COLORS });
  }

  // ─── POST /races — persist ────────────────────────────────────────────────

  static create(req, res) {
    const wizard = req.session.wizard;
    if (!wizard?.name) return res.redirect('/races/new');

    const raceId = Race.create({
      name:                   wizard.name,
      type:                   wizard.type,
      format:                 wizard.format,
      lanes_count:            wizard.lanes_count,
      lane_sequence:          wizard.lane_sequence,
      manga_duration_minutes: wizard.manga_duration_minutes,
      circuits:               wizard.circuits || [wizard.lanes_count],
      has_pole:               wizard.has_pole || 0,
      circuit_id:             wizard.circuit_id || null,
      min_lap_ms:             wizard.min_lap_ms || 0,
    });

    // If pole enabled, create session + entries from wizard participants
    if (wizard.has_pole && wizard.participants?.length) {
      const sessionId = PoleSession.create(raceId);
      const entityType = wizard.format === 'team' ? 'team' : 'driver';
      wizard.participants.forEach(p => {
        PoleSession.addEntry({
          poleSessionId: sessionId,
          entityType,
          entityName:    p.name,
          membersJson:   p.members?.length ? JSON.stringify(p.members) : null
        });
      });
    }

    req.session.wizard = null;
    res.redirect(`/races/${raceId}`);
  }

  // ─── GET /races/:id ───────────────────────────────────────────────────────

  static show(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    // If a manga is currently active, go straight to live
    const activeManga = Manga.findActive(race.id);
    if (activeManga) return res.redirect(`/races/${race.id}/mangas/${activeManga.id}/live`);

    const laneSequence = Race.getLaneSequence(race);
    const tandas = Tanda.findByRace(race.id);

    // Load mangas + lanes for each tanda
    const tandasWithMangas = tandas.map(tanda => {
      const mangas = Manga.findByTanda(tanda.id);
      const mangasWithLanes = mangas.map(m => ({ ...m, lanes: Manga.getLanes(m.id) }));
      return { ...tanda, mangas: mangasWithLanes };
    });

    // Virtual (projected) standings
    const aggregate  = Lap.aggregateByRace(race.id);
    const scheduled  = Manga.scheduledCountByRace(race.id);
    const schedMap   = {};
    scheduled.forEach(s => { schedMap[`${s.entity_type}:${s.entity_id}`] = s.total_mangas; });

    const virtualStandings = aggregate.map(row => {
      const key           = `${row.entity_type}:${row.entity_id}`;
      const totalScheduled = schedMap[key] ?? row.mangas_raced;
      const avgLaps        = row.mangas_raced > 0 ? row.total_laps / row.mangas_raced : 0;
      const remaining      = Math.max(0, totalScheduled - row.mangas_raced);
      return {
        entity_name:      row.entity_name,
        color:            row.color,
        total_laps:       row.total_laps,
        mangas_raced:     row.mangas_raced,
        total_scheduled:  totalScheduled,
        avg_laps:         Math.round(avgLaps * 10) / 10,
        projected_laps:   Math.round(row.total_laps + avgLaps * remaining),
        exit_count:       row.exit_count || 0,
      };
    }).sort((a, b) => b.projected_laps - a.projected_laps || b.total_laps - a.total_laps);
    virtualStandings.forEach((r, i) => { r.position = i + 1; });

    const poleSession = race.has_pole ? PoleSession.findByRace(race.id) : null;

    // Pre-register the first pending manga so DS-300 GO can start it from this page
    if (!TimingService.isRunning) {
      const firstPending = tandasWithMangas.flatMap(t => t.mangas).find(m => m.status === 'pending');
      if (firstPending) {
        const teams   = Team.findByTanda(firstPending.tanda_id);
        const drivers = Driver.findByTanda(firstPending.tanda_id);
        const lanes   = Manga.getLanes(firstPending.id);
        TimingService.setPendingManga(firstPending, race, lanes, teams, drivers);
      }
    }

    res.render('races/show', {
      t: req.t, race, laneSequence, tandas: tandasWithMangas,
      virtualStandings, LANE_COLORS, poleSession,
    });
  }

  // ─── DELETE /races/:id ────────────────────────────────────────────────────

  static delete(req, res) {
    Race.delete(req.params.id);
    res.redirect('/races');
  }

  // ─── POST /races/:id/complete ─────────────────────────────────────────────

  static complete(req, res) {
    Race.updateStatus(req.params.id, 'finished');
    res.redirect(`/races/${req.params.id}`);
  }
}

module.exports = RaceController;
