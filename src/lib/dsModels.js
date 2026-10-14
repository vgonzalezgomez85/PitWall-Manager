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

// Cruce o evento lo decide byte[7] (0x1B = cruce), como TicTacSlot y en todos
// los modelos. Antes valía byte[10] != 0, y una trama de evento con datos en
// byte[10] (el GO de clase 0x3A/0x3B lleva ahí la duración) se leía como cruce:
// la manga no arrancaba y salían vueltas de carriles inventados. En las capturas
// reales (DS-300 de Italia, 160.000 tramas, y el DS antiguo a 4800) todos los
// cruces llevan 0x1B.
const CROSSING_CLASS = 0x1b;

function isCrossingFrame(frame) {
  return frame.length > 7 && frame[7] === CROSSING_CLASS;
}

function isControlFrame(_model, frame) {
  return !isCrossingFrame(frame);
}

// byte[18] = (byte[1] + … + byte[17] + byte[19]) & 0xFF. Solo se comprueba con
// la trama entera: un trozo no se puede validar y lo trata quien lo recibe.
function checksumOk(frame) {
  if (frame.length !== 21) return true;
  let sum = frame[19];
  for (let i = 1; i <= 17; i++) sum += frame[i];
  return (sum & 0xff) === frame[18];
}

// Duración de la manga que trae el GO (byte[8] = 0xA1), en ms, o null si la clase
// no la lleva (p. ej. 0x3B, GO por vueltas). Formatos de TicTacSlot, por nibbles:
//   0x3A → [9][10] = H MM S  (horas, minutos, decenas de segundo)
//   0x3E → [9] = _H, [10] = MM, [11] = S_
// Con 0x3E y menos de 60 min coincide con leer byte[10] como minutos BCD.
// Comprobado con el DS antiguo: `3A A1 01 00` = 600 s y las mangas duraron 600 s.
function goDurationMs(frame) {
  const hi = x => x >> 4, lo = x => x & 0x0f;
  const [b9, b10, b11] = [frame[9] || 0, frame[10] || 0, frame[11] || 0];
  let s;
  if (frame[7] === 0x3a)      s = hi(b9) * 3600 + lo(b9) * 600 + hi(b10) * 60 + lo(b10) * 10;
  else if (frame[7] === 0x3e) s = lo(b9) * 3600 + hi(b10) * 600 + lo(b10) * 60 + hi(b11) * 10;
  else return null;
  return s > 0 ? s * 1000 : null;
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
  // TicTacSlot trata 0xAC como carril 1; por bits saldrían los carriles 1, 3, 5 y 6.
  if (laneByte === 0xac) return [1];
  const lanes = [];
  for (const [mask, lane] of LANE_BITS) if (laneByte & mask) lanes.push(lane);
  return lanes;
}

module.exports = {
  MODELS, DEFAULT_MODEL, LANE_BITS, CROSSING_CLASS, normalizeModel, modelInfo,
  isCrossingFrame, isControlFrame, checksumOk, goDurationMs, crossingLanes,
};
