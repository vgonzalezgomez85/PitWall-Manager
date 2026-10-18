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
// Un interface TicTac conectado como en producción: sus señales salen por
// SerialService (los mismos callbacks que arma connectMultiple), las órdenes que
// recibe se guardan en `ordenes` y `evento()` inyecta lo que contestaría el aparato.

const SerialService    = require('../../src/services/SerialService');
const TicTacConnection = require('../../src/services/TicTacConnection');
const P = require('../../src/lib/tictacProtocol');

function tictacConectado({ conUsb = true, onCrossing } = {}) {
  const i = 0;
  const conn = new TicTacConnection(
    i, 0,
    onCrossing || (d => SerialService.emit('lane_crossing', { circuit: i, ...d })),
    ()   => SerialService.emit('race_started',       { circuit: i }),
    ()   => SerialService.emit('race_stopped',       { circuit: i }),
    ()   => SerialService.emit('race_paused',        { circuit: i }),
    ()   => SerialService.emit('race_resumed',       { circuit: i }),
    ms   => SerialService.emit('race_go',            { circuit: i, durationMs: ms }),
    ()   => SerialService.emit('race_finished',      { circuit: i }),
    ()   => SerialService.emit('race_resume_signal', { circuit: i }),
    ()   => SerialService.emit('semaphore_step',     { circuit: i }),
    ()   => {},
    ()   => {},
  );
  const ordenes = [];
  if (conUsb) conn._hid = { write: b => { ordenes.push(Buffer.from(b)); return b.length; }, close() {} };

  let seq = 0;
  const evento = (codigo, datos = []) => {
    const b = Buffer.alloc(P.LEN);
    b[0] = P.SYNC; b[1] = ++seq & 0xff; b[2] = P.TIPO.EVENTO; b[3] = codigo;
    datos.forEach((v, k) => { b[4 + k] = v; });
    conn._onData(b);
  };
  // Lo que se le mandó al aparato, sin el ID de informe: 'c10500', 'c3', …
  const ordenesHex = () => ordenes.map(o => {
    const cuerpo = o.subarray(1);
    return cuerpo[0] === P.ORDEN.ARRANCAR ? cuerpo.subarray(0, 3).toString('hex') : cuerpo.subarray(0, 1).toString('hex');
  });

  return { conn, ordenes, ordenesHex, evento, E: P.EVENTO };
}

module.exports = { tictacConectado };
