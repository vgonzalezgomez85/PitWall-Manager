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
const Race           = require('../models/Race');
const Manga          = require('../models/Manga');
const TimingService  = require('../services/TimingService');
const SerialService  = require('../services/SerialService');
const SocketService  = require('../services/SocketService');
const GoOwnerService = require('../services/GoOwnerService');
const Warmup         = require('../services/WarmupService');
const SprintExtras   = require('../services/SprintExtras');

const DEFAULT_MIN = 3;       // minutos de warm-up por defecto
const SEMAPHORE_MS = 3000;   // mismo semáforo que la manga y la pole

// Warm-up: calentamiento antes de la manga, sin que empiece la carrera.
// Ver services/WarmupService.js. Todas las rutas son JSON salvo la página.
// Solo en sprint con el ajuste `sprint_warmup` encendido (SprintExtras): sin él
// no se abre ni se arma; lo que ya esté en pista se puede seguir parando.
class WarmupController {

  // Carga y valida carrera + manga. Devuelve { race, manga } o responde con el error.
  static _load(req, res, { needPending = true } = {}) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga || manga.race_id !== race.id) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return null;
    }
    if (needPending && manga.status !== 'pending') {
      res.status(409).json({ ok: false, error: 'manga_not_pending' });
      return null;
    }
    return { race, manga };
  }

  static _info(race, manga) {
    return {
      ok: true,
      enabled:    SprintExtras.warmupEnabled(race),
      softwareGo: !!SerialService.softwareGo,
      remoteGo:   !!SerialService.remoteGo,
      defaultMinutes: race.warmup_minutes > 0 ? race.warmup_minutes : DEFAULT_MIN,
      ...Warmup.snapshot(manga.id),
    };
  }

  // GET …/warmup  — ventana pequeña del warm-up (se abre desde el directo).
  static page(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga || manga.race_id !== race.id) {
      return res.status(404).render('error', { t: req.t, code: 404, message: req.t('errors.not_found') });
    }
    if (!SprintExtras.warmupEnabled(race)) return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
    res.render('races/warmup', { t: req.t, lang: req.session?.lang || 'es', race, manga });
  }

  // GET …/warmup/state
  static state(req, res) {
    const ctx = WarmupController._load(req, res, { needPending: false });
    if (!ctx) return;
    res.json(WarmupController._info(ctx.race, ctx.manga));
  }

  // POST …/warmup/arm  { minutes }
  static arm(req, res) {
    const ctx = WarmupController._load(req, res);
    if (!ctx) return;
    const { race, manga } = ctx;
    if (!SprintExtras.warmupEnabled(race)) return res.status(403).json({ ok: false, error: 'disabled' });

    // Una sola sesión en pista (manga, pole, entreno de competición).
    const busy = GoOwnerService.blockerFor('warmup');
    if (busy || TimingService.isMangaLive) {
      return res.status(409).json({ ok: false, error: `${busy || 'race'}_running` });
    }

    // Con DS-300 la duración la marca la caja en el GO; este valor solo es el de reserva.
    let minutes = parseInt(req.body.minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
      minutes = race.warmup_minutes > 0 ? race.warmup_minutes : DEFAULT_MIN;
    }
    Race.setWarmupMinutes(race.id, minutes);

    // Nombres de los carriles de esta manga, para enseñar quién rueda.
    const laneNames = {};
    try {
      Manga.getLanes(manga.id).forEach(ml => {
        if (ml.is_rest) return;
        laneNames[ml.lane] = ml.team_name || ml.driver_name || req.t('client.warmup.lane_n', { n: ml.lane });
      });
    } catch {}

    Warmup.arm({
      raceId: race.id, mangaId: manga.id, durationMs: minutes * 60000,
      laneNames, minLapMs: race.min_lap_ms || 0,
    });
    // Con una caja que arranca sola el GO que devuelva es de este warm-up.
    res.json(WarmupController._info(race, manga));
  }

  // Comprueba que el warm-up pedido es el que está preparado.
  static _mine(res, manga) {
    if (Warmup.mangaId !== manga.id) {
      res.status(409).json({ ok: false, error: 'not_armed' });
      return false;
    }
    return true;
  }

  // POST …/warmup/go   (solo BART / TicTac / simulación: PitWall da el GO)
  static go(req, res) {
    if (!SerialService.softwareGo) return res.status(409).json({ ok: false, error: 'not_software_go' });
    const ctx = WarmupController._load(req, res);
    if (!ctx || !WarmupController._mine(res, ctx.manga)) return;
    if (!Warmup.isStandby) return res.status(409).json({ ok: false, error: 'not_standby' });
    const busy = GoOwnerService.blockerFor('warmup');
    if (busy) return res.status(409).json({ ok: false, error: `${busy}_running` });

    // TicTac: la orden va a la caja; su semáforo y su verde arrancan el warm-up por el camino del DS.
    if (SerialService.remoteGo) {
      GoOwnerService.armRemoteGo('warmup', ctx.race.id);
      SerialService.sendGo(Warmup.session.durationMs);
      return res.json({ ok: true, semaphore: true });
    }

    const mangaId = ctx.manga.id;
    SocketService.emit('race:semaphore');
    setTimeout(() => {
      // Si en estos 3 s se canceló, cambió de manga o arrancó otra sesión, el GO ya no vale.
      if (GoOwnerService.blockerFor('warmup')) return;
      if (Warmup.isStandby && Warmup.mangaId === mangaId) Warmup.go();
    }, SEMAPHORE_MS);
    res.json({ ok: true, semaphore: true });
  }

  // POST …/warmup/pause
  static async pause(req, res) {
    if (!SerialService.softwareGo) return res.status(409).json({ ok: false, error: 'not_software_go' });
    const ctx = WarmupController._load(req, res);
    if (!ctx || !WarmupController._mine(res, ctx.manga)) return;
    if (SerialService.remoteGo) {
      if (!Warmup.isRunning) return res.json({ ok: false });
      SerialService.sendPause();
      await require('./SessionController')._waitFor(() => Warmup.isPaused);
      return res.json({ ok: Warmup.isPaused });
    }
    res.json({ ok: Warmup.pause() });
  }

  // POST …/warmup/resume
  static resume(req, res) {
    if (!SerialService.softwareGo) return res.status(409).json({ ok: false, error: 'not_software_go' });
    const ctx = WarmupController._load(req, res);
    if (!ctx || !WarmupController._mine(res, ctx.manga)) return;
    if (!Warmup.isPaused) return res.json({ ok: false });
    if (SerialService.remoteGo) { SerialService.sendResume(); return res.json({ ok: true, semaphore: true }); }
    SocketService.emit('race:semaphore');
    setTimeout(() => Warmup.resume(), SEMAPHORE_MS);
    res.json({ ok: true, semaphore: true });
  }

  // POST …/warmup/close  — «Terminar warm-up»: lo cierra y no deja rastro de sus giros.
  static close(req, res) {
    const ctx = WarmupController._load(req, res, { needPending: false });
    if (!ctx) return;
    Warmup.discard();
    res.json(WarmupController._info(ctx.race, ctx.manga));
  }
}

module.exports = WarmupController;
