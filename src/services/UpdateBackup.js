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
const fs   = require('fs');
const path = require('path');

// Copia de la BD justo antes de instalar una actualización, junto a la BD:
// <datos>/_backup-pre-update-<versión>-<fecha>/pitwall.db. Se guardan las
// KEEP últimas (la BD de un club pasa de 70 MB).
const KEEP = 3;
const PREFIX = '_backup-pre-update-';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function prune(dataDir, keep = KEEP) {
  const dirs = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(PREFIX))
    .map(e => ({ name: e.name, mtime: fs.statSync(path.join(dataDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  dirs.slice(keep).forEach(d => fs.rmSync(path.join(dataDir, d.name), { recursive: true, force: true }));
}

async function create(fromVersion, db = require('../config/database')) {
  const dataDir = path.dirname(db.name);
  const tag = String(fromVersion).replace(/[^0-9A-Za-z.-]/g, '') || 'x';
  const dir = path.join(dataDir, `${PREFIX}${tag}-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pitwall.db');
  await db.backup(file);
  try { prune(dataDir); } catch (err) { console.error('[update] limpiar copias viejas:', err.message); }
  return file;
}

module.exports = { create, prune, PREFIX, KEEP };
