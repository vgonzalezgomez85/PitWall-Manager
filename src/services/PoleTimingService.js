const SerialService = require('./SerialService');
const SocketService = require('./SocketService');
const PoleSession   = require('../models/PoleSession');

const DEBOUNCE_MS = 2000; // ignore crossings closer than 2s (false triggers)

// Replica el flujo de TrainingService/TimingService para que el cronómetro de
// la pole arranque/pause/termine con las tramas reales del DS-300:
//   - Pulsar "Iniciar" en la UI deja al servicio en STANDBY (sesión registrada,
//     escuchando cruces y cronómetro parado).
//   - Trama 1 race_go    → guarda durationMs si llega.
//   - Trama 3 race_started → activa el cronómetro y empieza a contar tiempo.
//   - race_paused/resumed → pausa/reanuda sin contar el tiempo pausado.
//   - race_stopped/finished → finaliza la sesión (persiste mejor vuelta).
class PoleTimingServiceClass {
  constructor() {
    this.session     = null;
    this._lapHandler = null;
    this._tickInt    = null;
    this._active     = false;   // cronómetro corriendo
    this._standby    = false;   // sesión preparada, esperando GO
    this._paused     = false;
    this._pausedAt   = null;
    this._totalPausedMs = 0;
    this._pendingDurationMs = null;

    // Trama 1: guarda duración (la UI ya sabe la durationMs, pero la real
    // viene del DS-300 al recibir GO; respetamos la del DS-300 si llega).
    SerialService.on('race_go', ({ durationMs }) => {
      if (!this._standby && !this._active) return;
      if (durationMs) this._pendingDurationMs = durationMs;
      this._paused = false;
    });

    // Trama 3: activa el cronómetro real
    SerialService.on('race_started', () => {
      if (!this._standby || this._active) return;
      this._activate();
    });

    SerialService.on('race_paused', () => {
      if (this._active && !this._paused) {
        this._paused   = true;
        this._pausedAt = Date.now();
        SocketService.emit('pole:paused');
        console.log('[PoleTimingService] Paused');
      }
    });

    SerialService.on('race_resumed', () => {
      if (this._active && this._paused) {
        this._totalPausedMs += Date.now() - this._pausedAt;
        this._pausedAt = null;
        this._paused   = false;
        SocketService.emit('pole:resumed');
        console.log('[PoleTimingService] Resumed');
      }
    });

    // Stop manual del DS-300 → abortamos la pole de este piloto (sin guardar
    // tiempo). Finished/timer expiry → guardamos mejor vuelta y avanzamos.
    SerialService.on('race_stopped',  () => { if (this._active || this._standby) this.abort(); });
    SerialService.on('race_finished', () => { if (this._active || this._standby) this.finish(true); });
  }

  // Llamado desde POST /races/:id/pole/participant/start
  // No arranca el cronómetro: queda en standby, esperando el GO del DS-300.
  start({ poleSessionId, entryId, entryName, poleLane, durationMs }) {
    if (this.session) this.stop(false);

    this.session = {
      poleSessionId, entryId, entryName, poleLane, durationMs,
      startTime:    null,
      lapCount:     0,
      bestLapMs:    null,
      lastCrossing: null,
    };
    this._standby = true;
    this._active  = false;
    this._paused  = false;
    this._pausedAt = null;
    this._totalPausedMs = 0;
    this._pendingDurationMs = null;

    // El handler queda registrado pero solo cuenta vueltas cuando _active && !_paused
    this._lapHandler = ({ lane, timestamp, lapTimeMs }) => {
      if (lane !== poleLane) return;
      if (!this._active || this._paused) return;
      this._onCrossing(timestamp, lapTimeMs);
    };
    SerialService.on('lane_crossing', this._lapHandler);

    SocketService.emit('pole:standby', { entryName, poleLane });
    console.log(`[PoleTimingService] Standby — esperando GO para "${entryName}" carril ${poleLane}`);
  }

  _activate() {
    const s = this.session;
    if (!s) return;
    s.startTime    = Date.now();
    s.lastCrossing = s.startTime;
    if (this._pendingDurationMs != null) {
      s.durationMs = this._pendingDurationMs;
      this._pendingDurationMs = null;
    }
    this._active  = true;
    this._standby = false;
    this._paused  = false;
    this._totalPausedMs = 0;

    this._tickInt = setInterval(() => {
      if (this._paused) return;
      const now = Date.now();
      const elapsedMs    = now - s.startTime - this._totalPausedMs;
      const remainingMs  = Math.max(0, s.durationMs - elapsedMs);
      // currentLapMs: tiempo desde el último cruce — útil para la torre
      // de tiempos en vivo y la comparación con el pole actual.
      const currentLapMs = now - s.lastCrossing;
      SocketService.emit('pole:tick', { elapsedMs, remainingMs, currentLapMs });
      if (remainingMs <= 0) {
        clearInterval(this._tickInt);
        this._tickInt = null;
        this.finish(true);
      }
    }, 100);

    SocketService.emit('pole:started', { entryName: s.entryName, durationMs: s.durationMs, poleLane: s.poleLane });
    console.log(`[PoleTimingService] Started "${s.entryName}" carril ${s.poleLane} (durationMs=${s.durationMs})`);
  }

  _onCrossing(timestamp, lapTimeMs) {
    if (!this.session || !this._active) return;
    if (lapTimeMs === null) {
      this.session.lastCrossing = timestamp;
      return;
    }
    const s = this.session;
    const elapsed = timestamp - s.lastCrossing;
    if (elapsed < DEBOUNCE_MS && s.lapCount > 0) return;

    s.lapCount++;
    s.lastCrossing = timestamp;
    const improved = !s.bestLapMs || lapTimeMs < s.bestLapMs;
    if (improved) s.bestLapMs = lapTimeMs;

    const elapsedMs = (timestamp - s.startTime) - this._totalPausedMs;
    SocketService.emit('pole:lap', {
      lapNumber: s.lapCount,
      lapTimeMs,
      bestLapMs: s.bestLapMs,
      elapsedMs,
      improved,
    });
    console.log(`[PoleTimingService] Lap ${s.lapCount} — ${lapTimeMs}ms${improved ? ' ★ best' : ''}`);
  }

  // Finaliza la sesión: persiste la mejor vuelta (timer expirado o race_finished
  // o avance manual al siguiente).
  finish(auto = false) {
    if (!this.session) return null;
    this._teardown();
    const { entryId, entryName, bestLapMs, lapCount } = this.session;
    PoleSession.updateEntryTime(entryId, bestLapMs ?? null);
    SocketService.emit('pole:finished', { entryName, bestLapMs, lapCount, auto });
    console.log(`[PoleTimingService] Finished "${entryName}" — best: ${bestLapMs ?? 'no time'}`);
    this.session = null;
    return { bestLapMs, lapCount };
  }

  // Aborta la sesión: NO persiste tiempo, deja al piloto listo para reintentar
  // desde cero (stop manual del usuario o race_stopped del DS-300).
  abort() {
    if (!this.session) return null;
    this._teardown();
    const { entryName } = this.session;
    SocketService.emit('pole:aborted', { entryName });
    console.log(`[PoleTimingService] Aborted "${entryName}" — sin tiempo guardado, listo para reintentar`);
    this.session = null;
    return null;
  }

  // Compat: stop(auto) sigue funcionando — true = finish, false = abort.
  stop(auto = false) {
    return auto ? this.finish(true) : this.abort();
  }

  _teardown() {
    if (this._tickInt) { clearInterval(this._tickInt); this._tickInt = null; }
    if (this._lapHandler) {
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }
    this._active  = false;
    this._standby = false;
    this._paused  = false;
    this._pausedAt = null;
    this._totalPausedMs = 0;
    this._pendingDurationMs = null;
  }

  get isRunning()       { return this._active; }
  get isStandby()       { return this._standby; }
  get isPaused()        { return this._paused; }
  get currentEntryId()  { return this.session?.entryId ?? null; }
  get currentBestLap()  { return this.session?.bestLapMs ?? null; }
}

module.exports = new PoleTimingServiceClass();
