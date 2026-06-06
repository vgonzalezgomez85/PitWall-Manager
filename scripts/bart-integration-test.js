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
