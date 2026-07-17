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
// TLS local para PitWall — HTTPS en la LAN sin depender de internet.
//
// POR QUÉ: el escáner QR del control de pilotos usa la cámara (getUserMedia), y
// el navegador solo la concede en un "contexto seguro": localhost o HTTPS. En
// los móviles/tablets que entran por la IP de la red (no localhost) hace falta
// HTTPS. En un circuito no hay internet fiable ni un dominio público, así que
// un certificado "de verdad" (Let's Encrypt) no es viable — la vía es un
// certificado propio.
//
// CÓMO: en vez de un certificado suelto, PitWall crea SU PROPIA autoridad raíz
// (CA) y firma con ella el certificado del servidor. Una sola implementación
// cubre dos experiencias:
//   · Sin instalar nada → el navegador avisa una vez ("no privada → continuar").
//   · Instalando la CA de PitWall en el dispositivo → sin ningún aviso.
// Y como la CA es estable, si cambia la IP de la LAN solo se reemite el
// certificado HOJA (con las nuevas IPs): los dispositivos que ya confiaron en la
// CA NO vuelven a avisar. Igual que hace `mkcert`, pero autocontenido.
//
// Los ficheros viven junto a la base de datos (SLOTIME_DATA), en `tls/`.
const path   = require('path');
const fs     = require('fs');
const forge  = require('node-forge');

const CA_DAYS   = 3650;   // 10 años — la CA se instala una vez y no queremos rehacerla
const LEAF_DAYS = 825;    // límite de facto de los navegadores modernos para hojas TLS

function dataDir() {
  return process.env.SLOTIME_DATA
    ? path.join(process.env.SLOTIME_DATA, 'tls')
    : path.join(__dirname, '../../database/tls');
}

const P = (name) => path.join(dataDir(), name);
const CA_KEY   = () => P('ca.key.pem');
const CA_CERT  = () => P('ca.cert.pem');
const SRV_KEY  = () => P('server.key.pem');
const SRV_CERT = () => P('server.cert.pem');
const SRV_META = () => P('server.sans.json');   // SANs con las que se emitió la hoja

// Número de serie hex aleatorio (los navegadores rechazan seriales repetidos de
// una misma CA; nunca cero, y con el bit alto a cero para que sea positivo).
function serial() {
  const b = forge.random.getBytesSync(16).split('').map(c => c.charCodeAt(0));
  b[0] &= 0x7f;
  return b.map(x => x.toString(16).padStart(2, '0')).join('');
}

// notBefore un día antes (tolera desfase de reloj entre servidor y dispositivo).
function notBefore() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// ── Autoridad raíz (CA) ─────────────────────────────────────────────────────
function createCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = notBefore();
  cert.validity.notAfter  = daysFromNow(CA_DAYS);

  const attrs = [
    { name: 'commonName',   value: 'PitWall Local CA' },
    { name: 'organizationName', value: 'PitWall' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);                          // autofirmada
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: keys.privateKey, cert };
}

function loadCA() {
  const key  = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY(), 'utf8'));
  const cert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT(), 'utf8'));
  return { key, cert };
}

function ensureCA() {
  fs.mkdirSync(dataDir(), { recursive: true });
  if (fs.existsSync(CA_KEY()) && fs.existsSync(CA_CERT())) return loadCA();
  const ca = createCA();
  // La clave de la CA es sensible: permisos 0600 (en Windows se ignora, pero no
  // molesta). Es local y no sale de la máquina.
  fs.writeFileSync(CA_KEY(),  forge.pki.privateKeyToPem(ca.key),  { mode: 0o600 });
  fs.writeFileSync(CA_CERT(), forge.pki.certificateToPem(ca.cert), { mode: 0o644 });
  console.log('[TLS] Autoridad raíz creada:', CA_CERT());
  return ca;
}

// ── Certificado del servidor (hoja), firmado por la CA ──────────────────────
// sans: lista de hostnames/IPs que debe cubrir (localhost, 127.0.0.1, IPs LAN…).
function issueServerCert(ca, sans) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = notBefore();
  cert.validity.notAfter  = daysFromNow(LEAF_DAYS);

  const subject = [
    { name: 'commonName', value: sans.find(s => s.type === 'dns')?.value || 'PitWall' },
    { name: 'organizationName', value: 'PitWall' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(ca.cert.subject.attributes);

  const altNames = sans.map(s => s.type === 'ip'
    ? { type: 7, ip: s.value }        // 7 = IP address
    : { type: 2, value: s.value });   // 2 = DNS name
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { key: keys.privateKey, cert };
}

// Construye la lista de SANs a partir de los hostnames/IPs actuales.
function buildSans(ips) {
  const sans = [
    { type: 'dns', value: 'localhost' },
    { type: 'ip',  value: '127.0.0.1' },
    { type: 'ip',  value: '::1' },
  ];
  for (const ip of ips || []) {
    if (ip && !sans.some(s => s.value === ip)) sans.push({ type: 'ip', value: ip });
  }
  return sans;
}

function sansSignature(sans) {
  return sans.map(s => `${s.type}:${s.value}`).sort().join(',');
}

// ── API pública ─────────────────────────────────────────────────────────────
const TlsService = {
  dir: dataDir,

  // Devuelve { key, cert, ca } en PEM listos para https.createServer.
  // Reutiliza la CA persistida; reemite la hoja si no cubre las IPs de ahora.
  ensure(ips = []) {
    const ca = ensureCA();
    const wanted = buildSans(ips);
    const sig = sansSignature(wanted);

    let reuse = false;
    if (fs.existsSync(SRV_KEY()) && fs.existsSync(SRV_CERT()) && fs.existsSync(SRV_META())) {
      try {
        const meta = JSON.parse(fs.readFileSync(SRV_META(), 'utf8'));
        reuse = meta.sig === sig;
      } catch { reuse = false; }
    }

    if (!reuse) {
      const leaf = issueServerCert(ca, wanted);
      fs.writeFileSync(SRV_KEY(),  forge.pki.privateKeyToPem(leaf.key),  { mode: 0o600 });
      fs.writeFileSync(SRV_CERT(), forge.pki.certificateToPem(leaf.cert), { mode: 0o644 });
      fs.writeFileSync(SRV_META(), JSON.stringify({ sig, sans: wanted }, null, 0));
      console.log('[TLS] Certificado del servidor emitido para:', wanted.map(s => s.value).join(', '));
    }

    return {
      key:  fs.readFileSync(SRV_KEY(),  'utf8'),
      cert: fs.readFileSync(SRV_CERT(), 'utf8'),
      ca:   fs.readFileSync(CA_CERT(),  'utf8'),
    };
  },

  // PEM de la CA raíz — es público (no lleva clave privada) y es lo que se
  // instala en cada dispositivo para que el HTTPS salga sin avisos.
  caCertPem() {
    ensureCA();
    return fs.readFileSync(CA_CERT(), 'utf8');
  },

  // Huella SHA-256 de la CA, para que el usuario pueda cotejar que instala la
  // suya y no otra (formato AA:BB:CC…).
  caFingerprint() {
    const pem = this.caCertPem();
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(
      forge.pki.certificateFromPem(pem))).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex().toUpperCase().match(/.{2}/g).join(':');
  },

  // Utilidades expuestas para los tests.
  _internal: { buildSans, sansSignature, issueServerCert, createCA },
};

module.exports = TlsService;
