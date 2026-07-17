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
const SerialService = require('./SerialService');
const SocketService = require('./SocketService');

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
    this._minLapMs     = 0;
    this._sessionId    = null;
    this._heatNumber   = 0;
    this._active       = false;
    this._standby      = false;
    this._pausedCircuits = new Set();   // circuitos en pausa (multi-DS)
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
      this._pausedCircuits.clear();
    });

    SerialService.on('race_started', () => {
      if (!this.isReady) return;
      this._pausedCircuits.clear();
      if (this._pendingDurationMs != null) {
        this._durationMs = this._pendingDurationMs;
        this._pendingDurationMs = null;
      }
      if (this._standby && !this._active) this._activate();
      if (this._active) {
        SocketService.emit('training:go', { durationMs: this._durationMs });
      }
    });

    // Pausa POR CIRCUITO: cada DS pausa solo sus carriles.
    SerialService.on('race_paused',  ({ circuit } = {}) => { if (this._active) this._setCircuitPaused(circuit || 0, true);  });
    SerialService.on('race_resumed', ({ circuit } = {}) => { if (this._active) this._setCircuitPaused(circuit || 0, false); });
    // Forced stop: preserve heat, don't rotate
    SerialService.on('race_stopped',  () => { if (this._active) this._stopHeat(false); });
    // Normal end: rotate lanes
    SerialService.on('race_finished', () => { if (this._active) this._stopHeat(true); });
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  // minLapMs = tiempo mínimo de vuelta (Pt). 0 = sin filtro.
  setup(participants, numLanes, laneSequence, minLapMs = 0) {
    if (this._active) this._deactivate();
    // Enriquece cada participante con la bandera del país emparejando su nombre
    // con el catálogo de equipos (los nombres se teclean a mano en competición).
    try {
      const TeamCatalog = require('../models/TeamCatalog');
      const byName = {};
      TeamCatalog.findAll().forEach(t => { if (t.country) byName[(t.name || '').trim().toLowerCase()] = t.country; });
      participants = participants.map(p => ({
        ...p,
        country: p.country || byName[(p.name || '').trim().toLowerCase()] || null,
      }));
    } catch {}
    this._participants = participants;
    this._numLanes     = numLanes;
    this._minLapMs     = Math.max(0, parseInt(minLapMs, 10) || 0);
    this._laneSequence = this._normalizeLaneSequence(laneSequence, numLanes);
    this._sessionId    = `ct-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    this._heatNumber   = 0;
    this._prepareHeat();
  }

  // Valida la secuencia de rotación: debe ser una permutación de 1..N. Si no lo
  // es (o falta), usa el orden natural [1..N].
  _normalizeLaneSequence(seq, n) {
    const natural = Array.from({ length: n }, (_, i) => i + 1);
    if (!Array.isArray(seq)) return natural;
    const cleaned = [...new Set(seq.map(x => parseInt(x, 10)).filter(x => x >= 1 && x <= n))];
    return cleaned.length === n ? cleaned : natural;
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
    const H = this._heatNumber;
    // Ciclo de rotación: secuencia de carriles (orden CONFIGURABLE) + descansos.
    const seq = (this._laneSequence && this._laneSequence.length === N)
      ? this._laneSequence
      : Array.from({ length: N }, (_, i) => i + 1);

    // Inicializa todas las pistas vacías (en el orden de la secuencia).
    for (const lane of seq) {
      this._laneMap.set(lane, {
        participantIdx: null,
        count: 0, sum: 0, lastMs: null,
        laps: [], chronoLaps: [],
      });
    }

    // Cada heat, cada participante avanza una posición en el ciclo:
    //   pos = (k + H − 1) mod P. Si pos < N → corre en seq[pos]; si no, descansa.
    // Con seq = [1..N] reproduce la rotación natural anterior.
    const restByPos = [];
    for (let k = 0; k < P; k++) {
      const pos = (((k + H - 1) % P) + P) % P;
      if (pos < N) {
        const ld = this._laneMap.get(seq[pos]);
        if (ld) ld.participantIdx = k;
      } else {
        restByPos.push({ k, restPos: pos - N });
      }
    }
    restByPos.sort((a, b) => a.restPos - b.restPos);
    this._restingIdx = restByPos.map(x => x.k);

    console.log(`[CompetitionTraining] Heat ${this._heatNumber} prepared — standby (${P} pilots / ${N} lanes / ${this._restingIdx.length} rest)`);
    SocketService.emit('training:standby', this.getLanes());
    SocketService.emit('competition:heat', { heat: this._heatNumber, resting: this._restingNames() });
  }

  _restingNames() {
    return (this._restingIdx || []).map((idx, i) => {
      const p = this._participants[idx];
      return p ? { restNum: i + 1, name: p.name, color: p.color, country: p.country ?? null } : null;
    }).filter(Boolean);
  }

  // Public getter for rest slot info (used by views and live updates)
  getResting() { return this._restingNames(); }

  // ── Pausa por circuito ──────────────────────────────────────────────────────
  _setCircuitPaused(ci, paused) {
    if (paused) this._pausedCircuits.add(ci);
    else        this._pausedCircuits.delete(ci);
    SocketService.emit('training:circuit_state', {
      circuit: ci,
      status:  paused ? 'paused' : 'running',
      lanes:   SerialService.lanesOfCircuit(ci),
    });
    console.log(`[CompetitionTraining] Circuito ${ci + 1} ${paused ? 'pausado' : 'reanudado'}`);
  }

  // Activación pública desde standby (GO manual en simulación/BART). durationMs
  // → countdown. Emite training:go para el cronómetro del cliente.
  activate(durationMs = null) {
    if (!this._standby || this._active) return;
    if (durationMs != null) this._durationMs = durationMs;
    this._activate();
    SocketService.emit('training:go', { durationMs: this._durationMs });
  }

  // Pausa/reanuda la grabación (botón PAUSE en BART/sim). circuito 0 = BART.
  pause()  { if (this._active) this._setCircuitPaused(0, true); }
  resume() { if (this._active) this._setCircuitPaused(0, false); }
  get isPaused() { return this._active && this._pausedCircuits.has(0); }

  // STOP que conserva datos y se queda en el mismo heat (forced stop).
  stopToStandby() { if (this._active) this._stopHeat(false); }

  // ── Activate (start recording) ────────────────────────────────────────────
  _activate() {
    this._standby   = false;
    this._active    = true;
    this._pausedCircuits.clear();
    this._startedAt = Date.now();

    this._handler = ({ lane, lapTimeMs, circuit }) => {
      if (!this._active || lapTimeMs == null) return;
      if (this._pausedCircuits.has(circuit || 0)) return;   // circuito pausado → ignora su cruce
      const ld = this._laneMap.get(lane);
      if (!ld) return;

      // Vuelta fantasma: por debajo del Pt no es una vuelta real (adaptador que
      // repite la trama, doble disparo del puente…). Se descarta entera — ni
      // cuenta, ni entra en la media, ni puede ser la "mejor vuelta". Mismo
      // criterio que la carrera (TimingService), que la marca is_ghost = 1.
      if (this._minLapMs > 0 && lapTimeMs < this._minLapMs) {
        console.log(`[CompetitionTraining] Ghost lap: lane ${lane} (${lapTimeMs}ms < Pt ${this._minLapMs}ms)`);
        SocketService.emit('training:ghost', { lane, lapTimeMs, ptMs: this._minLapMs });
        return;
      }

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

  // Guarda el heat que acaba de terminar. Solo se llama al caer la bandera: un
  // stop forzado descarta el heat (se repite entero), así que no se persiste.
  _saveHeat() {
    const rows = [];
    for (const [lane, ld] of this._laneMap) {
      if (ld.participantIdx === null || ld.count === 0) continue;   // carril vacío o sin cruces
      const p = this._participants[ld.participantIdx];
      if (!p) continue;
      rows.push({
        lane,
        participantName: p.name,
        bestLapMs: ld.laps[0] ?? null,
        avgLapMs:  Math.round(ld.sum / ld.count),
        lapCount:  ld.count,
      });
    }
    if (rows.length === 0) return;
    try {
      const CompetitionTrainingResult = require('../models/CompetitionTrainingResult');
      CompetitionTrainingResult.saveHeat(this._sessionId, this._heatNumber, rows);
      console.log(`[CompetitionTraining] Heat ${this._heatNumber} saved (${rows.length} lanes, session ${this._sessionId})`);
    } catch (err) {
      // Guardar es secundario: si falla, el heat siguiente debe arrancar igual.
      console.error('[CompetitionTraining] No se pudo guardar el heat:', err.message);
    }
  }

  // ── Stop heat ─────────────────────────────────────────────────────────────
  _stopHeat(rotate) {
    this._deactivate();
    if (rotate) {
      // Normal end → save results, then prepare next heat (lanes rotate)
      this._saveHeat();
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
    const endedSessionId = this._sessionId;
    this._active    = false;
    this._standby   = false;
    this._participants = [];
    this._numLanes  = 0;
    this._minLapMs  = 0;
    this._sessionId = null;
    this._heatNumber = 0;
    this._laneMap   = new Map();
    SocketService.emit('training:stopped', { sessionId: endedSessionId });
    console.log('[CompetitionTraining] Session stopped');
  }

  // ── Getters ───────────────────────────────────────────────────────────────
  get isActive()    { return this._active; }
  get isStandby()   { return this._standby && !this._active; }
  get isReady()     { return this._active || this._standby; }
  get sessionId()   { return this._sessionId; }
  get minLapMs()    { return this._minLapMs || 0; }
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
        country: participant?.country ?? null,
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
