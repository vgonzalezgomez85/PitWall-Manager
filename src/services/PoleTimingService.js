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
    // Omitir el primer cruce (out-lap). Por defecto sí; la organización puede
    // desactivarlo desde la vista de pole. Persiste entre pilotos de la sesión.
    this._omitFirstCrossing = true;

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
  start({ poleSessionId, entryId, entryName, poleLane, durationMs, minLapMs = 0 }) {
    if (this.session) this.stop(false);

    this.session = {
      poleSessionId, entryId, entryName, poleLane, durationMs,
      minLapMs,                       // mínimo de vuelta (Pt): por debajo = cruce espurio
      startTime:    null,
      lapCount:     0,
      bestLapMs:    null,
      lastCrossing: null,
      firstCrossingDone: false,       // el primer cruce (out-lap) siempre se omite
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
    const s = this.session;

    // El PRIMER cruce de cada piloto se omite (si la organización lo activa):
    // es el out-lap (cruce de salida), solo fija la referencia para medir la
    // primera vuelta voladora.
    if (this._omitFirstCrossing && !s.firstCrossingDone) {
      s.firstCrossingDone = true;
      s.lastCrossing = timestamp;
      SocketService.emit('pole:lap_ignored', { reason: 'out_lap' });
      console.log('[PoleTimingService] Primer cruce omitido (out-lap)');
      return;
    }

    if (lapTimeMs === null) {
      s.lastCrossing = timestamp;
      return;
    }
    const elapsed = timestamp - s.lastCrossing;
    if (elapsed < DEBOUNCE_MS && s.lapCount > 0) return;

    // Vuelta por debajo del mínimo (Pt) = cruce espurio (p.ej. 3s cuando la
    // vuelta real es ~11s): se descarta, NO puede convertirse en la mejor.
    if (s.minLapMs > 0 && lapTimeMs < s.minLapMs) {
      s.lastCrossing = timestamp;
      SocketService.emit('pole:lap_ignored', { reason: 'below_min', lapTimeMs });
      console.log(`[PoleTimingService] Vuelta ignorada — ${lapTimeMs}ms < Pt ${s.minLapMs}ms`);
      return;
    }

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
  get omitFirstCrossing() { return this._omitFirstCrossing; }
  set omitFirstCrossing(v) { this._omitFirstCrossing = !!v; }

  // Snapshot puntual del cronómetro para consumidores que no escuchan
  // pole:tick por socket (ej. polling HTTP de la app móvil). Devuelve null
  // si no hay cronómetro corriendo. Tiene en cuenta una pausa en curso.
  getLiveSnapshot() {
    if (!this._active || !this.session) return null;
    const s = this.session;
    const now = Date.now();
    const pausedNow = (this._paused && this._pausedAt) ? (now - this._pausedAt) : 0;
    const totalPaused = this._totalPausedMs + pausedNow;
    const elapsedMs    = Math.max(0, now - s.startTime - totalPaused);
    const remainingMs  = Math.max(0, s.durationMs - elapsedMs);
    const currentLapMs = this._paused ? 0 : Math.max(0, now - s.lastCrossing);
    return {
      elapsedMs,
      remainingMs,
      currentLapMs,
      bestLapMs: s.bestLapMs,
      lapCount:  s.lapCount,
    };
  }
}

module.exports = new PoleTimingServiceClass();
