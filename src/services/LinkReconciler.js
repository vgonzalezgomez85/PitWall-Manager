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
// ── LinkReconciler (ESCLAVO) ─────────────────────────────────────────────────
// Recibe el SNAPSHOT de estado deseado del maestro (por POST /link/state) y lo
// reconcilia en el cronómetro local llamando a los MISMOS métodos públicos de
// TimingService que usan los botones/rutas del operador. NO crea un segundo
// camino de arranque: replica exactamente el bloque softwareGo de
// SessionController.start (startManga + startAllCircuits), pero SIN semáforo
// (arranque inmediato para sincronizar con el verde real del maestro).
//
// apply() es IDEMPOTENTE: si el esclavo ya está en el estado deseado, no hace
// nada. Best-effort: nunca lanza; devuelve { ok, applied, reason }.

const Race          = require('../models/Race');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Team          = require('../models/Team');
const Driver        = require('../models/Driver');
const TimingService = require('../services/TimingService');
const db            = require('../config/database');

class LinkReconciler {
  // Resuelve la carrera local por race_key.
  static _resolveRace(raceKey) {
    if (!raceKey) return null;
    return db.prepare('SELECT * FROM races WHERE race_key = ?').get(raceKey) || null;
  }

  // Resuelve la manga objetivo por (race.id, tandaNumber, mangaNumber).
  static _resolveManga(raceId, tandaNumber, mangaNumber) {
    return db.prepare(`
      SELECT m.* FROM mangas m
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND t.number = ? AND m.number = ?
    `).get(raceId, tandaNumber, mangaNumber) || null;
  }

  // Arranca la manga objetivo replicando el camino softwareGo (sin semáforo).
  static _startTargetManga(race, manga, durationMs) {
    const lanes   = Manga.getLanes(manga.id);
    const tanda   = Tanda.findById(manga.tanda_id);
    const teams   = Team.findByTanda(manga.tanda_id);
    const drivers = Driver.findByTanda(manga.tanda_id);

    TimingService.startManga(manga, race, lanes, teams, drivers, durationMs || null);
    // BART/sim: un único GO arranca TODOS los circuitos (igual que SessionController).
    TimingService.startAllCircuits(durationMs || null);
    if (tanda) Tanda.updateStatus(tanda.id, 'active');
  }

  // Aplica el snapshot. Devuelve { ok, applied, reason }.
  static apply(snap) {
    const out = { ok: true, applied: 'none', reason: null };
    try {
      const raceKey     = snap && snap.raceKey;
      const phase       = snap && snap.phase;
      const tandaNumber = snap && snap.tandaNumber;
      const mangaNumber = snap && snap.mangaNumber;
      const durationMs  = (snap && snap.durationMs > 0) ? snap.durationMs : null;

      // ── phase idle: cerrar la manga activa según CÓMO se cerró en el maestro ─
      //   terminal='cancelled' (stop forzado) → cancelManga() (borra vueltas, a pending)
      //   terminal='finished'/null (fin natural) → stopManga(true) (persiste + arma sig.)
      if (phase === 'idle' || phase == null) {
        if (TimingService.activeMangaId != null) {
          const terminal = snap && snap.terminal;
          if (terminal === 'cancelled') {
            TimingService.cancelManga();
            out.applied = 'cancelled';
            console.log('[LinkReconciler] phase=idle terminal=cancelled → cancelManga()');
          } else {
            TimingService.stopManga(true);
            out.applied = 'stopped';
            console.log(`[LinkReconciler] phase=idle terminal=${terminal || 'finished'} → stopManga(true)`);
          }
        } else {
          out.applied = 'noop_idle';
        }
        return out;
      }

      // ── Resolver carrera local por race_key ───────────────────────────────
      const race = LinkReconciler._resolveRace(raceKey);
      if (!race) {
        out.ok = false;
        out.reason = 'race_not_provisioned';
        console.log(`[LinkReconciler] carrera no provisionada (raceKey=${raceKey})`);
        return out;
      }

      // ── Resolver manga objetivo por (race.id, tandaNumber, mangaNumber) ───
      const target = LinkReconciler._resolveManga(race.id, tandaNumber, mangaNumber);
      if (!target) {
        out.ok = false;
        out.reason = 'manga_not_found';
        console.log(`[LinkReconciler] manga no encontrada (race=${race.id} t=${tandaNumber} m=${mangaNumber})`);
        return out;
      }

      const activeId  = TimingService.activeMangaId;
      const isTarget  = activeId === target.id;
      const isRunning = TimingService.isRunning;
      const isPaused  = TimingService.isPaused;

      if (phase === 'running') {
        if (!isTarget) {
          // El esclavo no corre la manga objetivo. Si corre OTRA, ciérrala antes
          // (best-effort) para no dejar dos abiertas; luego arranca la objetivo.
          if (activeId != null) {
            try { TimingService.stopManga(true); } catch (e) { /* best-effort */ }
          }
          // Si la objetivo ya está finalizada en el esclavo, no re-arrancar.
          const fresh = Manga.findById(target.id);
          if (fresh && fresh.status === 'finished') {
            out.applied = 'skip_finished';
            console.log(`[LinkReconciler] objetivo ya finalizada (manga ${target.id}) — no re-arranco`);
            return out;
          }
          LinkReconciler._startTargetManga(race, target, durationMs);
          out.applied = 'started';
          console.log(`[LinkReconciler] phase=running → startManga (race=${race.id} t=${tandaNumber} m=${mangaNumber} local mangaId=${target.id})`);
        } else if (isPaused) {
          TimingService.resumeManga();
          out.applied = 'resumed';
          console.log(`[LinkReconciler] phase=running → resumeManga (mangaId=${target.id})`);
        } else {
          out.applied = 'noop_running';   // ya en marcha la objetivo → en sync
        }
        return out;
      }

      if (phase === 'paused') {
        if (isTarget && isRunning) {
          TimingService.pauseManga();
          out.applied = 'paused';
          console.log(`[LinkReconciler] phase=paused → pauseManga (mangaId=${target.id})`);
        } else {
          out.applied = 'noop_paused';    // ya pausada o no corre la objetivo
        }
        return out;
      }

      out.applied = 'noop_unknown_phase';
      return out;
    } catch (e) {
      // Nunca lanzar: degradar a modo manual.
      out.ok = false;
      out.reason = 'error';
      out.error = e.message;
      console.log(`[LinkReconciler] error aplicando snapshot: ${e.message}`);
      return out;
    }
  }
}

module.exports = LinkReconciler;
