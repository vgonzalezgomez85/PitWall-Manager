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
// Nombre y logo del club: se guardan en la BD y, con el interruptor puesto,
// salen en exportaciones, TV y QR junto al logo de PitWall.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const ExcelJS = require('exceljs');
const ClubBrand = require('../src/services/ClubBrand');
const SettingsController = require('../src/controllers/SettingsController');
const { addClubBand } = require('../src/utils/excelClubBand');

// PNG real de 3×2 píxeles.
const PNG_3x2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP4z8DwHwYZSOcAAPpGDfOZ+iJkAAAAAElFTkSuQmCC';

after(limpiarBdTemporal);
beforeEach(() => ClubBrand.save({ enabled: false, name: '', logo: '' }));

function fakeRes() {
  const res = { statusCode: 200, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (b) => { res.body = b; return res; };
  return res;
}

test('apagado o vacío no pinta nada', () => {
  assert.equal(ClubBrand.active(), null);
  ClubBrand.save({ enabled: true, name: '  ', logo: '' });
  assert.equal(ClubBrand.active(), null);
  ClubBrand.save({ enabled: false, name: 'Club Slot', logo: PNG_3x2 });
  assert.equal(ClubBrand.active(), null);
});

test('encendido devuelve nombre, logo incrustable y URL con versión', () => {
  ClubBrand.save({ enabled: true, name: ' Club Slot Llinars ', logo: PNG_3x2 });
  const a = ClubBrand.active();
  assert.equal(a.name, 'Club Slot Llinars');
  assert.equal(a.logoDataUri, PNG_3x2);
  assert.match(a.logoUrl, /^\/club\/logo\?v=\d+$/);
  const img = ClubBrand.logoImage();
  assert.equal(img.extension, 'png');
  assert.equal(img.width, 3);
  assert.equal(img.height, 2);
});

test('logo ausente no toca el guardado; vacío lo quita', () => {
  ClubBrand.save({ enabled: true, name: 'A', logo: PNG_3x2 });
  ClubBrand.save({ enabled: true, name: 'B' });
  assert.equal(ClubBrand.get().logo, PNG_3x2);
  ClubBrand.save({ enabled: true, name: 'B', logo: '' });
  assert.equal(ClubBrand.get().logo, '');
  assert.equal(ClubBrand.active().logoUrl, null);
});

test('rechaza lo que no es PNG/JPEG en base64', () => {
  assert.throws(() => ClubBrand.save({ enabled: true, name: 'X', logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), { code: 'invalid_logo' });
  assert.throws(() => ClubBrand.save({ enabled: true, name: 'X', logo: 'http://x/logo.png' }), { code: 'invalid_logo' });
});

test('el tamaño de un JPEG sale de su cabecera SOF', () => {
  const sof = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ClubBrand.imageSize({ buffer: sof, extension: 'jpeg' }), { width: 64, height: 32 });
});

test('POST /settings/club guarda y avisa del logo inválido', () => {
  const req = { body: { enabled: true, name: 'Club', logo: PNG_3x2 }, t: (k) => k };
  const res = fakeRes();
  SettingsController.saveClub(req, res);
  assert.deepEqual(res.body, { ok: true, enabled: true, name: 'Club', hasLogo: true });

  const bad = fakeRes();
  SettingsController.saveClub({ body: { enabled: true, name: 'Club', logo: 'nope' }, t: (k) => k }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(ClubBrand.get().logo, PNG_3x2);
});

test('GET /club/logo sirve la imagen o 404', () => {
  const none = fakeRes();
  SettingsController.clubLogo({ query: {} }, none);
  assert.equal(none.statusCode, 404);

  ClubBrand.save({ enabled: true, name: 'Club', logo: PNG_3x2 });
  const res = fakeRes();
  SettingsController.clubLogo({ query: { v: '1' } }, res);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0);
});

test('Excel: banda del club con su logo y el de PitWall', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja');
  ws.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 12 }];
  assert.equal(addClubBand(wb, ws, 7, { pitwallLogo: true }), null);
  assert.equal(ws.getImages().length, 0);

  ClubBrand.save({ enabled: true, name: 'Club Slot', logo: PNG_3x2 });
  const row = addClubBand(wb, ws, 7, { pitwallLogo: true });
  // Logo de 54 px de ancho (3×2 a 36 px de alto): cabe en A+B, el nombre va en C.
  assert.equal(row.getCell(3).value, 'Club Slot');
  assert.equal(row.getCell(1).value, null);
  const imgs = ws.getImages();
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].range.tl.nativeCol, 0);
  assert.equal(imgs[1].range.tl.nativeCol, 6);
});

test('vista: banda con el club y siempre la marca de PitWall; incrustada al exportar', async () => {
  const file = path.join(__dirname, '../src/views/partials/club-brand.ejs');
  const clubBrand = () => ClubBrand.active();
  assert.equal((await ejs.renderFile(file, { clubBrand })).trim(), '');

  ClubBrand.save({ enabled: true, name: 'Club <Slot>', logo: PNG_3x2 });
  const html = await ejs.renderFile(file, { clubBrand });
  assert.match(html, /Club &lt;Slot&gt;/);
  assert.match(html, /src="\/club\/logo\?v=\d+"/);
  assert.match(html, />PitWall</);

  const exported = await ejs.renderFile(file, { clubBrand, inlineClubLogo: true });
  assert.ok(exported.includes(`src="${PNG_3x2}"`));
});
