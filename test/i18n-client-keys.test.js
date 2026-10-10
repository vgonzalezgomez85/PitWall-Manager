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
// Los textos que pinta el navegador (`I18N.t('client.…')`) viajan en un diccionario que
// el servidor arma ESCANEANDO las vistas y public/js. Dos fallos reales de ese escaneo:
//  - la clave con guion (`client.pole-timing.on`) no la reconocía la expresión, y
//    más de 60 textos (Control de pilotos, nueva tanda, pole…) salían como clave cruda;
//  - una clave dentro de un `?:` dentro de `I18N.t(` tampoco.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('../src/middleware/i18n');

const raiz = path.join(__dirname, '..');

function diccionarioCliente(lang = 'es') {
  const req = { query: { lang }, session: {}, headers: {}, originalUrl: '/' };
  const res = { locals: {} };
  i18n(req, res, () => {});
  return res.locals.i18nClient;
}
const buscar = (d, clave) => clave.split('.').reduce((x, k) => (x == null ? x : x[k]), d);

function clavesUsadas() {
  const set = new Set();
  const leer = (dir, ext) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) leer(p, ext);
      else if (p.endsWith(ext)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/I18N\.t\(\s*'([\w.-]+)'/g)) set.add(m[1]);
      }
    }
  };
  leer(path.join(raiz, 'src', 'views'), '.ejs');
  leer(path.join(raiz, 'public', 'js'), '.js');
  return set;
}

test('las claves con guion (client.pole-timing.*) viajan en el diccionario del navegador', () => {
  const d = diccionarioCliente('es');
  assert.equal(buscar(d, 'client.pole-timing.on'), 'ON');
  assert.equal(buscar(d, 'client.pole-timing.pulsa_go_para_empezar'), 'Pulsa GO para empezar');
  assert.equal(typeof buscar(d, 'client.shifts-live'), 'object', 'una sección entera con guion');
});

test('TODA clave que el navegador pide existe en el español (si no, sale cruda en pantalla)', () => {
  const es = require('../src/locales/es.json');
  const faltan = [...clavesUsadas()].filter(c => typeof buscar(es, c) !== 'string');
  assert.deepEqual(faltan, [], 'claves usadas en el navegador que no están en es.json');
});

test('el diccionario lleva TODAS las claves que el navegador pide', () => {
  const d = diccionarioCliente('es');
  const faltan = [...clavesUsadas()].filter(c => typeof buscar(d, c) !== 'string');
  assert.deepEqual(faltan, []);
});
