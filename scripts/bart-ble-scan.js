'use strict';
// Escanea TODO el BLE del Mac ~15s y lista cada dispositivo (nombre + servicios).
// Resalta lo que parezca BART (servicio NUS o nombre BART_MST).
const noble = require('@abandonware/noble');
const NUS = '6e400001b5a3f393e0a9e50e24dcca9e';
const seen = new Map();

noble.on('stateChange', s => {
  console.log('estado:', s);
  if (s === 'poweredOn') noble.startScanning([], true);   // sin filtro, con duplicados
});
noble.on('discover', p => {
  const a = p.advertisement || {};
  const name = a.localName || '(sin nombre)';
  const uuids = (a.serviceUuids || []).map(u => u.replace(/-/g,'').toLowerCase());
  const isBart = uuids.includes(NUS) || name === 'BART_MST';
  const key = p.id;
  if (!seen.has(key)) {
    seen.set(key, true);
    console.log(`${isBart ? '★ BART →' : '  '} ${p.address || p.id}  rssi=${p.rssi}  name="${name}"  svc=[${uuids.join(',') || '-'}]`);
  }
});
setTimeout(() => {
  console.log(`\nTotal dispositivos vistos: ${seen.size}`);
  process.exit(0);
}, 15000);
