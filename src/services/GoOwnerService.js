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
// Reúne el estado real y le pregunta a `lib/goOwner` de quién es el próximo GO.
// La petición de la carrera (`_claimRaceId`) vive en memoria: tras un reinicio
// solo sobrevive la tanda a medias, que se lee de la BD.
const { decideGoOwner, canCede } = require('../lib/goOwner');

class GoOwnerService {
  constructor() {
    this._claimRaceId = null;
    this._lastKey     = null;
  }

  get claimRaceId() { return this._claimRaceId; }

  // Tanda empezada y sin acabar de una carrera activa. Es lo que mantiene la
  // carrera como dueña tras un reinicio a mitad de una resistencia.
  halfTanda() {
    try {
      const db = require('../config/database');
      const row = db.prepare(
        `SELECT t.race_id AS raceId, t.number AS tandaNumber
           FROM tandas t JOIN races r ON r.id = t.race_id
          WHERE r.status = 'active' AND t.status != 'finished'
            AND EXISTS (SELECT 1 FROM mangas m WHERE m.tanda_id = t.id AND m.status = 'finished')
            AND EXISTS (SELECT 1 FROM mangas m WHERE m.tanda_id = t.id AND m.status = 'pending')
          ORDER BY t.race_id, t.number LIMIT 1`
      ).get();
      return row || null;
    } catch { return null; }
  }

  // Una carrera pedida que ya no tiene nada que correr (finalizada, borrada)
  // no puede quedarse el GO: se perdería.
  _validClaim() {
    if (this._claimRaceId == null) return null;
    try {
      const db = require('../config/database');
      const ok = db.prepare(
        `SELECT 1 FROM races r JOIN mangas m ON m.race_id = r.id
          WHERE r.id = ? AND r.status = 'active' AND m.status = 'pending' LIMIT 1`
      ).get(this._claimRaceId);
      return ok ? this._claimRaceId : null;
    } catch { return null; }
  }

  _poleRaceId() {
    try {
      const Pole = require('./PoleTimingService');
      if (!Pole.session || !(Pole.isStandby || Pole.isRunning || Pole.isPaused)) return null;
      const db = require('../config/database');
      // Solo una sesión viva: al pasar del último piloto sin GO, la pole se
      // cierra en la BD pero el servicio puede seguir armado en memoria.
      const row = db.prepare(
        "SELECT race_id FROM pole_sessions WHERE id = ? AND status IN ('in_progress', 'timing')"
      ).get(Pole.session.poleSessionId);
      return row ? row.race_id : null;
    } catch { return null; }
  }

  // El mismo límite de tanda que comprueba app.js al buscar la manga: la última
  // manga corrida es de otra tanda que la primera pendiente y nadie ha preparado
  // esta (tras un reinicio el límite en memoria se pierde, la BD no).
  _dbTandaBoundary(raceId) {
    try {
      const TimingService = require('./TimingService');
      if (TimingService._pendingSetup?.race?.id === raceId) return false;
      const db = require('../config/database');
      const last = db.prepare(
        `SELECT tanda_id FROM mangas WHERE race_id = ? AND status = 'finished' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1`
      ).get(raceId);
      const next = require('../models/Manga').findFirstPending(raceId);
      return !!(last && next && last.tanda_id !== next.tanda_id);
    } catch { return false; }
  }

  snapshot() {
    const TimingService = require('./TimingService');
    const SocketService = require('./SocketService');
    const SerialService = require('./SerialService');
    const halfTanda   = this.halfTanda();
    const claimRaceId = this._validClaim();
    const raceId      = halfTanda ? halfTanda.raceId : claimRaceId;
    return {
      mangaRaceId:   TimingService.activeRaceId,
      poleRaceId:    this._poleRaceId(),
      halfTanda,
      claimRaceId,
      tandaBoundary: TimingService._tandaBoundary === true || (raceId != null && this._dbTandaBoundary(raceId)),
      liveViewer:    SocketService.hasLocalLiveViewer(),
      simReplay:     !!SerialService._simReplay,
    };
  }

  decide() {
    const s = this.snapshot();
    return { ...decideGoOwner(s), halfTanda: s.halfTanda };
  }

  // ¿Se aparta el entreno de este GO?
  trainingYields() { return this.decide().owner !== 'training'; }

  // Lo que ven el aviso del entreno y la franja del directo.
  publicState() {
    const d = this.decide();
    let raceName = null;
    if (d.raceId != null) {
      try { raceName = require('../models/Race').findById(d.raceId)?.name || null; } catch {}
    }
    return {
      owner:       d.owner,
      reason:      d.reason,
      raceId:      d.raceId,
      raceName,
      claimed:     d.claimed,
      tandaNumber: d.reason === 'tanda_half' ? d.halfTanda.tandaNumber : null,
      canCede:     canCede(d),
    };
  }

  claimRace(raceId, why) {
    raceId = parseInt(raceId, 10);
    if (!Number.isFinite(raceId)) return;
    if (this._claimRaceId !== raceId) console.log(`[GoOwner] La carrera ${raceId} pide el GO (${why})`);
    this._claimRaceId = raceId;
    this.notify();
  }

  release(why) {
    if (this._claimRaceId != null) console.log(`[GoOwner] La carrera ${this._claimRaceId} suelta el GO (${why})`);
    this._claimRaceId = null;
    this.notify();
  }

  // El entreno se queda el GO si nadie lo está usando de verdad.
  cedeToTraining(why) {
    const d = this.decide();
    if (d.owner === 'race' && !canCede(d)) return false;
    if (d.owner === 'pole') return false;
    if (this._claimRaceId != null) this.release(why);
    return true;
  }

  // Avisa a las pantallas solo si cambia algo visible.
  notify() {
    try {
      const st  = this.publicState();
      const key = JSON.stringify(st);
      if (key === this._lastKey) return;
      this._lastKey = key;
      require('./SocketService').emit('go:owner', st);
    } catch {}
  }
}

module.exports = new GoOwnerService();
