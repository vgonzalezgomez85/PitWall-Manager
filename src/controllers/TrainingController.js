const TrainingService     = require('../services/TrainingService');
const CompetitionService  = require('../services/CompetitionTrainingService');
const TimingService       = require('../services/TimingService');
const SerialService       = require('../services/SerialService');
const Settings            = require('../models/Settings');
const Circuit             = require('../models/Circuit');

function lanesFromSettings() {
  // 1. Sum lanes across all DS-300 circuits when in serial mode.
  if (Settings.get('serial_mode', '') === 'serial') {
    try {
      const cfg = JSON.parse(Settings.get('circuits_serial', '[]'));
      if (Array.isArray(cfg) && cfg.length > 0) {
        const total = cfg.reduce((sum, c) => sum + (parseInt(c.lanes, 10) || 0), 0);
        if (total > 0) return total;
      }
    } catch {}
  }
  // 2. Legacy single training circuit (kept for backwards-compat).
  const circuitId = Settings.get('training_circuit_id', '');
  if (circuitId) {
    const c = Circuit.findById(parseInt(circuitId, 10));
    if (c) return c.lanes_count;
  }
  // 3. Simulation fallback.
  return parseInt(Settings.get('sim_lanes', '6'), 10) || 6;
}

class TrainingController {

  // GET /training — modality selection screen
  static index(req, res) {
    // Only redirect to live if actively recording (not just standby)
    if (TrainingService.isActive) return res.redirect('/training/live');
    TrainingService._standby = false; // clear standby so free/competition can re-prepare
    res.render('training/index', { t: req.t });
  }

  // GET /training/free — start free training standby
  static free(req, res) {
    const expected = lanesFromSettings();
    // Re-prepare when not running and the lane count changed (e.g. circuits
    // added/removed in Settings while in standby).
    if (!TrainingService.isActive && TrainingService.laneCount !== expected) {
      TrainingService.prepare(expected);
    } else if (!TrainingService.isReady) {
      TrainingService.prepare(expected);
    }
    // If the DS-300 is already mid-manga (someone pressed GO before opening
    // this view), skip standby and start recording immediately so the user
    // doesn't have to press GO again.
    if (!TrainingService.isActive && SerialService.isDSRunning()) {
      TrainingService.activate();
      console.log('[TrainingController] /training/free entered with DS already running → auto-activated');
    }
    res.redirect('/training/live');
  }

  // GET /training/competition — setup form (or live if active)
  static competition(req, res) {
    if (CompetitionService.isReady) return res.redirect('/training/competition/live');
    const circuits = Circuit.findAll();
    const defaultCircuitId = parseInt(Settings.get('training_circuit_id', '') || '0', 10) || null;
    const fallbackLanes = parseInt(Settings.get('sim_lanes', '6'), 10) || 6;
    res.render('training/competition', { t: req.t, circuits, defaultCircuitId, fallbackLanes });
  }

  // POST /training/competition/start
  static competitionStart(req, res) {
    const rawParticipants = req.body.participants;
    if (!rawParticipants || !Array.isArray(rawParticipants) && typeof rawParticipants !== 'object') {
      return res.redirect('/training/competition');
    }
    const participants = Object.values(rawParticipants).map(p => ({
      name:  String(p.name || '').trim().slice(0, 30),
      color: String(p.color || '#8b949e'),
    })).filter(p => p.name);

    if (participants.length < 2) return res.redirect('/training/competition');

    // Circuit picked in the form takes precedence; falls back to settings default
    const pickedId = parseInt(req.body.circuit_id || '0', 10);
    const fallbackId = parseInt(Settings.get('training_circuit_id', '') || '0', 10);
    const circuitId = pickedId || fallbackId;
    const circuit   = circuitId ? Circuit.findById(circuitId) : null;
    const numLanes  = circuit ? circuit.lanes_count : Math.max(participants.length, parseInt(Settings.get('sim_lanes', '6'), 10) || 6);

    CompetitionService.setup(participants, numLanes);
    res.redirect('/training/competition/live');
  }

  // GET /training/competition/live
  static competitionLive(req, res) {
    if (!CompetitionService.isReady) return res.redirect('/training/competition');
    res.render('training/live', {
      t:          req.t,
      lanes:      CompetitionService.getLanes(),
      resting:    CompetitionService.getResting(),
      startedAt:  CompetitionService.startedAt,
      durationMs: CompetitionService.durationMs,
      standby:    CompetitionService.isStandby,
      heatNumber: CompetitionService.heatNumber,
    });
  }

  // POST /training/competition/stop
  static competitionStop(req, res) {
    CompetitionService.stop();
    res.redirect('/training/competition');
  }

  // POST /training/start (legacy / manual)
  static start(req, res) {
    if (TimingService.isRunning) {
      return res.status(409).render('error', {
        t: req.t, code: 409,
        message: req.t ? 'A race is already running' : 'A race is already running'
      });
    }
    const lanes = Math.max(1, Math.min(32, parseInt(req.body.lanes, 10) || 6));
    TrainingService.start(lanes);
    res.redirect('/training/live');
  }

  // POST /training/stop
  static stop(req, res) {
    TrainingService.stop();
    res.redirect('/training');
  }

  // POST /training/free/reset
  static freeReset(req, res) {
    TrainingService.resetSession();
    res.redirect('/training/free');
  }

  // POST /training/exit — botón "Volver" del header: para y resetea todo
  // (libre y competición) y vuelve a la home.
  static exit(req, res) {
    if (CompetitionService.isReady) CompetitionService.stop();
    TrainingService.resetSession();
    res.redirect('/');
  }

  // GET /training/live
  static live(req, res) {
    if (!TrainingService.isReady) return res.redirect('/training');
    const lanes = TrainingService.getLanes();
    res.render('training/live', {
      t:              req.t,
      lanes,
      startedAt:      TrainingService.startedAt,
      durationMs:     TrainingService.durationMs,
      standby:        TrainingService.isStandby,
      sessionRecords: TrainingService.getSessionRecords(),
    });
  }
}

module.exports = TrainingController;
