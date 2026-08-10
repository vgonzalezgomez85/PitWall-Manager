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
// Base de datos aislada para los tests.
//
// `src/config/database.js` resuelve la ruta UNA sola vez, en su top-level, y
// exporta un singleton ya abierto. Por eso hay que fijar PITWALL_DATA ANTES de
// que nadie haga require() de la BD o de un modelo. Como `node --test` corre un
// proceso por fichero, basta con llamar a usarBdTemporal() en la primera línea
// del test, antes de los require.
//
//   const { usarBdTemporal } = require('./helpers/db');
//   usarBdTemporal();                       // ← antes de todo lo demás
//   const db = require('../src/config/database');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let dir = null;

/** Apunta la BD a un directorio temporal vacío. Devuelve la ruta. */
function usarBdTemporal() {
  if (dir) return dir;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-'));
  process.env.PITWALL_DATA = dir;
  return dir;
}

/** Borra el directorio temporal (llámalo en un after()). */
function limpiarBdTemporal() {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  dir = null;
}

module.exports = { usarBdTemporal, limpiarBdTemporal };
