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
// Recuperación de una manga que se quedó a medias porque el proceso murió.
//
// LA GUARDA. Que una manga figure 'active' en la BD NO significa que siga
// corriendo: puede llevar días muerta (nos pasó: reinicié el servidor y la manga
// quedó 'active' toda la tarde). Recuperarla a ciegas al arrancar significaría
// resucitar una manga muerta y empezar a escribirle vueltas.
//
// Por eso la recuperación es automática pero NO ciega: espera a que la CAJA lo
// confirme. El DS-300 emite un latido cada 60 s **solo mientras la carrera
// corre**, y los cruces solo llegan si hay coches rodando. Cualquiera de las dos
// señales es prueba de que la manga sigue viva. Si no llega ninguna en
// VENTANA_MS, no se toca nada: la manga se queda como está y el operador la para
// cuando quiera (el STOP ya sabe hacerlo).
//
// El reloj de pared sobrevive al reinicio, y `startTime` de cada circuito es un
// ancla de reloj de pared ya desplazada por sus pausas. Así que el transcurrido
// se recalcula solo, con la caída incluida — que es justo lo que queremos: los
// coches han seguido rodando y el DS ha seguido contando.

const Manga         = require('../models/Manga');
const Race          = require('../models/Race');
const Team          = require('../models/Team');
const Driver        = require('../models/Driver');
const MangaCircuit  = require('../models/MangaCircuit');
const SerialService = require('./SerialService');
const TimingService = require('./TimingService');
const SocketService = require('./SocketService');
const DebugLogger   = require('./DebugLogger');

// Cuánto esperamos a que la caja confirme que la carrera sigue viva. El latido
// llega cada 60 s; los cruces, mucho antes si hay coches en pista.
const VENTANA_MS = 90000;

class SessionRecoveryClass {
  constructor() {
    this._pendiente = null;   // { manga, race, lanes, teams, drivers, circuits }
    this._timeout   = null;
    this._handlers  = null;
    this.ultimoResultado = null;   // para diagnóstico
  }

  /**
   * Busca una manga huérfana y, si la hay, se queda esperando la señal de la caja.
   * Llamar una sola vez al arrancar, cuando el puerto serie ya está enganchado.
   */
  arm() {
    const db = require('../config/database');
    const row = db.prepare(`
      SELECT m.id AS manga_id, m.race_id
      FROM mangas m
      WHERE m.status = 'active'
      ORDER BY m.id DESC LIMIT 1
    `).get();
    if (!row) return null;

    const circuits = MangaCircuit.findByManga(row.manga_id);
    if (!circuits.length) {
      // Manga anterior a esta funcionalidad, o que nunca llegó a arrancar de
      // verdad. No hay ancla que restaurar: no se puede recuperar.
      console.warn(`[SessionRecovery] Manga ${row.manga_id} quedó 'active' pero sin estado de circuitos. No se puede recuperar; párala desde la pantalla.`);
      this.ultimoResultado = { estado: 'sin-estado', mangaId: row.manga_id };
      return null;
    }

    const vivos = circuits.filter(c => c.status === 'running' || c.status === 'paused');
    if (!vivos.length) {
      console.warn(`[SessionRecovery] Manga ${row.manga_id}: todos sus circuitos estaban terminados. Nada que recuperar.`);
      this.ultimoResultado = { estado: 'circuitos-terminados', mangaId: row.manga_id };
      return null;
    }

    const manga = Manga.findById(row.manga_id);
    const race  = Race.findById(row.race_id);
    if (!manga || !race) return null;

    const outageMs = MangaCircuit.outageMs(row.manga_id) || 0;
    this._pendiente = {
      manga, race,
      lanes:   Manga.getLanes(manga.id),
      teams:   Team.findByTanda(manga.tanda_id),
      drivers: Driver.findByTanda(manga.tanda_id),
      circuits,
      outageMs,
    };

    console.warn(
      `[SessionRecovery] Manga ${manga.id} (carrera "${race.name}") quedó a medias. ` +
      `Caída de ${(outageMs / 1000).toFixed(0)} s. Esperando ${VENTANA_MS / 1000} s a que la caja confirme que sigue corriendo…`,
    );
    this.ultimoResultado = { estado: 'esperando', mangaId: manga.id, outageMs };
    SocketService.emit('recovery:waiting', { mangaId: manga.id, raceId: race.id, outageMs });

    this._escuchar();
    return this._pendiente;
  }

  /** Se engancha a las dos señales que prueban que la caja sigue corriendo. */
  _escuchar() {
    const confirmar = (fuente) => () => this._confirmado(fuente);
    this._handlers = {
      heartbeat:     confirmar('latido'),
      lane_crossing: confirmar('cruce'),
    };
    SerialService.on('heartbeat',     this._handlers.heartbeat);
    SerialService.on('lane_crossing', this._handlers.lane_crossing);

    this._timeout = setTimeout(() => this._sinSenal(), VENTANA_MS);
  }

  _desescuchar() {
    if (this._handlers) {
      SerialService.off('heartbeat',     this._handlers.heartbeat);
      SerialService.off('lane_crossing', this._handlers.lane_crossing);
      this._handlers = null;
    }
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
  }

  _confirmado(fuente) {
    if (!this._pendiente) return;
    const p = this._pendiente;
    this._pendiente = null;
    this._desescuchar();

    console.warn(`[SessionRecovery] La caja confirma que la manga ${p.manga.id} sigue corriendo (${fuente}). Recuperando…`);
    try {
      const resumen = TimingService.rehydrateManga(p);
      this.ultimoResultado = { estado: 'recuperada', mangaId: p.manga.id, fuente, outageMs: p.outageMs, ...resumen };
      DebugLogger.log('manga', { event: 'recovered', mangaId: p.manga.id, fuente, outageMs: p.outageMs, ...resumen });
      SocketService.emit('recovery:done', this.ultimoResultado);
    } catch (err) {
      console.error('[SessionRecovery] Falló la recuperación:', err.message);
      this.ultimoResultado = { estado: 'error', mangaId: p.manga.id, error: err.message };
      SocketService.emit('recovery:failed', this.ultimoResultado);
    }
  }

  _sinSenal() {
    if (!this._pendiente) return;
    const p = this._pendiente;
    this._pendiente = null;
    this._desescuchar();

    console.warn(
      `[SessionRecovery] Ninguna señal de la caja en ${VENTANA_MS / 1000} s. ` +
      `La manga ${p.manga.id} NO se recupera: probablemente ya no se está corriendo. Párala desde la pantalla cuando quieras.`,
    );
    this.ultimoResultado = { estado: 'sin-senal', mangaId: p.manga.id, outageMs: p.outageMs };
    SocketService.emit('recovery:aborted', this.ultimoResultado);
  }

  /** Para los tests y el apagado ordenado. */
  cancel() {
    this._pendiente = null;
    this._desescuchar();
  }

  get esperando() { return this._pendiente != null; }
}

module.exports = new SessionRecoveryClass();
module.exports.VENTANA_MS = VENTANA_MS;
