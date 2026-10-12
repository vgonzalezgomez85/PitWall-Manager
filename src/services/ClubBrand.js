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
// Nombre y logo del club (Ajustes → Preferencias). Con el interruptor puesto
// salen en exportaciones, TV y QR, junto al de PitWall (que no se quita nunca).
// El logo vive en la BD como data URI: así entra en las copias de seguridad y
// funciona igual en Electron, donde `public/` está dentro del asar (solo lectura).
// El navegador lo reduce y lo pasa a PNG/JPEG al subirlo: ExcelJS no incrusta SVG/WebP.

const Settings = require('../models/Settings');

const MAX_NAME = 80;
const MAX_LOGO_BYTES = 1024 * 1024;
const DATA_URI_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

function parseDataUri(uri) {
  const m = DATA_URI_RE.exec(String(uri || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > MAX_LOGO_BYTES) return null;
  return { extension: m[1], buffer };
}

function get() {
  const logo = Settings.get('club_logo', '') || '';
  return {
    enabled: Settings.get('club_brand_enabled', '0') === '1',
    name:    Settings.get('club_name', '') || '',
    logo:    parseDataUri(logo) ? logo : '',
    version: Settings.get('club_logo_ver', '0') || '0',
  };
}

// La marca a pintar, o null si está apagada o no hay nada que mostrar.
function active() {
  const b = get();
  if (!b.enabled || (!b.name && !b.logo)) return null;
  return {
    name:        b.name,
    logoDataUri: b.logo || null,
    logoUrl:     b.logo ? `/club/logo?v=${b.version}` : null,
  };
}

// Ancho × alto en píxeles de un PNG o JPEG (para no deformarlo en el Excel).
function imageSize({ buffer: b, extension }) {
  if (extension === 'png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (extension === 'jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// Para ExcelJS: { buffer, extension, width, height } o null.
function logoImage() {
  const a = active();
  const img = a && a.logoDataUri ? parseDataUri(a.logoDataUri) : null;
  if (!img) return null;
  const size = imageSize(img) || { width: 1, height: 1 };
  return { ...img, width: size.width || 1, height: size.height || 1 };
}

// logo: undefined = no tocar, '' = quitar, data URI = sustituir.
function save({ enabled, name, logo }) {
  if (logo !== undefined && logo !== '' && !parseDataUri(logo)) {
    const e = new Error('invalid_logo'); e.code = 'invalid_logo'; throw e;
  }
  const out = {
    club_brand_enabled: enabled ? '1' : '0',
    club_name: String(name || '').trim().slice(0, MAX_NAME),
  };
  if (logo !== undefined) {
    out.club_logo = logo;
    out.club_logo_ver = String(Date.now());
  }
  Settings.setMany(out);
  return get();
}

module.exports = { get, active, logoImage, save, parseDataUri, imageSize, MAX_NAME, MAX_LOGO_BYTES };
