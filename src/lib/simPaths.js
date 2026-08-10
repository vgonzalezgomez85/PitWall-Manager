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
// Rutas de datos de la simulación de carrera.
//
// En empaquetado (Electron) el código vive en app.asar / Program Files, que es
// de SOLO LECTURA: escribir ahí (fs.mkdirSync) peta y tumba el arranque del
// server. Por eso los datos van a una carpeta ESCRIBIBLE: `PITWALL_DATA`
// (= app.getPath('userData'), igual criterio que config/database.js). En dev,
// cuando no está definida, caen en `database/` del repo.
const path = require('path');
const fs   = require('fs');

const BASE = process.env.PITWALL_DATA || path.join(__dirname, '..', '..', 'database');
const SIM_DIR = path.join(BASE, 'sim');

// Crea (si hace falta) el directorio de sim (o un subdirectorio) y lo devuelve.
// NUNCA lanza: si no se puede crear, no debe impedir que el server arranque.
function ensureSimDir(sub) {
  const dir = sub ? path.join(SIM_DIR, sub) : SIM_DIR;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best-effort */ }
  return dir;
}

module.exports = { SIM_DIR, ensureSimDir };
