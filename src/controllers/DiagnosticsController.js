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
const db             = require('../config/database');
const TimingService  = require('../services/TimingService');
const SerialService  = require('../services/SerialService');
const SocketService  = require('../services/SocketService');
const Lap            = require('../models/Lap');
const Manga          = require('../models/Manga');

class DiagnosticsController {
  static index(req, res) {
    const lang = req.session?.lang || 'es';
    const t = req.t;

    // Timing state
    const session = TimingService.session;
    const pending = TimingService._pendingSetup;
    const timing = {
      isRunning:        TimingService.isRunning,
      activeMangaId:    TimingService.activeMangaId || null,
      activeRaceId:     session?.race?.id || null,
      activeMangaLabel: session ? `Race ${session.race.id} · Tanda ${session.tanda?.number ?? '?'} · Manga ${session.manga.number}` : null,
      tandaBoundary:    TimingService._tandaBoundary,
      pendingSetup:     pending ? {
        raceId:   pending.race.id,
        mangaId:  pending.manga.id,
        label:    `Race ${pending.race.id} · Manga ${pending.manga.number} (${pending.manga.status})`,
      } : null,
    };

    // Serial state
    const link = SerialService.getLinkStatus();

    // Mangas marked active in DB but not running in TimingService → stuck
    const stuck = db.prepare(`
      SELECT m.id, m.race_id, m.tanda_id, m.number, m.status, m.started_at,
             t.number AS tanda_number,
             (SELECT COUNT(*) FROM laps WHERE manga_id = m.id) AS lap_count
      FROM mangas m
      JOIN tandas t ON t.id = m.tanda_id
      WHERE m.status = 'active'
      ORDER BY m.started_at DESC
    `).all().filter(m => m.id !== timing.activeMangaId);

    const connections = SocketService.getConnectionCounts();

    res.render('diagnostico/index', { lang, t, timing, link, stuck, connections, flash: req.session?.flash });
    if (req.session) req.session.flash = null;
  }

  // Visor de tramas en vivo. La página no precarga tramas: el historial llega
  // por socket al emitir `diag:frames:join`, así el gate de FrameMonitor es la
  // única puerta de entrada y no hay dos caminos que mantener.
  static frames(req, res) {
    const lang = req.session?.lang || 'es';
    res.render('diagnostico/tramas', {
      lang,
      t: req.t,
      link: SerialService.getLinkStatus(),
    });
  }

  static clearBoundary(req, res) {
    TimingService.clearTandaBoundary();
    if (req.session) req.session.flash = { type: 'success', text: 'Boundary de tanda limpiado.' };
    res.redirect('/diagnostico');
  }

  static cancelActive(req, res) {
    if (TimingService.isRunning) {
      const mid = TimingService.activeMangaId;
      TimingService.cancelManga();
      if (req.session) req.session.flash = { type: 'success', text: `Manga ${mid} cancelada y vueltas eliminadas.` };
    } else {
      if (req.session) req.session.flash = { type: 'error', text: 'No hay ninguna manga activa.' };
    }
    res.redirect('/diagnostico');
  }

  static clearPending(req, res) {
    // Solo libera el "listener" del próximo GO (TimingService._pendingSetup a
    // null). NO toca el status de ninguna carrera: antes esto completaba de
    // paso cualquier carrera 'active' con una manga 'pending' para que dejara
    // de "robar" el auto-buscador de app.js, pero eso mentía sobre carreras
    // que en realidad seguían vivas (p.ej. la 93 quedó 'completed' con 52
    // mangas por correr). El próximo GO vuelve a auto-buscar desde cero.
    TimingService.clearPendingManga();
    if (req.session) req.session.flash = { type: 'success', text: 'Pending setup eliminado.' };
    res.redirect('/diagnostico');
  }

  static resetManga(req, res) {
    const mangaId = parseInt(req.params.mangaId, 10);
    const manga = Manga.findById(mangaId);
    if (!manga) {
      if (req.session) req.session.flash = { type: 'error', text: `Manga ${mangaId} no encontrada.` };
      return res.redirect('/diagnostico');
    }
    // Mismo camino tenga o no sesión viva: si la manga se quedó colgada tras un
    // reinicio, sus turnos también se descartan y sus pilotos quedan pre-armados.
    // `force` porque desde diagnóstico también se resetean mangas ya terminadas.
    TimingService.cancelMangaById(mangaId, null, { force: true });
    if (req.session) req.session.flash = { type: 'success', text: `Manga ${mangaId} reseteada a pending.` };
    res.redirect('/diagnostico');
  }

  static reconnectSerial(req, res) {
    try {
      Promise.resolve(SerialService.closeAll?.()).finally(() => {
        setTimeout(() => SerialService.init(), 200);
      });
      if (req.session) req.session.flash = { type: 'success', text: 'Reconexión del serial iniciada.' };
    } catch (err) {
      if (req.session) req.session.flash = { type: 'error', text: `Error al reconectar: ${err.message}` };
    }
    res.redirect('/diagnostico');
  }
}

module.exports = DiagnosticsController;
