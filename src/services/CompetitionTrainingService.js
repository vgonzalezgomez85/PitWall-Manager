const SerialService = require('./SerialService');
const SocketService = require('./SocketService');
const Settings      = require('../models/Settings');
const Circuit       = require('../models/Circuit');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

class CompetitionTrainingServiceClass {
  constructor() {
    this._participants = []; // [{name, color}]
    this._numLanes     = 0;
    this._heatNumber   = 0;
    this._active       = false;
    this._standby      = false;
    this._paused       = false;
    this._laneMap      = new Map(); // lane → {participantIdx, count, sum, lastMs, laps, chronoLaps}
    this._handler      = null;
    this._startedAt        = null;
    this._durationMs       = null;
    this._pendingDurationMs = null;

    // Trama 1: guarda la duración pero no arranca el cronómetro.
    // Trama 3 (race_started): activa el heat y emite training:go.
    SerialService.on('race_go', ({ durationMs }) => {
      if (!this.isReady) return;
      this._pendingDurationMs = durationMs;
      this._paused = false;
    });

    SerialService.on('race_started', () => {
      if (!this.isReady) return;
      this._paused = false;
      if (this._pendingDurationMs != null) {
        this._durationMs = this._pendingDurationMs;
        this._pendingDurationMs = null;
      }
      if (this._standby && !this._active) this._activate();
      if (this._active) {
        SocketService.emit('training:go', { durationMs: this._durationMs });
      }
    });

    SerialService.on('race_paused',  () => { if (this._active) this._paused = true; });
    SerialService.on('race_resumed', () => { if (this._active) this._paused = false; });
    // Forced stop: preserve heat, don't rotate
    SerialService.on('race_stopped',  () => { if (this._active) this._stopHeat(false); });
    // Normal end: rotate lanes
    SerialService.on('race_finished', () => { if (this._active) this._stopHeat(true); });
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  setup(participants, numLanes) {
    if (this._active) this._deactivate();
    this._participants = participants;
    this._numLanes     = numLanes;
    this._heatNumber   = 0;
    this._prepareHeat();
  }

  // ── Prepare next heat (assign lanes) ─────────────────────────────────────
  //
  // Rotation rules (different from race rotation):
  //   - Slots 0..N-1 are physical lanes (1..N). Slots N..P-1 are rest slots
  //     (where P = total participants).
  //   - Each heat, every participant advances 1 position: lane k → lane k+1,
  //     last lane → rest 1, last rest → lane 1.
  //   - For lane L in heat H: participant index = (L − H + P) mod P.
  _prepareHeat() {
    this._heatNumber++;
    this._active    = false;
    this._standby   = true;
    this._startedAt = null;
    this._durationMs = null;
    this._laneMap   = new Map();

    const P = this._participants.length;
    const N = this._numLanes;

    for (let lane = 1; lane <= N; lane++) {
      const pIdx = P > 0 ? (((lane - this._heatNumber) % P) + P) % P : null;
      this._laneMap.set(lane, {
        participantIdx: pIdx,
        count: 0, sum: 0, lastMs: null,
        laps: [], chronoLaps: [],
      });
    }

    // Compute who is currently resting (for UI), in rotation order:
    // rest slot R (1..P-N) → participant at slot (N + R - 1)
    // → participant index = (N + R − H + P) mod P
    this._restingIdx = [];
    for (let r = 1; r <= Math.max(0, P - N); r++) {
      const pIdx = (((N + r - this._heatNumber) % P) + P) % P;
      this._restingIdx.push(pIdx);
    }

    console.log(`[CompetitionTraining] Heat ${this._heatNumber} prepared — standby (${P} pilots / ${N} lanes / ${this._restingIdx.length} rest)`);
    SocketService.emit('training:standby', this.getLanes());
    SocketService.emit('competition:heat', { heat: this._heatNumber, resting: this._restingNames() });
  }

  _restingNames() {
    return (this._restingIdx || []).map((idx, i) => {
      const p = this._participants[idx];
      return p ? { restNum: i + 1, name: p.name, color: p.color } : null;
    }).filter(Boolean);
  }

  // Public getter for rest slot info (used by views and live updates)
  getResting() { return this._restingNames(); }

  // ── Activate (start recording) ────────────────────────────────────────────
  _activate() {
    this._standby   = false;
    this._active    = true;
    this._paused    = false;
    this._startedAt = Date.now();

    this._handler = ({ lane, lapTimeMs }) => {
      if (!this._active || this._paused || lapTimeMs == null) return;
      const ld = this._laneMap.get(lane);
      if (!ld) return;

      ld.count++;
      ld.sum   += lapTimeMs;
      ld.lastMs = lapTimeMs;
      ld.laps.push(lapTimeMs);
      ld.laps.sort((a, b) => a - b);
      ld.chronoLaps.push(lapTimeMs);
      if (ld.chronoLaps.length > 20) ld.chronoLaps.shift();

      const participant = ld.participantIdx !== null ? this._participants[ld.participantIdx] : null;
      SocketService.emit('training:lap', {
        lane,
        participantName: participant?.name ?? null,
        color:    participant?.color ?? LANE_COLORS[lane - 1] ?? '#8b949e',
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
    console.log(`[CompetitionTraining] Heat ${this._heatNumber} started`);
  }

  _deactivate() {
    this._active = false;
    if (this._handler) {
      SerialService.off('lane_crossing', this._handler);
      this._handler = null;
    }
  }

  // ── Stop heat ─────────────────────────────────────────────────────────────
  _stopHeat(rotate) {
    this._deactivate();
    if (rotate) {
      // Normal end → prepare next heat (lanes rotate)
      this._prepareHeat();
    } else {
      // Forced stop → stay on same heat, reset lap data
      this._standby = true;
      this._startedAt = null;
      this._durationMs = null;
      for (const ld of this._laneMap.values()) {
        ld.count = 0; ld.sum = 0; ld.lastMs = null;
        ld.laps = []; ld.chronoLaps = [];
      }
      SocketService.emit('training:standby', this.getLanes());
      console.log(`[CompetitionTraining] Heat ${this._heatNumber} force-stopped — same heat`);
    }
  }

  // ── Manual stop ───────────────────────────────────────────────────────────
  stop() {
    this._deactivate();
    this._active    = false;
    this._standby   = false;
    this._participants = [];
    this._numLanes  = 0;
    this._heatNumber = 0;
    this._laneMap   = new Map();
    SocketService.emit('training:stopped');
    console.log('[CompetitionTraining] Session stopped');
  }

  // ── Getters ───────────────────────────────────────────────────────────────
  get isActive()    { return this._active; }
  get isStandby()   { return this._standby && !this._active; }
  get isReady()     { return this._active || this._standby; }
  get heatNumber()  { return this._heatNumber; }
  get startedAt()   { return this._startedAt; }
  get durationMs()  { return this._durationMs; }

  getLanes() {
    const lanes = [];
    for (const [lane, ld] of this._laneMap) {
      const participant = ld.participantIdx !== null ? this._participants[ld.participantIdx] : null;
      lanes.push({
        lane,
        participantName: participant?.name ?? null,
        color:  participant?.color ?? LANE_COLORS[lane - 1] ?? '#8b949e',
        count:  ld.count,
        avgMs:  ld.count > 0 ? Math.round(ld.sum / ld.count) : null,
        bestMs: ld.laps.length > 0 ? ld.laps[0] : null,
        lastMs: ld.lastMs,
        laps:   [...ld.chronoLaps].reverse(),
      });
    }
    return lanes.sort((a, b) => a.lane - b.lane);
  }
}

module.exports = new CompetitionTrainingServiceClass();
