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

// ============================================================================
//  BleScanCoordinator — escaneo BLE compartido entre varias BartConnection.
//
//  `noble` es un único adaptador BLE por proceso. Con un solo Master BART esto
//  no importaba: cada BartConnection llamaba a startScanning/stopScanning como
//  si fuera la única. En multi-Master (varios BART_TRACKx) cada instancia hacía
//  lo mismo EN PARALELO — el segundo startScanning() reinicia el filtro del
//  primero y el stopScanning() de quien encuentra su Master antes corta el
//  escaneo a los demás, que se quedan reintentando sin encontrar nada nunca.
//
//  Aquí hay UN solo listener 'discover' y UN solo startScanning() activo, con
//  cuenta de referencias: cada BartConnection registra el nombre que busca,
//  y el escaneo sigue vivo mientras haya al menos un Master pendiente.
// ============================================================================

const waitersByName = new Map();   // nombre anunciado -> [{resolve, reject}]
const waitersNoName  = [];         // sin nombre en el advertising -> match por servicio NUS
let boundNoble  = null;
let discoverFn  = null;
let scanning    = false;

function _u(u) { return String(u || '').toLowerCase().replace(/-/g, ''); }

function _pendingCount() {
  let n = waitersNoName.length;
  for (const list of waitersByName.values()) n += list.length;
  return n;
}

function _maybeStartScanning(noble) {
  if (scanning) return;
  scanning = true;
  try { noble.startScanning([], false); } catch {}
}

function _maybeStopScanning(noble) {
  if (_pendingCount() > 0 || !scanning) return;
  scanning = false;
  try { noble.stopScanning(); } catch {}
}

function _ensureListener(noble, nusService) {
  if (boundNoble === noble) return;
  if (boundNoble && discoverFn) { try { boundNoble.removeListener('discover', discoverFn); } catch {} }
  boundNoble = noble;
  discoverFn = (peripheral) => {
    const adv     = peripheral.advertisement || {};
    const name    = adv.localName;
    const hasName = !!name;
    if (hasName && waitersByName.has(name)) {
      const list = waitersByName.get(name);
      waitersByName.delete(name);
      list.forEach((w) => w.resolve(peripheral));
    } else if (!hasName) {
      const matchSvc = (adv.serviceUuids || []).map(_u).includes(nusService);
      if (matchSvc && waitersNoName.length) waitersNoName.shift().resolve(peripheral);
    }
    _maybeStopScanning(noble);
  };
  noble.on('discover', discoverFn);
}

// Resuelve con el primer periférico que anuncie `name` (o, si no anuncia
// nombre, el servicio NUS). Rechaza a los `timeoutMs` si no aparece nadie.
function waitForPeripheral(noble, nusService, name, timeoutMs) {
  _ensureListener(noble, nusService);
  return new Promise((resolve, reject) => {
    let timer;
    const entry = {
      resolve: (p) => { clearTimeout(timer); _forget(); resolve(p); },
    };
    const list = name ? (waitersByName.get(name) || []) : waitersNoName;
    if (name && !waitersByName.has(name)) waitersByName.set(name, list);
    list.push(entry);

    const _forget = () => {
      const l = name ? waitersByName.get(name) : waitersNoName;
      if (!l) return;
      const i = l.indexOf(entry);
      if (i !== -1) l.splice(i, 1);
      if (name && l.length === 0) waitersByName.delete(name);
    };

    _maybeStartScanning(noble);
    timer = setTimeout(() => {
      _forget();
      _maybeStopScanning(noble);
      reject(new Error('BLE: periférico no encontrado (timeout)'));
    }, timeoutMs);
  });
}

module.exports = { waitForPeripheral };
