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
