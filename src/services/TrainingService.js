const SerialService = require('./SerialService');
const SocketService = require('./SocketService');
const Settings      = require('../models/Settings');
const Circuit       = require('../models/Circuit');
const TimingService = require('./TimingService');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

function lanesFromSettings() {
  const circuitId = Settings.get('training_circuit_id', '');
  if (circuitId) {
    const c = Circuit.findById(parseInt(circuitId, 10));
    if (c) return c.lanes_count;
  }
  return parseInt(Settings.get('sim_lanes', '6'), 10) || 6;
}

class TrainingServiceClass {
  constructor() {
    this._standby        = false;
    this._active         = false;
    this._paused         = false;
    this._lanes          = [];
    this._laneData       = new Map();
    this._handler        = null;
    this._startedAt        = null;
    this._durationMs       = null;
    this._pendingDurationMs = null;
    this._sessionRecords   = new Map(); // lane → bestMs, persists until reset

    // Trama 1 del GO: solo prepara y guarda la duración. La activación (cronómetro)
    // se difiere hasta race_started (trama 3, t+3134ms) para que la cuenta atrás
    // comience exactamente cuando la corriente se enciende.
    SerialService.on('race_go', ({ durationMs }) => {
      // Trama 1: guarda duración. No activa todavía — el cronómetro arranca en trama 3.
      if (this._active) return;
      this._pendingDurationMs = durationMs;
      this._paused = false;
      if (!this._standby) {
        this.prepare(lanesFromSettings());
      }
    });

    SerialService.on('race_started', () => {
      // Trama 3: activa el cronómetro y emite training:go.
      if (this._active) return;
      this._paused = false;
      if (this._pendingDurationMs != null) {
        this._durationMs = this._pendingDurationMs;
        this._pendingDurationMs = null;
      }
      if (!this._standby) this.prepare(lanesFromSettings());
      this._activate();
      SocketService.emit('training:go', { durationMs: this._durationMs });
    });

    SerialService.on('race_resumed',  () => { this._paused = false; });
    SerialService.on('race_paused',   () => { this._paused = true;  });
    // Forced stop: preserve lap data, go back to standby to restart same session
    SerialService.on('race_stopped',  () => { if (this._active) this._pauseToStandby(); });
    // Normal end: clear data, standby for new session
    SerialService.on('race_finished', () => { if (this._active) this._resetToStandby(); });
  }

  get isActive()   { return this._active; }
  get isStandby()  { return this._standby && !this._active; }
  get isReady()    { return this._active || this._standby; }
  get startedAt()  { return this._startedAt; }
  get durationMs() { return this._durationMs; }

  getSessionRecords() {
    const out = {};
    for (const [lane, ms] of this._sessionRecords) out[lane] = ms;
    return out;
  }

  // ── Prepare lanes in standby (no recording) ────────────────────────────────
  prepare(lanesCount) {
    if (this._active) this._deactivate();
    this._standby    = true;
    this._startedAt  = null;
    this._durationMs = null;
    this._lanes      = [];
    this._laneData   = new Map();
    for (let i = 1; i <= lanesCount; i++) {
      this._lanes.push(i);
      this._laneData.set(i, { laps: [], chronoLaps: [], sum: 0, count: 0, lastMs: null });
    }
    console.log(`[TrainingService] Standby — ${lanesCount} lanes`);
  }

  // ── Activate from standby: start recording laps ───────────────────────────
  _activate() {
    if (this._active) return;
    this._standby   = false;
    this._active    = true;
    this._paused    = false;
    this._startedAt = Date.now();

    this._handler = ({ lane, lapTimeMs }) => {
      if (!this._active || this._paused || lapTimeMs == null) return;
      const ld = this._laneData.get(lane);
      if (!ld) return;

      ld.count++;
      ld.sum   += lapTimeMs;
      ld.lastMs = lapTimeMs;
      ld.laps.push(lapTimeMs);
      ld.laps.sort((a, b) => a - b);
      ld.chronoLaps.push(lapTimeMs);
      if (ld.chronoLaps.length > 20) ld.chronoLaps.shift();

      // Update session record
      const prevRecord = this._sessionRecords.get(lane);
      const newRecord  = !prevRecord || lapTimeMs < prevRecord;
      if (newRecord) {
        this._sessionRecords.set(lane, lapTimeMs);
        SocketService.emit('training:record', { lane, recordMs: lapTimeMs });
      }

      SocketService.emit('training:lap', {
        lane,
        color:    LANE_COLORS[lane - 1] || '#8b949e',
        lapTimeMs,
        count:  ld.count,
        avgMs:  Math.round(ld.sum / ld.count),
        bestMs: ld.laps[0],
        lastMs: lapTimeMs,
        laps:   [...ld.chronoLaps].reverse(),
      });
    };

    SerialService.on('lane_crossing', this._handler);
    SocketService.emit('training:activated', this.getLanes());
    console.log(`[TrainingService] Activated — ${this._lanes.length} lanes`);
  }

  // ── Deactivate: stop recording, keep lane config ──────────────────────────
  _deactivate() {
    this._active = false;
    if (this._handler) {
      SerialService.off('lane_crossing', this._handler);
      this._handler = null;
    }
  }

  // ── Forced stop: stop recording but keep lap data ─────────────────────────
  _pauseToStandby() {
    this._deactivate();
    this._standby    = true;
    this._startedAt  = null;
    this._durationMs = null;
    SocketService.emit('training:standby', this.getLanes());
    console.log('[TrainingService] Forced stop — data preserved, back to standby');
  }

  // ── Normal end: reset to standby and clear data ───────────────────────────
  _resetToStandby() {
    const lanes = this._lanes.length;
    this._deactivate();
    this.prepare(lanes);
    SocketService.emit('training:standby', this.getLanes());
    console.log('[TrainingService] Session finished — data cleared, standby');
  }

  // ── Manual reset: clear records + full stop ───────────────────────────────
  resetSession() {
    this._sessionRecords.clear();
    const lanes = this._lanes.length || lanesFromSettings();
    this._deactivate();
    this._standby = false;
    this._startedAt = null;
    this._durationMs = null;
    this.prepare(lanes);
    SocketService.emit('training:records_reset');
    SocketService.emit('training:standby', this.getLanes());
    console.log('[TrainingService] Session reset — records cleared');
  }

  // ── Manual stop (Stop button) ─────────────────────────────────────────────
  stop() {
    const lanes = this._lanes.length;
    this._deactivate();
    this._standby = false;
    this._startedAt = null;
    this._durationMs = null;
    this.prepare(lanes || lanesFromSettings());
    SocketService.emit('training:standby', this.getLanes());
    console.log('[TrainingService] Stopped');
  }

  // ── Manual full start (legacy / form submit) ──────────────────────────────
  start(lanesCount) {
    this.prepare(lanesCount);
    this._activate();
  }

  getLanes() {
    return this._lanes.map(lane => {
      const ld = this._laneData.get(lane) || { laps: [], chronoLaps: [], sum: 0, count: 0, lastMs: null };
      return {
        lane,
        color:  LANE_COLORS[lane - 1] || '#8b949e',
        count:  ld.count,
        avgMs:  ld.count > 0 ? Math.round(ld.sum / ld.count) : null,
        bestMs: ld.laps.length > 0 ? ld.laps[0] : null,
        lastMs: ld.lastMs,
        laps:   [...ld.chronoLaps].reverse(),
      };
    });
  }
}

module.exports = new TrainingServiceClass();
