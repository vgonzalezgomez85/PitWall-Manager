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
// Cliente HTTP/HTTPS mínimo (sin dependencias) para el enlace maestro↔esclavo.
// Se factoriza aquí para que LinkController (provisión, Fase 1) y RaceLinkService
// (empuje de estado, Fase 3) compartan el MISMO transporte y no dupliquen código.
const http  = require('http');
const https = require('https');
const { URL } = require('url');

// Descarga JSON por GET. Resuelve el objeto parseado o rechaza con Error.
function getJson(rawUrl, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch { return reject(new Error('URL inválida')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`El maestro respondió ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Respuesta del maestro no es JSON válido')); }
      });
    });
    req.on('error', e => reject(new Error(`No se pudo conectar con el maestro: ${e.message}`)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout conectando con el maestro')); });
  });
}

// Envía JSON por POST con cabeceras opcionales. Resuelve { status, body }
// (body = objeto parseado o texto crudo si no es JSON). Rechaza en error de red
// o timeout. NO trata los códigos !2xx como error: los devuelve al llamante.
function postJson(rawUrl, payload, { timeoutMs = 4000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch { return reject(new Error('URL inválida')); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8');
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      }, headers),
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* deja texto crudo */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', e => reject(new Error(e.message)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { getJson, postJson };
