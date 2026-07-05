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
// Escaneo BLE ~15s con @stoprocent/noble (el módulo realmente instalado).
// Lista cada dispositivo (nombre + servicios) y resalta lo que parezca BART.
const noble = require('@stoprocent/noble');
const NUS = '6e400001b5a3f393e0a9e50e24dcca9e';
const seen = new Map();

noble.on('stateChange', s => {
  console.log('estado BLE:', s);
  if (s === 'poweredOn') noble.startScanning([], true);
});
noble.on('discover', p => {
  const a = p.advertisement || {};
  const name = a.localName || '(sin nombre)';
  const uuids = (a.serviceUuids || []).map(u => String(u).replace(/-/g, '').toLowerCase());
  const isBart = uuids.includes(NUS) || /^BART_/i.test(name);
  const key = p.id;
  if (!seen.has(key)) {
    seen.set(key, true);
    console.log(`${isBart ? '★ BART →' : '       '} ${p.address || p.id}  rssi=${p.rssi}  name="${name}"  svc=[${uuids.join(',') || '-'}]`);
  }
});
setTimeout(() => {
  console.log(`\nTotal dispositivos vistos: ${seen.size}`);
  process.exit(0);
}, 15000);
