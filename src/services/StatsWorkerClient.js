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
// ════════════════════════════════════════════════════════════════════════════
//  CLIENTE DEL WORKER DE STATS (hilo principal).
//
//  Envuelve a `src/workers/statsWorker.js`: arranca el worker_thread, casa
//  peticiones con respuestas por `reqId`, y lo re-arranca si muere. Mientras el
//  worker no esté disponible —o si `PITWALL_NO_WORKER=1`— cae a calcular EN EL
//  HILO (misma función pura `raceProjection`), así el sistema nunca depende del
//  worker para funcionar: solo lo aprovecha para no bloquear el event loop.
//
//  API:
//    start()                         arranca el worker (idempotente, perezoso)
//    stop()                          lo termina y limpia
//    get available                   true si el worker está vivo y listo
//    requestProjection(raceId, deps) → Promise<array>  (deps: solo para el
//                                      camino EN HILO; el worker calcula con su
//                                      propia conexión readonly e ignora deps)
//    invalidate()                    avisa al worker de que `laps` cambió
//                                    (corrección) para que tire sus cachés
//
//  El wiring con TimingService (bucle de refresco mientras hay manga viva,
//  relleno de `_projCache`, envío de invalidate al detectar mutación) es el
//  paso 4 — este módulo no conoce a TimingService.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const path = require('node:path');
const raceProjection = require('../engine/raceProjection');

const WORKER_PATH = path.join(__dirname, '..', 'workers', 'statsWorker.js');

const REQ_TIMEOUT_MS   = 4000;   // una proyección tarda ~100 ms; 4 s es "algo va mal"
const MAX_TIMEOUTS     = 3;      // timeouts seguidos → el worker está tostado, re-arrancar
const RESPAWN_WINDOW_MS = 5 * 60 * 1000;
const RESPAWN_MAX      = 5;      // más de esto en la ventana → nos rendimos, todo en hilo

class StatsWorkerClient {
  constructor() {
    this._worker      = null;
    this._ready       = false;
    this._disabled    = process.env.PITWALL_NO_WORKER === '1';
    this._gaveUp      = false;
    this._reqId       = 0;
    this._pending     = new Map();   // reqId → { resolve, reject, timer }
    this._timeoutRun  = 0;           // timeouts consecutivos
    this._respawnAt   = [];          // epoch ms de los últimos re-arranques
    this._respawnTimer = null;
  }

  get available() {
    return !this._disabled && !this._gaveUp && !!this._worker && this._ready;
  }

  /** El worker existe pero aún no ha mandado `ready` (arrancando / reiniciando). */
  get starting() {
    return !this._disabled && !this._gaveUp && !!this._worker && !this._ready;
  }

  /** Arranca el worker si procede. Idempotente. */
  start() {
    if (this._disabled || this._gaveUp || this._worker) return;
    let Worker;
    try { ({ Worker } = require('node:worker_threads')); }
    catch { this._disabled = true; return; }   // entorno sin worker_threads

    try {
      this._worker = new Worker(WORKER_PATH, {
        env: { ...process.env, PITWALL_DB_READONLY: '1' },
        execArgv: [],   // no heredar --inspect / -r del proceso principal
      });
    } catch (err) {
      console.error('[StatsWorkerClient] no se pudo arrancar el worker:', err.message);
      this._worker = null;
      this._scheduleRespawn();
      return;
    }
    this._worker.unref();   // que no impida cerrar el proceso
    this._worker.on('message', (m) => this._onMessage(m));
    this._worker.on('error',   (e) => this._onExit(e));
    this._worker.on('exit',    (c) => this._onExit(null, c));
  }

  /**
   * Resuelve cuando el worker está listo (o `false` si se agota el tiempo / está
   * deshabilitado). Útil para que TimingService lo tenga caliente al arrancar
   * una manga sin bloquear.
   */
  whenReady(timeoutMs = 3000) {
    if (this._disabled || this._gaveUp) return Promise.resolve(false);
    if (this.available) return Promise.resolve(true);
    this.start();
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.available) return resolve(true);
        if (Date.now() - t0 >= timeoutMs || this._disabled || this._gaveUp) return resolve(false);
        setTimeout(tick, 25).unref?.();
      };
      tick();
    });
  }

  /** Termina el worker y rechaza lo pendiente. */
  async stop() {
    if (this._respawnTimer) { clearTimeout(this._respawnTimer); this._respawnTimer = null; }
    this._rejectAllPending(new Error('stats worker detenido'));
    const w = this._worker;
    this._worker = null;
    this._ready  = false;
    if (w) { try { await w.terminate(); } catch {} }
  }

  /**
   * Proyección de carrera. Resuelve SIEMPRE (nunca rechaza por culpa del worker):
   * si el worker no está o falla, cae a calcular en el hilo con `deps`.
   */
  requestProjection(raceId, deps) {
    if (!this.available) {
      if (!this._disabled && !this._gaveUp) this.start();   // intenta tenerlo listo para la próxima
      return this._inline(raceId, deps);
    }
    return this._rpc({ type: 'projection', raceId })
      .then(m => m.value)
      .catch(() => this._inline(raceId, deps));   // fallo puntual → esta vez, en hilo
  }

  /**
   * Agregados race-wide de live-stats (pace/consistencia/progreso de TODA la
   * carrera). Resuelve SIEMPRE: si el worker no está o falla, cae a calcular en
   * el hilo con `deps` (`{ db, minLapMs, consistency }`).
   */
  requestRaceWide(raceId, deps = {}) {
    const minLapMs = deps.minLapMs || 0;
    if (!this.available) {
      if (!this._disabled && !this._gaveUp) this.start();
      return this._inlineRaceWide(raceId, deps);
    }
    return this._rpc({ type: 'raceWide', raceId, minLapMs })
      .then(m => m.value)
      .catch(() => this._inlineRaceWide(raceId, deps));
  }

  /** Avisa al worker de que `laps` cambió (corrección de vueltas). Fire-and-forget. */
  invalidate() {
    if (this._worker && this._ready) {
      try { this._worker.postMessage({ type: 'invalidate' }); } catch {}
    }
  }

  // ── internos ────────────────────────────────────────────────────────────────

  _inline(raceId, deps) {
    try { return Promise.resolve(raceProjection.buildRaceProjection(raceId, deps || {})); }
    catch (err) { return Promise.reject(err); }
  }

  _inlineRaceWide(raceId, deps) {
    try { return Promise.resolve(require('../engine/raceWideStats').build(raceId, deps || {})); }
    catch (err) { return Promise.reject(err); }
  }

  _rpc(payload) {
    const reqId = ++this._reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        this._onTimeout();
        reject(new Error('stats worker timeout'));
      }, REQ_TIMEOUT_MS);
      this._pending.set(reqId, { resolve, reject, timer });
      try {
        this._worker.postMessage({ ...payload, reqId });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(err);
      }
    });
  }

  _onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') { this._ready = true; this._timeoutRun = 0; return; }

    const p = m.reqId != null ? this._pending.get(m.reqId) : null;
    if (!p) return;
    this._pending.delete(m.reqId);
    clearTimeout(p.timer);
    this._timeoutRun = 0;
    if (m.type === 'error') p.reject(new Error(m.error || 'stats worker error'));
    else                    p.resolve(m);
  }

  _onTimeout() {
    if (++this._timeoutRun >= MAX_TIMEOUTS) {
      console.error(`[StatsWorkerClient] ${this._timeoutRun} timeouts seguidos — re-arrancando el worker`);
      this._recycle();
    }
  }

  _onExit(err, code) {
    if (!this._worker) return;   // stop() intencionado
    if (err) console.error('[StatsWorkerClient] el worker falló:', err.message);
    else     console.error('[StatsWorkerClient] el worker salió con código', code);
    this._recycle();
  }

  /** Tira el worker actual y programa un re-arranque (con tope). */
  _recycle() {
    const w = this._worker;
    this._worker = null;
    this._ready  = false;
    this._rejectAllPending(new Error('stats worker caído'));
    if (w) { try { w.removeAllListeners(); w.terminate(); } catch {} }
    this._scheduleRespawn();
  }

  _scheduleRespawn() {
    if (this._disabled || this._gaveUp || this._respawnTimer) return;
    const now = Date.now();
    this._respawnAt = this._respawnAt.filter(t => now - t < RESPAWN_WINDOW_MS);
    if (this._respawnAt.length >= RESPAWN_MAX) {
      this._gaveUp = true;
      console.error(`[StatsWorkerClient] ${RESPAWN_MAX} caídas en ${RESPAWN_WINDOW_MS / 60000} min — se deja el cálculo en el hilo principal`);
      return;
    }
    const attempt = this._respawnAt.length;
    const delay = Math.min(30000, 1000 * 2 ** attempt);
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      this._respawnAt.push(Date.now());
      this.start();
    }, delay);
    this._respawnTimer.unref?.();
  }

  _rejectAllPending(err) {
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
  }
}

module.exports = new StatsWorkerClient();
