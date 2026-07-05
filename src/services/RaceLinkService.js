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
// ── RaceLinkService (MAESTRO) ────────────────────────────────────────────────
// Cuando link_role==='master', esta instancia (conectada al DS-300) empuja por
// LAN el ESTADO DESEADO de la carrera al esclavo (conectado a BART), que lo
// reconcilia en su propio cronómetro. NO habla con hardware; es PitWall↔PitWall.
//
// Diseño (fijado): envía SNAPSHOTS (estado deseado), no eventos sueltos.
//   { raceKey, phase:'idle'|'running'|'paused', tandaNumber, mangaNumber,
//     durationMs, remainingMs, seq }
// La identidad estable entre las dos BD es (raceKey, tandaNumber, mangaNumber);
// el mangaId NO se transfiere (calendarios idénticos vía import de Fase 0+1).
//
// TODO es aditivo y best-effort: si el link falla, se degrada al modo manual de
// hoy (el maestro sigue cronometrando igual; solo no llega el push).

const SerialService = require('./SerialService');
const TimingService = require('./TimingService');
const { postJson }  = require('../utils/linkHttp');

const DEBOUNCE_MS  = 150;    // coalesce las N señales por-circuito de varios DS
const HEARTBEAT_MS = 3000;   // reconciliación/auto-sanación periódica
const POST_TIMEOUT = 4000;

class RaceLinkService {
  constructor() {
    this._started    = false;
    this._seq        = 0;
    this._debounce   = null;
    this._heartbeat  = null;
    this._listeners  = null;   // refs para poder desuscribir en reconfigure/stop
    this._sending    = false;  // evita solapar dos POST
    this._lastActive = null;   // última manga activa {mangaId,raceKey,tandaNumber,mangaNumber}
  }

  _role()     { return require('../models/Settings').get('link_role', 'off'); }
  _slaveUrl() { return String(require('../models/Settings').get('link_slave_url', '') || '').trim(); }
  _token()    { return String(require('../models/Settings').get('link_token', '') || ''); }

  // Arranca el modo maestro si procede (idempotente). Llamado desde app.js y
  // desde reconfigure() al guardar ajustes.
  startMaster() {
    if (this._role() !== 'master') return;
    if (this._started) return;
    this._started = true;

    const evts = ['race_started', 'race_go', 'race_paused', 'race_resumed', 'race_finished', 'race_stopped'];
    const handler = () => this.scheduleSend();
    this._listeners = evts.map(ev => { SerialService.on(ev, handler); return { ev, handler }; });

    this._heartbeat = setInterval(() => this.send('heartbeat'), HEARTBEAT_MS);
    console.log(`[RaceLink] MAESTRO activo → empuje de estado a ${this._slaveUrl() || '(sin URL)'}`);
    // Envío inicial para sincronizar de inmediato el estado actual.
    this.scheduleSend();
  }

  // Detiene el modo maestro (desuscribe y limpia timers). Idempotente.
  stopMaster() {
    if (!this._started) return;
    this._started = false;
    if (this._listeners) {
      for (const { ev, handler } of this._listeners) SerialService.removeListener(ev, handler);
      this._listeners = null;
    }
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    if (this._debounce)  { clearTimeout(this._debounce);   this._debounce = null; }
    console.log('[RaceLink] MAESTRO detenido');
  }

  // Reaplica la config en caliente (tras POST /link/config).
  reconfigure() {
    if (this._role() === 'master') {
      if (this._started) { this.scheduleSend(); return; }   // ya activo → refresca
      this.startMaster();
    } else {
      this.stopMaster();
    }
  }

  // Coalesce varias señales (los GO por-circuito de varios DS) en 1 envío.
  scheduleSend() {
    if (this._role() !== 'master') return;
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => { this._debounce = null; this.send('event'); }, DEBOUNCE_MS);
  }

  // Construye el snapshot del estado deseado desde TimingService + BD.
  _buildSnapshot() {
    const db = require('../config/database');
    const activeMangaId = TimingService.activeMangaId;

    // Fase derivada del estado del maestro.
    let phase = 'idle';
    if (activeMangaId != null) {
      if (TimingService.isRunning)      phase = 'running';
      else if (TimingService.isPaused)  phase = 'paused';
      else phase = 'idle';   // manga activa pero ni corriendo ni pausada → tratar como idle
    }

    let raceKey = null, tandaNumber = null, mangaNumber = null,
        durationMs = null, remainingMs = null, terminal = null;

    if (activeMangaId != null && phase !== 'idle') {
      const row = db.prepare(`
        SELECT m.number AS mangaNumber, m.actual_duration_ms,
               t.number AS tandaNumber,
               r.race_key AS raceKey, r.manga_duration_minutes
        FROM mangas m
        JOIN tandas t ON t.id = m.tanda_id
        JOIN races  r ON r.id = t.race_id
        WHERE m.id = ?
      `).get(activeMangaId);
      if (row) {
        raceKey     = row.raceKey || null;
        tandaNumber = row.tandaNumber;
        mangaNumber = row.mangaNumber;
        durationMs  = (row.actual_duration_ms && row.actual_duration_ms > 0)
          ? row.actual_duration_ms
          : (row.manga_duration_minutes || 0) * 60000;
        try {
          const st = TimingService.getStandings();
          remainingMs = (st && st.remainingMs > 0) ? st.remainingMs : null;
        } catch { remainingMs = null; }
        // Recuerda la manga activa para poder informar de CÓMO se cerró al pasar a idle.
        this._lastActive = { mangaId: activeMangaId, raceKey, tandaNumber, mangaNumber };
      } else {
        // No se pudo resolver la manga (raro) → degradar a idle para no confundir.
        phase = 'idle';
      }
    }

    // ── idle: hereda la identidad de la última manga activa y DEDUCE el motivo
    // del cierre desde su estado en BD (agnóstico a la fuente: vale para el STOP
    // del DS y para el botón STOP de la UI, que ambos hacen cancelManga):
    //   finished → fin natural  (esclavo: stopManga(true), persiste + arma siguiente)
    //   pending  → stop forzado (esclavo: cancelManga(), borra vueltas + a pending)
    if (phase === 'idle' && this._lastActive) {
      raceKey     = this._lastActive.raceKey;
      tandaNumber = this._lastActive.tandaNumber;
      mangaNumber = this._lastActive.mangaNumber;
      let status = null;
      try { status = (db.prepare('SELECT status FROM mangas WHERE id = ?').get(this._lastActive.mangaId) || {}).status; } catch {}
      terminal = (status === 'finished') ? 'finished' : (status === 'pending' ? 'cancelled' : null);
    }

    return {
      raceKey, phase, terminal, tandaNumber, mangaNumber, durationMs, remainingMs,
      seq: ++this._seq,
    };
  }

  // Envía el snapshot al esclavo. try/catch silencioso (log a debug).
  async send(reason) {
    if (this._role() !== 'master') return;
    const url = this._slaveUrl();
    if (!url) return;
    if (this._sending) return;   // no solapar
    this._sending = true;
    let snap;
    try {
      snap = this._buildSnapshot();
      const base = /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : 'http://' + url;
      const res = await postJson(`${base}/link/state`, snap, {
        timeoutMs: POST_TIMEOUT,
        headers: { 'x-link-token': this._token() },
      });
      if (res.status !== 200) {
        console.log(`[RaceLink] esclavo respondió ${res.status} (${reason}) seq=${snap.seq}`);
      } else if (res.body && res.body.applied) {
        console.log(`[RaceLink] enviado (${reason}) seq=${snap.seq} phase=${snap.phase} → aplicado: ${res.body.applied}`);
      }
    } catch (e) {
      // Best-effort: el link cae, el maestro sigue cronometrando igual.
      console.log(`[RaceLink] envío fallido (${reason})${snap ? ' seq=' + snap.seq : ''}: ${e.message}`);
    } finally {
      this._sending = false;
    }
  }
}

module.exports = new RaceLinkService();
