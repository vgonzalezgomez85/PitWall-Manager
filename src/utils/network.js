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
