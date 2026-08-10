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
// Certificado local para el HTTPS de la cámara. Lo que importa: la hoja la firma
// NUESTRA CA (para poder instalarla y quitar el aviso), cubre las IPs que le
// pasamos, la CA se REUTILIZA entre reinicios (si no, cada arranque re-avisaría
// en todos los dispositivos) y un cambio de IP reemite la hoja SIN tocar la CA.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// Directorio de datos aislado ANTES de requerir el servicio (resuelve dataDir()
// leyendo PITWALL_DATA en cada llamada, así que basta con fijarlo aquí).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-tls-'));
process.env.PITWALL_DATA = dir;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const tls    = require('node:tls');
const forge  = require('node-forge');
const TlsService = require('../src/services/TlsService');

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// Comprueba una cadena PEM contra la CA usando el verificador real de node-forge.
function leafSignedByCA(leafPem, caPem) {
  const caStore = forge.pki.createCaStore([caPem]);
  try {
    return forge.pki.verifyCertificateChain(caStore, [forge.pki.certificateFromPem(leafPem)]);
  } catch { return false; }
}

function sanValues(leafPem) {
  const cert = forge.pki.certificateFromPem(leafPem);
  const ext  = cert.getExtension('subjectAltName');
  return (ext.altNames || []).map(a => a.ip || a.value);
}

test('la hoja del servidor la firma la CA de PitWall', () => {
  const { cert, ca } = TlsService.ensure(['192.168.1.50']);
  assert.ok(leafSignedByCA(cert, ca), 'la cadena debe validar contra la CA');
});

test('la hoja cubre localhost, 127.0.0.1 y las IPs dadas', () => {
  const { cert } = TlsService.ensure(['192.168.1.50', '10.0.0.9']);
  const sans = sanValues(cert);
  for (const v of ['localhost', '127.0.0.1', '192.168.1.50', '10.0.0.9']) {
    assert.ok(sans.includes(v), `falta el SAN ${v} (tiene: ${sans.join(', ')})`);
  }
});

test('la CA se reutiliza entre llamadas (mismo emisor)', () => {
  const a = TlsService.caCertPem();
  const b = TlsService.caCertPem();
  assert.equal(a, b, 'el PEM de la CA no debe cambiar');
  // Y su huella es estable.
  assert.match(TlsService.caFingerprint(), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('cambiar la IP reemite la hoja pero NO la CA', () => {
  const first  = TlsService.ensure(['192.168.1.50']);
  const second = TlsService.ensure(['192.168.1.77']);   // IP distinta
  assert.notEqual(first.cert, second.cert, 'la hoja debe reemitirse');
  assert.equal(first.ca, second.ca, 'la CA debe ser la misma → los dispositivos no re-avisan');
  assert.ok(sanValues(second.cert).includes('192.168.1.77'));
  assert.ok(!sanValues(second.cert).includes('192.168.1.50'), 'la hoja vieja ya no vale');
});

test('la misma IP NO reemite (hoja estable entre reinicios)', () => {
  const a = TlsService.ensure(['192.168.1.50']);
  const b = TlsService.ensure(['192.168.1.50']);
  assert.equal(a.cert, b.cert, 'con las mismas SANs la hoja se conserva');
});

test('las credenciales las acepta el módulo TLS real de Node', () => {
  const { key, cert } = TlsService.ensure(['127.0.0.1']);
  // Si el par clave/certificado fuera inconsistente, createSecureContext lanza.
  assert.doesNotThrow(() => tls.createSecureContext({ key, cert }));
});

test('la CA es una autoridad (basicConstraints cA=true) y la hoja no', () => {
  const { cert, ca } = TlsService.ensure(['127.0.0.1']);
  const caBc   = forge.pki.certificateFromPem(ca).getExtension('basicConstraints');
  const leafBc = forge.pki.certificateFromPem(cert).getExtension('basicConstraints');
  assert.equal(caBc.cA, true);
  assert.equal(leafBc.cA, false);
});
