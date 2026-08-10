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
// Punto único de entrada para registrar un suceso de carrera (GO, pausa,
// vuelta fantasma, fichaje de piloto…): lo persiste en `race_events` y lo
// emite en vivo por socket. Independiente de DebugLogger (que es opt-in y
// solo escribe a fichero, no a BD) — este es el que sirve de fuente de
// verdad para el panel en vivo y la página de histórico.
const RaceEvent     = require('../models/RaceEvent');
const SocketService = require('./SocketService');

class RaceEventLogClass {
  // `data` lleva { raceId, mangaId, mangaNumber, circuit, lane, entityName,
  // payload }. DB y emit van en try/catch SEPARADOS: si falla la escritura,
  // el panel en vivo sigue funcionando en modo efímero (mejor perder solo
  // el histórico que perder también el aviso en vivo).
  record(type, data = {}) {
    const createdAtMs = Date.now();
    let id = null;
    try {
      id = RaceEvent.create({
        raceId:      data.raceId,
        mangaId:     data.mangaId ?? null,
        mangaNumber: data.mangaNumber ?? null,
        type,
        circuit:     data.circuit ?? null,
        lane:        data.lane ?? null,
        entityName:  data.entityName ?? null,
        payload:     data.payload ?? null,
        createdAtMs,
      });
    } catch (err) {
      console.error('[RaceEventLog] DB error:', err.message);
    }
    try {
      SocketService.emit('race:event', {
        id, type, createdAtMs,
        raceId:      data.raceId,
        mangaId:     data.mangaId ?? null,
        mangaNumber: data.mangaNumber ?? null,
        circuit:     data.circuit ?? null,
        lane:        data.lane ?? null,
        entityName:  data.entityName ?? null,
        payload:     data.payload ?? null,
      });
    } catch (err) {
      console.error('[RaceEventLog] emit error:', err.message);
    }
  }
}

module.exports = new RaceEventLogClass();
