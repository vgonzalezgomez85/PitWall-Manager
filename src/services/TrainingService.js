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
  // 1. Con DS-300 (modo serial) o BART (modo bart), suma los carriles de TODOS
  //    los circuitos definidos en circuits_serial. Imprescindible para que
  //    aparezcan todos los carriles (si no, el training prepara solo sim_lanes y
  //    desaparecen carriles: el 2º DS, o los 8 del Master BART).
  if (['serial', 'bart'].includes(Settings.get('serial_mode', ''))) {
    try {
      const cfg = JSON.parse(Settings.get('circuits_serial', '[]'));
      if (Array.isArray(cfg) && cfg.length > 0) {
        const total = cfg.reduce((sum, c) => sum + (parseInt(c.lanes, 10) || 0), 0);
        if (total > 0) return total;
      }
    } catch {}
  }
  // 2. Circuito único de training (legacy).
  const circuitId = Settings.get('training_circuit_id', '');
  if (circuitId) {
    const c = Circuit.findById(parseInt(circuitId, 10));
    if (c) return c.lanes_count;
  }
  // 3. Fallback simulación.
  return parseInt(Settings.get('sim_lanes', '6'), 10) || 6;
}

class TrainingServiceClass {
  constructor() {
    this._standby        = false;
    this._active         = false;
    this._pausedCircuits = new Set();   // circuitos en pausa (multi-DS)
    this._lanes          = [];
    this._laneData       = new Map();
    this._handler        = null;
    this._startedAt        = null;
    this._durationMs       = null;
    this._pendingDurationMs = null;
    this._sessionRecords   = new Map(); // lane → bestMs, persists until reset

    // Trama 1 del GO: limpia datos de la sesión anterior y guarda la duración.
    // La activación (cronómetro) se difiere hasta race_started (trama 3,
    // t+3134ms) para que la cuenta atrás comience exactamente cuando la
    // corriente se enciende. Los récords de carril (_sessionRecords) se
    // PRESERVAN entre GOs — solo se borran con el botón "Reset" manual.
    // El "auto" de training (engancharse a un GO del DS-300) solo aplica
    // cuando NO hay una manga oficial corriendo. Si TimingService está en
    // mitad de una carrera, el mismo GO del DS pertenece a esa manga y
    // training debe quedarse fuera para no registrar datos en paralelo.
    SerialService.on('race_go', ({ durationMs }) => {
      if (this._active) return;
      if (TimingService.isBusy) return;
      this._pendingDurationMs = durationMs;
      this._pausedCircuits.clear();
      this.prepare(lanesFromSettings());
      SocketService.emit('training:standby', this.getLanes());
    });

    SerialService.on('race_started', () => {
      if (this._active) return;
      if (TimingService.isBusy) return;
      this._pausedCircuits.clear();
      if (this._pendingDurationMs != null) {
        this._durationMs = this._pendingDurationMs;
        this._pendingDurationMs = null;
      }
      if (!this._standby) this.prepare(lanesFromSettings());
      this._activate();
      SocketService.emit('training:go', { durationMs: this._durationMs });
    });

    // Pausa POR CIRCUITO: cada DS pausa solo sus carriles.
    SerialService.on('race_paused',  ({ circuit } = {}) => { this._setCircuitPaused(circuit || 0, true);  });
    SerialService.on('race_resumed', ({ circuit } = {}) => { this._setCircuitPaused(circuit || 0, false); });
    // Forced stop: preserve lap data, go back to standby to restart same session
    SerialService.on('race_stopped',  () => { if (this._active) this._pauseToStandby(); });
    // Normal end: clear data, standby for new session
    SerialService.on('race_finished', () => { if (this._active) this._resetToStandby(); });
  }

  get isActive()   { return this._active; }
  get isStandby()  { return this._standby && !this._active; }
  get isReady()    { return this._active || this._standby; }
  get laneCount()  { return this._lanes.length; }
  get startedAt()  { return this._startedAt; }
  get durationMs() { return this._durationMs; }

  getSessionRecords() {
    const out = {};
    for (const [lane, ms] of this._sessionRecords) out[lane] = ms;
    return out;
  }

  // ── Pausa por circuito ──────────────────────────────────────────────────────
  // Marca/desmarca un circuito como pausado y avisa al cliente para que atenúe
  // sus carriles. Solo afecta a los cruces de ese circuito; los demás siguen.
  _setCircuitPaused(ci, paused) {
    if (paused) this._pausedCircuits.add(ci);
    else        this._pausedCircuits.delete(ci);
    SocketService.emit('training:circuit_state', {
      circuit: ci,
      status:  paused ? 'paused' : 'running',
      lanes:   SerialService.lanesOfCircuit(ci),
    });
    console.log(`[TrainingService] Circuito ${ci + 1} ${paused ? 'pausado' : 'reanudado'}`);
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

  // Activación pública desde standby (GO manual en simulación/BART, donde no
  // llega el race_started del hardware). durationMs → countdown; null → cuenta
  // hacia arriba. Emite training:go para que el cliente fije el cronómetro.
  activate(durationMs = null) {
    if (!this._standby || this._active) return;
    if (durationMs != null) this._durationMs = durationMs;
    this._activate();
    SocketService.emit('training:go', { durationMs: this._durationMs });
  }

  // Pausa/reanuda la grabación (botón PAUSE en BART/sim). Reusa _pausedCircuits:
  // BART es un Master = circuito 0, así que pausar el 0 pausa todos sus carriles.
  pause()  { if (this._active) this._setCircuitPaused(0, true); }
  resume() { if (this._active) this._setCircuitPaused(0, false); }
  get isPaused() { return this._active && this._pausedCircuits.has(0); }

  // STOP que conserva los datos y vuelve a standby (se puede dar GO otra vez).
  stopToStandby() { if (this._active) this._pauseToStandby(); }

  // ── Activate from standby: start recording laps ───────────────────────────
  _activate() {
    if (this._active) return;
    this._standby   = false;
    this._active    = true;
    this._pausedCircuits.clear();
    this._startedAt = Date.now();

    this._handler = ({ lane, lapTimeMs, circuit }) => {
      if (!this._active || lapTimeMs == null) return;
      if (this._pausedCircuits.has(circuit || 0)) return;   // circuito pausado → ignora su cruce
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
