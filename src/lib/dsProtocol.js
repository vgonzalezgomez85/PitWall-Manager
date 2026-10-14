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
// Lector ÚNICO de la familia DS: lo usan el cronometraje (SerialService), el
// visor de tramas (frameDecoder) y el importador de carreras simuladas
// (dsFrames). Antes eran tres copias y divergían: el visor decía una cosa y el
// cronometraje hacía otra. Sigue la forma de leer de TicTacSlot, que lee bien
// todas las cajas (ver TicTacSlot-cuentavueltas-protocolos.md):
//
//   1. Las tramas se buscan en el FLUJO de bytes: un 0xE0 con 0xEB 20 bytes
//      después y el checksum correcto. No dependen de los silencios del cable:
//      antes se cortaba por 75 ms sin bytes, y un corte a mitad de trama (o un
//      bloqueo del hilo principal) inventaba cruces o perdía tramas.
//   2. Una retransmisión (mismo byte[1] y mismos bytes que la última trama
//      aceptada de esa caja) se descarta, llegue junta o separada.
//   3. Cruce o evento lo decide byte[7]; el evento, byte[8].

const { isCrossingFrame, checksumOk, goDurationMs, crossingLanes } = require('./dsModels');

const DS_FRAME_LEN = 21;
const FRAME_START  = 0xe0;
const FRAME_END    = 0xeb;

// Decimal-en-hex: 0x57 → 57. null si algún nibble pasa de 9 (primer cruce).
function bcd(b) {
  return ((b >> 4) <= 9 && (b & 0x0f) <= 9) ? (b >> 4) * 10 + (b & 0x0f) : null;
}

// Tiempo de vuelta en bytes 14-17: minutos, segundos, centésimas, diezmilésimas.
// null = la caja aún no tiene referencia (primer cruce: AA AB AA AA).
function lapTimeMs(frame) {
  if (frame.length < 18) return null;
  const m = bcd(frame[14]), s = bcd(frame[15]), c = bcd(frame[16]), d = bcd(frame[17]);
  if (m === null || s === null || c === null || d === null) return null;
  return m * 60000 + s * 1000 + c * 10 + d * 0.1;
}

const EVENTOS = { 0xa1: 'go', 0xa2: 'semaphore', 0xa3: 'green', 0xa4: 'finish',
                  0xa5: 'pause', 0xa6: 'resume_signal', 0xa7: 'stop', 0xc0: 'heartbeat' };

// Qué dice una trama completa, sin estado. El estado (latch del GO, pausa…) es
// de quien la usa.
//   crossing: { lanes (locales), lapMs, counter (byte12 BCD), box (byte[4]) }
//   go:       { durationMs | null }       heartbeat: { minute (byte[14] crudo) }
//   semaphore, green, finish, pause, resume_signal, stop, event (desconocido: code)
function decodeFrame(model, frame) {
  if (isCrossingFrame(frame)) {
    return { type: 'crossing', lanes: crossingLanes(model, frame), lapMs: lapTimeMs(frame),
             counter: bcd(frame[12]), box: frame[4] };
  }
  const type = EVENTOS[frame[8]] || 'event';
  if (type === 'go')        return { type, durationMs: goDurationMs(frame) };
  if (type === 'heartbeat') return { type, minute: frame[14] };
  if (type === 'event')     return { type, code: frame[8] };
  return { type };
}

function sameBytes(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Separa el flujo de bytes en tramas. Guarda entre llamadas la cola sin cerrar
// (como mucho 20 bytes) y la hora de llegada de cada byte: la hora de una trama
// es la de su 0xE0.
//   push(bytes, ts) → { frames: [{ frame, ts }], discarded: [{ bytes, ts }] }
// `discarded` son bytes que no forman trama (ruido, colas sueltas, tramas con el
// checksum mal); se devuelven para registrarlos y enseñarlos en el visor.
function createFrameSplitter() {
  let buf = [];
  let tss = [];

  return {
    push(bytes, ts) {
      for (const b of bytes) { buf.push(b); tss.push(ts); }
      const frames = [], discarded = [];
      let junk = [], junkTs = null;
      const tirar = (i) => { if (!junk.length) junkTs = tss[i]; junk.push(buf[i]); };
      const cerrarBasura = () => {
        if (junk.length) discarded.push({ bytes: junk, ts: junkTs });
        junk = []; junkTs = null;
      };

      let p = 0;
      while (p < buf.length) {
        if (buf[p] !== FRAME_START) { tirar(p); p++; continue; }
        if (buf.length - p < DS_FRAME_LEN) break;              // trama a medias: esperar
        const frame = buf.slice(p, p + DS_FRAME_LEN);
        if (frame[DS_FRAME_LEN - 1] !== FRAME_END || !checksumOk(frame)) {
          tirar(p); p++; continue;                              // ese 0xE0 no abría trama
        }
        cerrarBasura();
        frames.push({ frame, ts: tss[p] });
        p += DS_FRAME_LEN;
      }
      cerrarBasura();
      buf = buf.slice(p);
      tss = tss.slice(p);
      return { frames, discarded };
    },

    pending() { return buf.length; },

    reset() { buf = []; tss = []; },
  };
}

module.exports = { DS_FRAME_LEN, bcd, lapTimeMs, decodeFrame, sameBytes, createFrameSplitter };
