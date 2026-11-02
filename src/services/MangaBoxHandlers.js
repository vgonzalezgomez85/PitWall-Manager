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
// Lo que hace la manga con las señales de la caja. Vivía en app.js; ahora se lo
// entrega GoOwnerService (lib/goOwner.routeBoxEvent) solo cuando es suyo: con la
// manga en marcha, o el GO cuando la carrera es la dueña. Las comprobaciones de
// «¿este GO es mío?» ya no van aquí.
const SerialService = require('./SerialService');

let _pendingGoDurationMs = null;

function race_go({ durationMs } = {}) {
  _pendingGoDurationMs = durationMs || null;
}

function race_started({ circuit } = {}) {
  const TimingService = require('./TimingService');
  const ci = circuit || 0;

  // Si ya hay una manga en curso, este GO pertenece a OTRO circuito: arranca
  // solo ese circuito (con su propio reloj) sin reiniciar ni tocar los demás.
  // EXCEPCIÓN agrupador: una sola señal de GO cubre TODAS las cajas del puerto
  // (las tramas de GO de cada caja llegan casi a la vez por el mismo cable), así
  // que arrancamos todos los circuitos pendientes de golpe (idempotente).
  if (TimingService.activeMangaId != null) {
    if (SerialService.isAggregator) TimingService.startAllCircuits(_pendingGoDurationMs);
    else                            TimingService.startCircuit(ci, _pendingGoDurationMs);
    _pendingGoDurationMs = null;
    return;
  }

  if (TimingService._tandaBoundary) {
    console.log('[DS-300] STARTED ignored — tanda boundary, waiting for user to start next tanda');
    return;
  }
  const go = require('./GoOwnerService').decide();

  let setup = TimingService._pendingSetup;
  if (setup && go.raceId != null && setup.race.id !== go.raceId) setup = null;

  // Auto-find first pending manga if none registered (e.g. after server restart)
  if (!setup) {
    const Race   = require('../models/Race');
    const Manga  = require('../models/Manga');
    const Team   = require('../models/Team');
    const Driver = require('../models/Driver');
    const db     = require('../config/database');

    const races = Race.findAll().filter(r => go.raceId == null ? r.status === 'active'
                                                            : r.id === go.raceId && ['pending', 'active'].includes(r.status));
    for (const race of races) {
      const manga = Manga.findFirstPending(race.id);
      if (!manga) continue;

      // Tanda-boundary guard (survives server restarts): if the most recently
      // finished manga of this race is in a different tanda than the pending
      // one, block the auto-GO. User must hit "▶ Tanda N" first.
      const lastFinished = db.prepare(
        `SELECT tanda_id FROM mangas
         WHERE race_id = ? AND status = 'finished' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 1`
      ).get(race.id);
      if (lastFinished && lastFinished.tanda_id !== manga.tanda_id) {
        console.log(`[DS-300] GO ignored — tanda boundary (last finished was tanda ${lastFinished.tanda_id}, pending in tanda ${manga.tanda_id})`);
        return;
      }

      const lanes   = Manga.getLanes(manga.id);
      const teams   = Team.findByTanda(manga.tanda_id);
      const drivers = Driver.findByTanda(manga.tanda_id);
      setup = { manga, race, lanes, teams, drivers };
      console.log(`[DS-300] Auto-found pending manga ${manga.id} for race ${race.id}`);
      break;
    }
  }

  if (!setup) { console.log('[DS-300] GO received but no pending manga found'); return; }
  TimingService.startManga(setup.manga, setup.race, setup.lanes, setup.teams, setup.drivers, _pendingGoDurationMs, ci);
  // Agrupador: un único GO cubre todas las cajas → arranca TODOS los circuitos
  // de la manga, no solo el primero (si no, los carriles de las demás cajas
  // llegan a un circuito 'pending' y se descartan por circuit_not_running).
  if (SerialService.isAggregator) TimingService.startAllCircuits(_pendingGoDurationMs);
  _pendingGoDurationMs = null;
  TimingService.clearPendingManga();
}

// STOP forzado = abortar TODA la manga (aunque haya circuitos en pausa).
function race_stopped() {
  const TimingService = require('./TimingService');
  if (TimingService.activeMangaId != null) TimingService.cancelManga();
}

// Fin (normal / tiempo agotado) de UN circuito: lo cierra. La manga se
// finaliza de verdad cuando todos los circuitos han terminado (finishCircuit).
// Agrupador: la única trama de fin cubre todas las cajas del puerto → cierra
// todos los circuitos (si no, el circuito de otra caja quedaría corriendo y la
// manga no se cerraría nunca).
function race_finished({ circuit } = {}) {
  const TimingService = require('./TimingService');
  if (TimingService.activeMangaId == null) return;
  if (SerialService.isAggregator) TimingService.finishAllCircuits();
  else                            TimingService.finishCircuit(circuit || 0);
}

// Pausa POR CIRCUITO: solo afecta a los carriles de ese DS.
// Agrupador: la pausa del puerto para todas las cajas a la vez.
function race_paused({ circuit } = {}) {
  const TimingService = require('./TimingService');
  if (TimingService.activeMangaId == null) return;
  if (SerialService.isAggregator) TimingService.pauseManga();
  else                            TimingService.pauseCircuit(circuit || 0);
}

// Agrupador: la reanudación del puerto revive todas las cajas a la vez.
function race_resumed({ circuit } = {}) {
  const TimingService = require('./TimingService');
  if (TimingService.activeMangaId == null) return;
  if (SerialService.isAggregator) TimingService.resumeManga();
  else                            TimingService.resumeCircuit(circuit || 0);
}

module.exports = { race_go, race_started, race_stopped, race_finished, race_paused, race_resumed };
