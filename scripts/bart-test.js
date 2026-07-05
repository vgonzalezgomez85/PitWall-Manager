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
'use strict';

// Prueba aislada de BartConnection contra el emulador BART.
//   1) levanta el emulador:  cd /Users/victor/BART-emulator && node emulator.js
//   2) ejecuta esto:         node scripts/bart-test.js
//
// Construye una BartConnection (lo mismo que crea SerialService) y muestra los
// cruces tal como llegarían al evento 'lane_crossing' aguas abajo.

const BartConnection = require('../src/services/bart/BartConnection');

const HOST = process.env.BART_HOST || '127.0.0.1';
const PORT = Number(process.env.BART_PORT || 9300);

let n = 0;
const onCrossing = (data) => {
  n++;
  const tag = data.missed ? ' [FANTASMA/relleno]' : '';
  const ms  = data.lapTimeMs == null ? 'null(1er cruce/desborde)' : `${data.lapTimeMs}ms`;
  console.log(`lane_crossing  carril ${data.lane}  ${ms}${tag}`);
};

const conn = new BartConnection(
  0,            // circuitIndex
  0,            // laneOffset
  onCrossing,
  () => console.log('race_started'),
  () => console.log('race_stopped'),
  () => console.log('race_paused'),
  () => console.log('race_resumed'),
  () => console.log('race_go'),
  () => console.log('race_finished'),
);

conn.connect(HOST, PORT, { minlap: 1500, start: true })
  .then(() => console.log(`Conectado a ${conn.path}. Esperando cruces…\n`))
  .catch(err => { console.error('No se pudo conectar:', err.message); process.exit(1); });

const secs = Number(process.env.SECS || 12);
setTimeout(async () => {
  await conn.close();
  console.log(`\n✔ ${n} cruces recibidos en ${secs}s. Cerrado.`);
  process.exit(0);
}, secs * 1000);
