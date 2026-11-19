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

const DEBOUNCE_MS = 1500;   // cruces más juntos que esto = falso disparo
const DRAIN_GRACE_MS = 30000;   // margen tras el fin previsto de la caja (como el respaldo de 30 s del DS)

// Warm-up: calentamiento ANTES de una manga. Los coches ruedan sin que arranque la
// carrera: no se guarda ninguna vuelta ni cambia el estado de la manga. Cuando acaba
// (se agota el tiempo, la caja manda fin/STOP o el operador lo termina) la manga sigue
// 'pending' y el siguiente GO es el de la manga de verdad.
//
// Mismo ciclo de vida que PoleTimingService, pero para TODOS los carriles:
//   arm()        → STANDBY, esperando el GO (de la caja DS o de PitWall con BART/TicTac/sim)
//   race_go      → recuerda la duración que marca el DS-300
//   race_started → arranca el cronómetro
//   race_paused / race_resumed → pausa y reanuda sin contar el tiempo parado
//   race_stopped / race_finished / tiempo agotado → fin del warm-up
//
// Con un DS, PitWall no puede parar la caja: si el warm-up se termina antes (o
// el temporizador se adelanta a la caja) queda `draining` hasta que la caja
// mande su STOP/fin, para que sus cruces no arranquen el entreno libre.
//
// Las señales de la caja llegan por GoOwnerService (sesión 'warmup').
class WarmupServiceClass {
  constructor() {
    this.session  = null;
    this._active  = false;
    this._standby = false;
    this._paused  = false;
    this._pausedAt = null;
    this._totalPausedMs = 0;
    this._pendingDurationMs = null;
    this._tickInt = null;
    this._finished = null;    // { raceId, mangaId, lanes } del último warm-up terminado, hasta que se cierra
    this._drainUntil = 0;

    const handlers = {
      race_go:       ({ durationMs }) => { if (durationMs) this._pendingDurationMs = durationMs; this._paused = false; },
      race_started:  () => { if (this._standby && !this._active) this._activate(); },
      race_paused:   () => this._pauseState(),
      race_resumed:  () => this._resumeState(),
      race_stopped:  () => this._boxEnded(false),
      race_finished: () => this._boxEnded(true),
      lane_crossing: (c) => this._onCrossing(c),
    };
    require('./GoOwnerService').attach('warmup', {
      ready:  () => !!this.session && (this._standby || this._active),
      active: () => this._active,
      draining: () => this.isDraining,
      handle: (event, payload) => { if (handlers[event]) handlers[event](payload); },
    });
  }

  // POST …/warmup/arm: deja el warm-up en standby esperando el GO.
  arm({ raceId, mangaId, durationMs, laneNames = {}, minLapMs = 0 }) {
    if (this.session) this._teardownSession(true);
    const laneStats = {};
    Object.keys(laneNames).forEach(l => {
      laneStats[l] = { lane: Number(l), name: laneNames[l], laps: 0, bestLapMs: null, lastCrossing: null };
    });
    this.session = { raceId, mangaId, durationMs, minLapMs, startTime: null, laneStats };
    this._standby = true;
    this._active = false;
    this._paused = false;
    this._pausedAt = null;
    this._totalPausedMs = 0;
    this._pendingDurationMs = null;
    this._finished = null;
    this._drainUntil = 0;
    SocketService.emit('warmup:standby', this._brief());
    require('./GoOwnerService').notify();
    console.log(`[Warmup] Standby — manga ${mangaId} (${Math.round(durationMs / 1000)}s)`);
    return true;
  }

  // GO / pausa / reanudar dados por PitWall (BART, TicTac, simulación).
  go() {
    if (!this._standby || this._active || !this.session) return false;
    this._paused = false;
    try {
      if (SerialService.isSimulating) {
        const n = Object.keys(this.session.laneStats).length;
        if (n > 0) SerialService.startSimulation(n);
      }
    } catch {}
    try { SerialService.sendStart(); } catch {}
    this._activate();
    return true;
  }
  pause()  { if (!this._pauseState())  return false; try { SerialService.sendPause();  } catch {} return true; }
  resume() { if (!this._resumeState()) return false; try { SerialService.sendResume(); } catch {} return true; }

  _pauseState() {
    if (!this._active || this._paused) return false;
    this._paused = true;
    this._pausedAt = Date.now();
    SocketService.emit('warmup:paused', this._brief());
    return true;
  }
  _resumeState() {
    if (!this._active || !this._paused) return false;
    this._totalPausedMs += Date.now() - this._pausedAt;
    this._pausedAt = null;
    this._paused = false;
    SocketService.emit('warmup:resumed', this._brief());
    return true;
  }

  _activate() {
    const s = this.session;
    if (!s) return;
    require('./GoOwnerService').begin('warmup');
    s.startTime = Date.now();
    Object.values(s.laneStats).forEach(l => { l.lastCrossing = s.startTime; });
    if (this._pendingDurationMs != null) { s.durationMs = this._pendingDurationMs; this._pendingDurationMs = null; }
    this._active = true;
    this._standby = false;
    this._paused = false;
    this._totalPausedMs = 0;
    this._drainUntil = 0;

    this._tickInt = setInterval(() => {
      if (this._paused) return;
      const elapsedMs   = Date.now() - s.startTime - this._totalPausedMs;
      const remainingMs = Math.max(0, s.durationMs - elapsedMs);
      SocketService.emit('warmup:tick', { elapsedMs, remainingMs });
      if (remainingMs <= 0) { this.finish(true); this._drainIfBox(0); }
    }, 250);

    SocketService.emit('warmup:started', this._brief());
    require('./GoOwnerService').notify();
    console.log(`[Warmup] Started — manga ${s.mangaId} (durationMs=${s.durationMs})`);
  }

  // Los giros del warm-up solo se enseñan: no se guardan en la BD.
  _onCrossing({ lane, timestamp, lapTimeMs, missed } = {}) {
    if (!this._active || this._paused || !this.session || missed) return;
    const l = this.session.laneStats[lane];
    if (!l) return;
    const prev = l.lastCrossing;
    l.lastCrossing = timestamp;
    if (lapTimeMs == null) return;                       // primer cruce: solo referencia
    if (prev != null && timestamp - prev < DEBOUNCE_MS) return;
    if (this.session.minLapMs > 0 && lapTimeMs < this.session.minLapMs) return;
    l.laps++;
    if (l.bestLapMs == null || lapTimeMs < l.bestLapMs) l.bestLapMs = lapTimeMs;
    SocketService.emit('warmup:lap', { lane: l.lane, name: l.name, laps: l.laps, lapTimeMs, bestLapMs: l.bestLapMs });
  }

  // STOP/fin de la caja: cierra el warm-up en pista o el `draining` que quedaba.
  _boxEnded(auto) {
    if (this.isDraining) { this._drainUntil = 0; return; }
    this.finish(auto);
  }

  // Una caja DS sigue con su carrera aunque PitWall dé el warm-up por terminado.
  _drainIfBox(remainingMs) {
    if (SerialService.softwareGo) return;
    this._drainUntil = Date.now() + Math.max(0, remainingMs || 0) + DRAIN_GRACE_MS;
  }

  _remainingMs() {
    const s = this.session;
    if (!s || !this._active || !s.startTime) return s ? s.durationMs : 0;
    const pausedNow = (this._paused && this._pausedAt) ? Date.now() - this._pausedAt : 0;
    return Math.max(0, s.durationMs - (Date.now() - s.startTime - this._totalPausedMs - pausedNow));
  }

  // Fin del warm-up. `auto` = se agotó el tiempo o la caja dio el fin.
  finish(auto = false) {
    if (!this.session) return null;
    const { raceId, mangaId } = this.session;
    const wasActive = this._active;
    const lanes = this._lanes();
    this._teardownSession(false);
    // sendStop es no-op con un DS (la caja ya corta sola) y para BART/sim/TicTac.
    try { if (wasActive) SerialService.sendStop(); } catch {}
    this._finished = { raceId, mangaId, lanes };   // solo para enseñarlo hasta que se cierre la ventana
    SocketService.emit('warmup:finished', { raceId, mangaId, auto, lanes });
    console.log(`[Warmup] Finished — manga ${mangaId}`);
    return { lanes };
  }

  // «Terminar warm-up»: lo da por cerrado y NO deja rastro. Si estaba en pista corta
  // la fuente; si estaba solo armado o ya terminado, descarta los giros que se veían.
  // Los giros del warm-up nunca se guardaron en la BD: solo existían en memoria.
  discard() {
    const hadSession  = !!this.session;
    const ref         = this.session || this._finished;
    const wasActive   = this._active;
    const remainingMs = this._remainingMs();
    this._finished = null;
    if (wasActive) this._drainIfBox(remainingMs);
    if (hadSession) {
      this._teardownSession(false);
      try { if (wasActive) SerialService.sendStop(); } catch {}
    }
    if (ref) SocketService.emit('warmup:aborted', { raceId: ref.raceId, mangaId: ref.mangaId });
    return !!ref;
  }
  abort() { return this.discard(); }

  // Deja de esperar el GO sin parar la fuente: la manga de verdad lo va a dar ella.
  release() {
    if (!this.session || this._active) return false;
    const { raceId, mangaId } = this.session;
    this._finished = null;
    this._teardownSession(false);
    SocketService.emit('warmup:aborted', { raceId, mangaId });
    return true;
  }

  _teardownSession(silent) {
    if (this._tickInt) { clearInterval(this._tickInt); this._tickInt = null; }
    this.session = null;
    this._active = false;
    this._standby = false;
    this._paused = false;
    this._pausedAt = null;
    this._totalPausedMs = 0;
    this._pendingDurationMs = null;
    if (!silent) setImmediate(() => { try { require('./GoOwnerService').notify(); } catch {} });
  }

  _lanes() {
    if (!this.session) return [];
    return Object.values(this.session.laneStats).map(l => ({ lane: l.lane, name: l.name, laps: l.laps, bestLapMs: l.bestLapMs }));
  }

  _brief() {
    const s = this.session;
    return s ? { raceId: s.raceId, mangaId: s.mangaId, durationMs: s.durationMs, lanes: this._lanes() } : null;
  }

  // Estado para la página del directo (al cargar o recargar).
  snapshot(mangaId) {
    const s = this.session;
    if (s && s.mangaId === mangaId) {
      const remainingMs = this._remainingMs();
      return {
        state: this._active ? (this._paused ? 'paused' : 'running') : 'standby',
        durationMs: s.durationMs, remainingMs, lanes: this._lanes(),
      };
    }
    if (this._finished && this._finished.mangaId === mangaId) {
      return { state: 'done', durationMs: null, remainingMs: 0, lanes: this._finished.lanes };
    }
    return { state: 'idle', durationMs: null, remainingMs: null, lanes: [] };
  }

  get isRunning() { return this._active && !this._paused; }
  get isPaused()  { return this._active && this._paused; }
  get isStandby() { return this._standby; }
  get hasFinished() { return !!this._finished; }
  get isDraining() { return this._drainUntil > Date.now(); }
  get raceId()    { return this.session ? this.session.raceId : null; }
  get mangaId()   { return this.session ? this.session.mangaId : null; }
}

module.exports = new WarmupServiceClass();
