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
// Familia DS: lo que cambia de un modelo a otro. Todos hablan la misma trama de
// 21 bytes (0xE0 … 0xEB); varían la velocidad, cómo se codifica el carril y los
// carriles que lleva cada puerto. Fuente: TicTacSlot-cuentavueltas-protocolos.md
// (desensamblado de TicTacSlot.exe). Solo el DS-300 está contrastado con un
// aparato real; el resto sigue el documento y está SIN PROBAR con hardware.

const MODELS = {
  ds300: { label: 'DS-300', baud: 56000, lanes: 8,  boxes: 1 },
  ds200: { label: 'DS-200', baud: 4800,  lanes: 2,  boxes: 1 },
  ds030: { label: 'DS-030', baud: 4800,  lanes: 8,  boxes: 1 },
  // Dos circuitos por un solo puerto: byte[4] = 2 es el circuito 2, cualquier
  // otro valor el 1. Es el mismo reparto por bloques de 8 que el agrupador.
  ds080: { label: 'DS-080', baud: 4800,  lanes: 16, boxes: 2 },
};

const DEFAULT_MODEL = 'ds300';

// bitmask → carril local (DS-300, DS-030, DS-080). Un byte puede llevar varios
// bits y entonces la trama reporta varios cruces a la vez.
const LANE_BITS = [[0x80, 1], [0x40, 2], [0x20, 3], [0x10, 4],
                   [0x08, 5], [0x04, 6], [0x02, 7], [0x01, 8]];

function normalizeModel(model) {
  return Object.prototype.hasOwnProperty.call(MODELS, model) ? model : DEFAULT_MODEL;
}

function modelInfo(model) {
  return MODELS[normalizeModel(model)];
}

// El DS-200 es el único que no distingue cruce de control por byte[10]: su
// carril 1 puede valer 0x00, igual que una trama de control. Ahí manda byte[7]
// (0x1B = cruce). En el resto, byte[10] != 0 es lo que ha funcionado siempre.
function isControlFrame(model, frame) {
  if (normalizeModel(model) === 'ds200') return frame[7] !== 0x1b;
  return !(frame.length >= 11 ? frame[10] : 0);
}

// Carriles locales que reporta una trama de cruce. Vacío = byte de carril que el
// modelo no reconoce (TicTacSlot lo registra como «pista incorrecta»).
function crossingLanes(model, frame) {
  const laneByte = frame.length >= 11 ? frame[10] : 0;
  if (normalizeModel(model) === 'ds200') {
    if (laneByte === 0x00 || laneByte === 0x01) return [1];
    if (laneByte === 0x02) return [2];
    return [];
  }
  const lanes = [];
  for (const [mask, lane] of LANE_BITS) if (laneByte & mask) lanes.push(lane);
  return lanes;
}

module.exports = { MODELS, DEFAULT_MODEL, LANE_BITS, normalizeModel, modelInfo, isControlFrame, crossingLanes };
