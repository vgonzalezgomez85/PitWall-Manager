'use strict';
// Imita EXACTAMENTE lo que hace BartConnection._openBle():
// escanear por nombre/NUS, conectar, descubrir NUS RX/TX, suscribir TX,
// habilitar notificaciones (A5 90 30 01) y volcar lo que llegue.
const noble = require('@stoprocent/noble');

const WANT = process.argv[2] || 'BART_TRACK3';
const NUS_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX = '6e400002b5a3f393e0a9e50e24dcca9e';
const NUS_TX = '6e400003b5a3f393e0a9e50e24dcca9e';
const _u = s => String(s || '').replace(/-/g, '').toLowerCase();

console.log(`Buscando "${WANT}"…`);

const onDiscover = async (p) => {
  const adv = p.advertisement || {};
  const matchSvc = (adv.serviceUuids || []).map(_u).includes(NUS_SERVICE);
  const matchName = adv.localName && adv.localName === WANT;
  if (!matchSvc && !matchName) return;
  noble.removeListener('discover', onDiscover);
  try { await noble.stopScanningAsync(); } catch {}
  console.log(`Encontrado ${p.address || p.id} (name="${adv.localName}", matchName=${matchName}, matchSvc=${matchSvc}). Conectando…`);
  try {
    await p.connectAsync();
    console.log('Conectado. Descubriendo NUS…');
    const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync([NUS_SERVICE], [NUS_RX, NUS_TX]);
    const rx = characteristics.find(c => _u(c.uuid) === NUS_RX);
    const tx = characteristics.find(c => _u(c.uuid) === NUS_TX);
    if (!rx || !tx) throw new Error('características NUS RX/TX no encontradas: ' + characteristics.map(c => _u(c.uuid)).join(','));
    console.log('NUS RX/TX OK. Suscribiendo TX…');
    let nframes = 0;
    tx.on('data', d => { nframes++; console.log('  TX <-', d.toString('hex')); });
    await tx.subscribeAsync();
    console.log('Suscrito. Enviando NOTIFY ON (a5 90 30 01)…');
    rx.write(Buffer.from([0xa5, 0x90, 0x30, 0x01]), true, () => {});
    console.log('--- Esperando tramas 20s (haz pasar un coche) ---');
    setTimeout(() => { console.log(`\nTramas recibidas: ${nframes}`); process.exit(0); }, 20000);
  } catch (e) {
    console.error('FALLO:', e.message);
    process.exit(1);
  }
};

noble.on('discover', onDiscover);
noble.on('stateChange', s => {
  console.log('estado BLE:', s);
  if (s === 'poweredOn') noble.startScanning([], false);
  else { console.error('BLE no disponible:', s); process.exit(1); }
});
setTimeout(() => { console.error('TIMEOUT: no encontrado en 15s'); process.exit(1); }, 15000);
