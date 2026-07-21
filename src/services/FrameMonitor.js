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
// Visor de tramas en vivo (/diagnostico/tramas). Recibe las tramas crudas de
// SerialService (DS-300) y BartConnection (BART), las decodifica a una etiqueta
// legible y las emite por socket.
//
// Tres decisiones de diseño que importan:
//
//  1. GATEADO. `SocketService.emit` es un broadcast GLOBAL: sin gate, cada trama
//     del DS llegaría a todos los móviles de los equipos y a los espectadores.
//     Por eso solo se decodifica y emite si hay al menos un espectador del visor
//     (`diag:frames:join`). Con la página cerrada esto cuesta cero.
//
//  2. AGRUPADO. Las tramas llegan a ráfagas; emitir una por una satura el socket
//     y el DOM. Se acumulan y se sueltan cada FLUSH_MS en un único array.
//
//  3. HISTORIAL. Se guardan las últimas RING_SIZE tramas ya decodificadas para
//     que al abrir la página se vea lo que acaba de pasar, sin esperar a que el
//     hardware vuelva a hablar.
//
// Este visor NO participa en el cronometraje: si algo aquí falla, el timing sigue
// (todas las llamadas desde SerialService van envueltas en try/catch).

const { createDecoder } = require('../lib/frameDecoder');

const RING_SIZE = 400;
const FLUSH_MS  = 120;

let viewers  = 0;
let seq      = 0;
let ring     = [];
let pending  = [];
let timer    = null;

// Un decodificador POR circuito: el latch de GO/resume es por caja, y mezclarlos
// haría que el verde de una caja resolviese el GO pendiente de otra.
const decoders = new Map();

function decoderFor(key) {
  if (!decoders.has(key)) decoders.set(key, createDecoder());
  return decoders.get(key);
}

function flush() {
  timer = null;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  try {
    require('./SocketService').emit('diag:frames', batch);
  } catch {}
}

module.exports = {
  isActive() { return viewers > 0; },

  addViewer() { viewers++; },
  removeViewer() { viewers = Math.max(0, viewers - 1); },

  // Historial para el primer pintado de la página.
  getRecent() { return ring.slice(); },

  clear() {
    ring = [];
    seq  = 0;
    for (const d of decoders.values()) d.reset();
  },

  // Entrada desde SerialService / BartConnection.
  //   source  'ds300' | 'bart'
  //   circuit índice 1-based del circuito
  //   bytes   Buffer o array de la trama ya ensamblada
  //   ts      ms epoch (float) de inicio de trama
  //   opts    { boxesPerPort, laneOffset } para resolver el carril global
  push(source, circuit, bytes, ts, opts = {}) {
    if (viewers === 0) return;           // gate: nadie mirando, no cuesta nada
    let decoded;
    try {
      const dec = decoderFor(`${source}:${circuit}`);
      decoded = source === 'bart' ? dec.bart(bytes, opts) : dec.ds(bytes, opts);
    } catch (err) {
      decoded = { kind: 'error', badge: '!', label: `Error al decodificar: ${err.message}`,
                  hex: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '),
                  len: bytes.length, fields: [], lanes: [], unknown: [] };
    }
    const item = { seq: ++seq, source, circuit, ts, ...decoded };
    ring.push(item);
    if (ring.length > RING_SIZE) ring.shift();
    pending.push(item);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  },
};
