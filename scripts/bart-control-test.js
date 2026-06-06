'use strict';

// Prueba de la INVERSIÓN DE CONTROL contra el emulador:
//   - sin START → el Master no emite (no llegan cruces)
//   - SerialService.sendStart() → empiezan a llegar
//   - SerialService.sendStop()  → paran
//
// Arranca su propio emulador en un puerto libre para no chocar con el tuyo.

const { spawn } = require('child_process');
const path = require('path');
const SerialService = require('../src/services/SerialService');

const PORT = 9399;
const EMU  = path.join('/Users/victor/BART-emulator/emulator.js');

let crossings = 0;
SerialService.on('lane_crossing', () => { crossings++; });

const emu = spawn('node', [EMU], { env: { ...process.env, BART_PORT: String(PORT), BART_LANES: '4' }, stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(800);
  await SerialService.connectMultiple([{ type: 'bart', host: '127.0.0.1', port: PORT, lanes: 4, minlap: 1500, start: false }]);
  console.log('Conectado (sin armar el Master).');

  await sleep(3000);
  const idle = crossings;
  console.log(`\nFase 1 — sin START: ${idle} cruces  ${idle === 0 ? '✔ (Master en reposo)' : '✗ (no debería emitir)'}`);

  console.log('→ SerialService.sendStart()');
  SerialService.sendStart();
  await sleep(8000);
  const afterStart = crossings - idle;
  console.log(`Fase 2 — tras START: ${afterStart} cruces  ${afterStart > 0 ? '✔ (corriendo)' : '✗ (no llega nada)'}`);

  console.log('→ SerialService.sendStop()');
  SerialService.sendStop();
  const atStop = crossings;
  await sleep(4000);
  const afterStop = crossings - atStop;
  console.log(`Fase 3 — tras STOP: ${afterStop} cruces nuevos  ${afterStop === 0 ? '✔ (parado)' : '✗ (sigue emitiendo)'}`);

  await SerialService.closeAll();
  emu.kill();
  console.log('\n✔ Prueba completada.');
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); emu.kill(); process.exit(1); });
