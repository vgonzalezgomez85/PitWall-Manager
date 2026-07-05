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
const TrainingService     = require('../services/TrainingService');
const CompetitionService  = require('../services/CompetitionTrainingService');
const TimingService       = require('../services/TimingService');
const SerialService       = require('../services/SerialService');
const SocketService       = require('../services/SocketService');
const Settings            = require('../models/Settings');
const Circuit             = require('../models/Circuit');

// Suma de carriles de TODOS los circuitos configurados (DS-300 o BART); 0 si no aplica.
function serialLaneTotal() {
  const mode = Settings.get('serial_mode', '');
  if (mode !== 'serial' && mode !== 'bart') return 0;
  try {
    const cfg = JSON.parse(Settings.get('circuits_serial', '[]'));
    if (Array.isArray(cfg) && cfg.length > 0) {
      return cfg.reduce((sum, c) => sum + (parseInt(c.lanes, 10) || 0), 0);
    }
  } catch {}
  return 0;
}

// ¿Hay una carrera activa con manga pendiente? Si la hay, el GO del DS/sim la
// arranca a ella (prioridad) y NO al entreno → conviene avisar en la vista.
function raceWillStealGo() {
  try {
    const db = require('../config/database');
    return !!db.prepare(
      `SELECT 1 FROM races r JOIN mangas m ON m.race_id = r.id
       WHERE r.status = 'active' AND m.status = 'pending' LIMIT 1`
    ).get();
  } catch { return false; }
}

function lanesFromSettings() {
  const total = serialLaneTotal();
  if (total > 0) return total;                                  // multi-DS: suma de circuitos
  const circuitId = Settings.get('training_circuit_id', '');    // circuito único (legacy)
  if (circuitId) {
    const c = Circuit.findById(parseInt(circuitId, 10));
    if (c) return c.lanes_count;
  }
  return parseInt(Settings.get('sim_lanes', '6'), 10) || 6;     // simulación
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
    // doesn't have to press GO again. Excepción: si hay una manga oficial
    // corriendo, ese GO pertenece a la carrera — training no debe enganchar.
    if (!TrainingService.isActive && SerialService.isDSRunning() && !TimingService.isBusy) {
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
    res.render('training/competition', { t: req.t, circuits, defaultCircuitId, fallbackLanes, serialTotal: serialLaneTotal() });
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
    let numLanes  = circuit ? circuit.lanes_count : Math.max(participants.length, parseInt(Settings.get('sim_lanes', '6'), 10) || 6);
    // Multi-DS: el total físico de carriles (suma de todos los DS) manda, para
    // no perder los cruces de los circuitos superiores (p.ej. el 2º circuito).
    const serialTotal = serialLaneTotal();
    if (serialTotal > 0) numLanes = serialTotal;

    // Secuencia de rotación de carriles (definida con drag-and-drop en el form).
    const rawSeq = req.body.lane_sequence;
    const laneSequence = Array.isArray(rawSeq) ? rawSeq.map(x => parseInt(x, 10)) : [];

    CompetitionService.setup(participants, numLanes, laneSequence);
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
      isSimulating: SerialService.isSimulating,
      isBart:       SerialService.isBart,
      isPaused:     CompetitionService.isPaused,
      raceWillStealGo: raceWillStealGo(),
    });
  }

  // POST /training/competition/stop
  static competitionStop(req, res) {
    CompetitionService.stop();
    try { SerialService.sendStop(); } catch {}   // para el Master BART (no-op DS/sim)
    res.redirect('/training/competition');
  }

  // POST /training/go — GO manual para BART/simulación (no llega el race_started
  // del hardware). Activa el entrenamiento en standby (libre o competición) y
  // arranca el Master BART. sendStart es no-op en DS-300/simulación.
  static go(req, res) {
    const isComp = req.body.mode === 'competition';
    const svc    = isComp ? CompetitionService : TrainingService;
    const dest   = isComp ? '/training/competition/live' : '/training/live';
    if (!svc.isStandby) return res.redirect(dest);

    const durMin = parseInt(req.body.duration_minutes, 10);
    const durationMs = (Number.isFinite(durMin) && durMin > 0) ? durMin * 60000 : null;

    // Semáforo F1 (3s) y al verde activa + arranca el Master — como en carrera.
    const SEMAPHORE_MS = 3000;
    SocketService.emit('race:semaphore');
    setTimeout(() => {
      svc.activate(durationMs);
      SocketService.emit('training:autostart');   // → semáforo verde en el cliente
      try { SerialService.sendStart(); } catch {}
    }, SEMAPHORE_MS);

    if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.json({ ok: true, semaphore: true });
    res.redirect(dest);
  }

  // POST /training/pause — pausa la grabación + pausa el Master BART
  static pause(req, res) {
    const isComp = req.body.mode === 'competition';
    const svc    = isComp ? CompetitionService : TrainingService;
    svc.pause();
    try { SerialService.sendPause(); } catch {}
    SocketService.emit('training:paused');
    if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
    res.redirect(isComp ? '/training/competition/live' : '/training/live');
  }

  // POST /training/resume — semáforo (3s) y reanuda al verde
  static resume(req, res) {
    const isComp = req.body.mode === 'competition';
    const svc    = isComp ? CompetitionService : TrainingService;
    const SEMAPHORE_MS = 3000;
    SocketService.emit('race:semaphore');
    setTimeout(() => {
      svc.resume();
      SocketService.emit('training:resumed');
      try { SerialService.sendResume(); } catch {}
    }, SEMAPHORE_MS);
    if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.json({ ok: true, semaphore: true });
    res.redirect(isComp ? '/training/competition/live' : '/training/live');
  }

  // POST /training/halt — STOP: para el Master y vuelve a standby (conserva datos)
  static halt(req, res) {
    const isComp = req.body.mode === 'competition';
    const svc    = isComp ? CompetitionService : TrainingService;
    svc.stopToStandby();
    try { SerialService.sendStop(); } catch {}
    if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
    res.redirect(isComp ? '/training/competition/live' : '/training/live');
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
    try { SerialService.sendStop(); } catch {}
    res.redirect('/training');
  }

  // POST /training/free/reset
  static freeReset(req, res) {
    TrainingService.resetSession();
    try { SerialService.sendStop(); } catch {}
    res.redirect('/training/free');
  }

  // POST /training/exit — botón "Volver" del header: para y resetea todo
  // (libre y competición) y vuelve a la home.
  static exit(req, res) {
    if (CompetitionService.isReady) CompetitionService.stop();
    TrainingService.resetSession();
    try { SerialService.sendStop(); } catch {}
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
      isSimulating:   SerialService.isSimulating,
      isBart:         SerialService.isBart,
      isPaused:       TrainingService.isPaused,
      raceWillStealGo: raceWillStealGo(),
    });
  }
}

module.exports = TrainingController;
