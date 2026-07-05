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

// Utilidades de red para el servidor: listar interfaces, resolver la IP de una
// interfaz elegida y calcular las IP por las que el server es accesible.
const os = require('os');

// Lista de interfaces IPv4 no internas (no loopback), con nombre + IP.
//   [{ name: 'en0', ip: '192.168.1.50' }, ...]
function listInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// IPv4 de una interfaz por nombre, o null si no existe / no tiene IPv4.
function ipOfInterface(name) {
  if (!name) return null;
  const found = listInterfaces().find(i => i.name === name);
  return found ? found.ip : null;
}

// IP(s) por las que el server es accesible según el bind elegido:
//   - bindIface vacío  → todas las interfaces (lista completa)
//   - bindIface fijado → solo esa IP (si existe; si no, todas, como hace el bind)
function serverIPs(bindIface) {
  const all = listInterfaces();
  if (!bindIface) return all;
  const ip = ipOfInterface(bindIface);
  return ip ? all.filter(i => i.ip === ip) : all;
}

module.exports = { listInterfaces, ipOfInterface, serverIPs };
