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
// Trama del interface TicTacSlot («Cuentavueltas»), informe HID de 16 bytes.
// Descifrada sobre el aparato real y corregida con el desensamblado de
// TicTacSlot.exe (TicTacSlot-cuentavueltas-protocolos.md §2; réplica del códec de
// emulador-tictac/protocol.js).
//
//   [0]  0xC0 sincronismo      [1] secuencia (+1 por trama)      [2] tipo
//   Tipo 0x1B, cruce:  [4] carril · [5..6] nº de vuelta (uint16 BE)
//                      [7..8] reloj, minutos · [9..10] ms dentro del minuto ·
//                      [11] décimas de ms
//   Tipo 0x1C, evento: [3] código · [4..5] datos (0xA1: [4] minutos, [5] horas)
//
// Órdenes PC → aparato (TICTAC_Slot.exe nuevo; protocolos §2.5): 16 bytes con la
// orden delante y el resto a 0. C1 arranca con el tiempo programado, C2 para, C3
// pausa y C4 reanuda. El aparato lleva el semáforo, el reloj de la manga y el relé
// de la pista, y lo va contando con sus tramas de evento.
//
// No trae el tiempo de vuelta: sale de restar el reloj de dos cruces del MISMO
// carril. El reloj NO es un contador lineal de ms: leer [8..10] como 24 bits da un
// salto falso de 5536 ms en cada cambio de minuto.

const SYNC = 0xc0;
const LEN  = 16;

const TIPO = { CRUCE: 0x1b, EVENTO: 0x1c };

const EVENTO = {
  ARRANQUE_TIEMPO: 0xa1,
  SEMAFORO:        0xa2,
  INICIO:          0xa3,
  FINAL:           0xa4,
  PAUSA:           0xa5,
  STOP:            0xa7,
};
const NOMBRE_EVENTO = {
  [EVENTO.ARRANQUE_TIEMPO]: 'arranque_tiempo',
  [EVENTO.SEMAFORO]:        'semaforo',
  [EVENTO.INICIO]:          'inicio',
  [EVENTO.FINAL]:           'final',
  [EVENTO.PAUSA]:           'pausa',
  [EVENTO.STOP]:            'stop',
};

const ORDEN = { ARRANCAR: 0xc1, PARAR: 0xc2, PAUSA: 0xc3, REANUDAR: 0xc4 };

// Minutos de 16 bits: el reloj da la vuelta cada 65536 min (~45 días).
const CLOCK_MOD = 0x10000 * 60000;

const TIPOS_CONOCIDOS = new Set(Object.values(TIPO));

// Una trama completa y reconocible, o null. `buf` es un Buffer de LEN bytes o más.
function decodificar(buf) {
  if (!buf || buf.length < LEN || buf[0] !== SYNC) return null;
  if (buf[2] === TIPO.CRUCE) {
    return {
      tipo:    'cruce',
      seq:     buf[1],
      lane:    buf[4],
      lap:     buf.readUInt16BE(5),
      clockMs: buf.readUInt16BE(7) * 60000 + buf.readUInt16BE(9) + buf[11] / 10,
    };
  }
  if (buf[2] === TIPO.EVENTO) {
    const ev = {
      tipo:   'evento',
      seq:    buf[1],
      codigo: buf[3],
      nombre: NOMBRE_EVENTO[buf[3]] || 'desconocido',
      datos:  [buf[4], buf[5]],
    };
    if (buf[3] === EVENTO.ARRANQUE_TIEMPO) ev.durationMs = (buf[5] * 60 + buf[4]) * 60000;
    return ev;
  }
  return { tipo: 'desconocido', seq: buf[1], raw: Buffer.from(buf.subarray(0, LEN)) };
}

/**
 * Trocea un flujo de bytes en tramas. Un puerto serie no conserva los límites del
 * mensaje, así que puede haber basura delante, una trama a medias al final o un
 * 0xC0 suelto que no es sincronismo (se descarta si el byte de tipo no se conoce).
 * Devuelve { frames: Buffer[], rest: Buffer }: `rest` es lo que queda por completar.
 */
function extraerTramas(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== SYNC) { i++; continue; }
    if (buf.length - i < LEN) break;
    if (!TIPOS_CONOCIDOS.has(buf[i + 2])) { i++; continue; }
    frames.push(buf.subarray(i, i + LEN));
    i += LEN;
  }
  return { frames, rest: buf.subarray(i) };
}

// Diferencia entre dos lecturas del reloj del aparato (ms), teniendo en cuenta que
// da la vuelta. Es el cálculo del tiempo de vuelta.
function deltaReloj(desde, hasta) {
  const d = ((hasta - desde) % CLOCK_MOD + CLOCK_MOD) % CLOCK_MOD;
  return Math.round(d * 10) / 10;
}

// Orden de arranque con el tiempo de la manga. El aparato solo admite minutos
// enteros: minutos 1..60 y horas = (minutos totales − 1) div 60, como TICTAC_Slot
// (60 min = C1 3C 00, 90 min = C1 1E 01). Mínimo 1 minuto.
function ordenArrancar(durationMs) {
  const total = Math.max(1, Math.round((durationMs || 0) / 60000));
  const horas = Math.min(0xff, Math.floor((total - 1) / 60));
  return orden(ORDEN.ARRANCAR, total - horas * 60, horas);
}

function orden(codigo, ...datos) {
  const b = Buffer.alloc(LEN);
  b[0] = codigo;
  datos.forEach((v, i) => { b[1 + i] = v; });
  return b;
}

module.exports = { SYNC, LEN, TIPO, EVENTO, ORDEN, CLOCK_MOD, decodificar, extraerTramas, deltaReloj, ordenArrancar, orden };
