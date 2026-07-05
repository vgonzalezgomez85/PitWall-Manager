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

// Integración real: usa el SerialService singleton y conecta un circuito BART
// vía connectMultiple (la misma ruta que dispara Settings). Escucha el evento
// 'lane_crossing' que consumen TimingService y compañía. NO toca la BD.
//
//   1) emulador:  cd /Users/victor/BART-emulator && node emulator.js
//   2) esto:      node scripts/bart-integration-test.js

const SerialService = require('../src/services/SerialService');

const HOST = process.env.BART_HOST || '127.0.0.1';
const PORT = Number(process.env.BART_PORT || 9300);

let n = 0;
SerialService.on('lane_crossing', (d) => {
  n++;
  const ms = d.lapTimeMs == null ? 'null' : `${d.lapTimeMs}ms`;
  console.log(`▶ lane_crossing  circuit=${d.circuit}  lane=${d.lane}  ${ms}${d.missed ? '  [relleno]' : ''}`);
});

(async () => {
  await SerialService.connectMultiple([{ type: 'bart', host: HOST, port: PORT, lanes: 4, minlap: 1500, start: true }]);
  console.log(`Conectado. connectedPorts=${JSON.stringify(SerialService.connectedPorts)}  isDSRunning=${SerialService.isDSRunning()}`);
  console.log('Esperando cruces…\n');
})().catch(e => { console.error('Fallo al conectar:', e.message); process.exit(1); });

const secs = Number(process.env.SECS || 12);
setTimeout(async () => {
  await SerialService.closeAll();
  console.log(`\n✔ ${n} cruces vía lane_crossing en ${secs}s.`);
  process.exit(0);
}, secs * 1000);
