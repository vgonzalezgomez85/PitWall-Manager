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
//
// Control de neumáticos de resistencia.
//   /races/:id/tires          → página del control de una carrera concreta.
//   /control/tires            → kiosco: auto-detecta la carrera activa.
// Cada clic en un equipo entrega un juego: resta 1 disponible, suma 1 usado, y
// sella en qué manga y minuto:segundo de carrera se hizo. El lápiz abre el
// historial del equipo para editar/borrar/añadir registros a mano.
const Race          = require('../models/Race');
const Manga         = require('../models/Manga');
const TireChange    = require('../models/TireChange');
const TimingService = require('../services/TimingService');
const SocketService = require('../services/SocketService');
const db            = require('../config/database');

// True si la carrera lleva control de neumáticos (resistencia con dotación > 0).
function hasTireControl(race) {
  return !!race && race.type === 'championship' && (race.tire_pairs_per_team || 0) > 0;
}

class TireController {

  // En qué manga / minuto:segundo de carrera estamos AHORA, para sellar un
  // cambio. Prioridad: sesión viva del motor; si no, la manga active/pending de
  // la BD (sin elapsed, porque no hay reloj en marcha).
  static _currentContext(raceId) {
    const S = TimingService.session;
    if (S && S.race && S.race.id === raceId && S.manga) {
      return {
        mangaId:       S.manga.id,
        mangaNumber:   S.manga.number,
        raceElapsedMs: TimingService.getElapsedMs(),
        live:          true,
      };
    }
    const m = Manga.findActive(raceId) || Manga.findFirstPending(raceId);
    return {
      mangaId:       m ? m.id : null,
      mangaNumber:   m ? m.number : null,
      raceElapsedMs: null,
      live:          false,
    };
  }

  // Detecta la carrera de resistencia "en curso" para el kiosco: primero la del
  // motor, luego cualquier championship active con dotación de neumáticos.
  static _detectActiveRace() {
    const rid = TimingService.session && TimingService.session.race && TimingService.session.race.id;
    if (rid) {
      const r = Race.findById(rid);
      if (hasTireControl(r)) return r;
    }
    const row = db.prepare(`
      SELECT id FROM races
      WHERE type = 'championship' AND status = 'active' AND tire_pairs_per_team > 0
      ORDER BY id DESC LIMIT 1
    `).get();
    return row ? Race.findById(row.id) : null;
  }

  // ── Páginas ──────────────────────────────────────────────────────────

  static race(req, res) {
    const race = Race.findById(parseInt(req.params.id, 10));
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });
    TireController._renderPage(req, res, race, { kiosk: false });
  }

  static kiosk(req, res) {
    const race = TireController._detectActiveRace();
    if (!race) {
      return res.render('tires/race', {
        t: req.t, race: null, kiosk: true,
        summary: { allowance: 0, teams: [] }, context: null,
      });
    }
    TireController._renderPage(req, res, race, { kiosk: true });
  }

  static _renderPage(req, res, race, { kiosk }) {
    res.render('tires/race', {
      t: req.t,
      race,
      kiosk,
      enabled: hasTireControl(race),
      summary: TireChange.summaryByRace(race.id),
      context: TireController._currentContext(race.id),
    });
  }

  // ── JSON: estado del grid (refresco en vivo / tras una acción) ─────────

  static snapshot(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const race = Race.findById(raceId);
    if (!race) return res.status(404).json({ ok: false });
    res.json({
      ok: true,
      summary: TireChange.summaryByRace(raceId),
      context: TireController._currentContext(raceId),
    });
  }

  // ── Página: historial GLOBAL (abre en pestaña nueva) ───────────────────

  static logPage(req, res) {
    const race = Race.findById(parseInt(req.params.id, 10));
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });
    res.render('tires/log', {
      t: req.t,
      race,
      enabled: hasTireControl(race),
      log: TireChange.fullHistoryByRace(race.id),
    });
  }

  // ── JSON: historial GLOBAL de la carrera (refresco en vivo de la página) ─

  static log(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const race = Race.findById(raceId);
    if (!race) return res.status(404).json({ ok: false });
    res.json(Object.assign({ ok: true }, TireChange.fullHistoryByRace(raceId)));
  }

  // ── JSON: historial de un equipo ──────────────────────────────────────

  static history(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const teamId = TireChange.canonicalTeamId(raceId, parseInt(req.params.teamId, 10));
    if (!teamId) return res.status(404).json({ ok: false });
    const summary = TireChange.summaryByRace(raceId);
    const team = summary.teams.find(t => t.id === teamId) || null;
    res.json({
      ok: true,
      allowance: summary.allowance,
      team,
      changes: TireChange.historyByTeam(raceId, teamId),
    });
  }

  // ── Acciones (mutación) ───────────────────────────────────────────────

  // Clic en la cajita del equipo: entrega un juego.
  static addChange(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const race = Race.findById(raceId);
    if (!hasTireControl(race)) return res.status(400).json({ ok: false, error: 'no_tire_control' });
    const teamId = TireChange.canonicalTeamId(raceId, parseInt(req.params.teamId, 10));
    if (!teamId) return res.status(404).json({ ok: false, error: 'team_not_found' });

    const ctx = TireController._currentContext(raceId);
    TireChange.add({
      raceId, teamId,
      mangaId:       ctx.mangaId,
      mangaNumber:   ctx.mangaNumber,
      raceElapsedMs: ctx.raceElapsedMs,
      createdAtMs:   Date.now(),
    });
    TireController._broadcast(raceId, res);
  }

  // Historial: añadir un registro a mano (con manga/tiempo explícitos).
  static addManual(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const race = Race.findById(raceId);
    if (!hasTireControl(race)) return res.status(400).json({ ok: false, error: 'no_tire_control' });
    const teamId = TireChange.canonicalTeamId(raceId, parseInt(req.params.teamId, 10));
    if (!teamId) return res.status(404).json({ ok: false, error: 'team_not_found' });

    const { mangaNumber, elapsedMs } = TireController._parseWhen(req.body);
    TireChange.add({
      raceId, teamId,
      mangaId:       TireController._mangaIdForNumber(raceId, mangaNumber),
      mangaNumber,
      raceElapsedMs: elapsedMs,
      note:          (req.body.note || '').trim() || null,
      createdAtMs:   Date.now(),
    });
    TireController._broadcast(raceId, res);
  }

  static updateChange(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const change = TireChange.findById(parseInt(req.params.changeId, 10));
    if (!change || change.race_id !== raceId) return res.status(404).json({ ok: false });
    const { mangaNumber, elapsedMs } = TireController._parseWhen(req.body);
    TireChange.update(change.id, {
      mangaId:       TireController._mangaIdForNumber(raceId, mangaNumber),
      mangaNumber,
      raceElapsedMs: elapsedMs,
      note:          (req.body.note || '').trim() || null,
    });
    TireController._broadcast(raceId, res);
  }

  static deleteChange(req, res) {
    const raceId = parseInt(req.params.id, 10);
    const change = TireChange.findById(parseInt(req.params.changeId, 10));
    if (!change || change.race_id !== raceId) return res.status(404).json({ ok: false });
    TireChange.remove(change.id);
    TireController._broadcast(raceId, res);
  }

  // ── Auxiliares ────────────────────────────────────────────────────────

  // Emite el evento de refresco y responde con el estado nuevo, así el propio
  // cliente y las demás pantallas (kiosco + página) quedan al día.
  static _broadcast(raceId, res) {
    SocketService.emit('tires:changed', { raceId });
    res.json({
      ok: true,
      summary: TireChange.summaryByRace(raceId),
      context: TireController._currentContext(raceId),
    });
  }

  // Lee manga y tiempo del cuerpo del formulario del historial. Acepta el
  // tiempo como "mm:ss", "h:mm:ss" o segundos sueltos. Devuelve null cuando el
  // campo viene vacío (registro sin manga/tiempo conocidos).
  static _parseWhen(body) {
    let mangaNumber = null;
    if (body.manga_number != null && String(body.manga_number).trim() !== '') {
      const n = parseInt(body.manga_number, 10);
      if (!isNaN(n) && n > 0) mangaNumber = n;
    }
    let elapsedMs = null;
    const raw = (body.elapsed || '').toString().trim();
    if (raw !== '') {
      const parts = raw.split(':').map(p => parseInt(p, 10));
      if (parts.every(p => !isNaN(p))) {
        let secs = 0;
        if (parts.length === 1)      secs = parts[0];
        else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
        else if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (secs >= 0) elapsedMs = secs * 1000;
      }
    }
    return { mangaNumber, elapsedMs };
  }

  // Si el número de manga corresponde a una manga real de la carrera, ata el
  // registro a su id (así sobrevive coherente); si no, deja null.
  static _mangaIdForNumber(raceId, mangaNumber) {
    if (mangaNumber == null) return null;
    const m = db.prepare('SELECT id FROM mangas WHERE race_id = ? AND number = ? ORDER BY id ASC LIMIT 1')
      .get(raceId, mangaNumber);
    return m ? m.id : null;
  }
}

module.exports = TireController;
