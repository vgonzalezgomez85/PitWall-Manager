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

// Copia de la BD al arrancar, ANTES del esquema y las migraciones (idea de
// Emanuele Palena): una versión nueva nunca deja la BD sin red. VACUUM INTO da
// una copia consistente y compacta aunque haya WAL (~0,2 s con 90 MB). Va a
// <datos>/_backups-auto/pitwall-AAAAMMDD-HHMMSS-vX.Y.Z.db; como mucho una cada
// MIN_INTERVAL_MS con la misma versión (los reinicios seguidos no llenan el
// disco) y siempre al cambiar de versión. Se guardan las KEEP últimas. Una copia
// fallida solo avisa: nunca impide arrancar.
const DIR_NAME = '_backups-auto';
const KEEP = 5;
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NAME_RE = /^pitwall-\d{8}-\d{6}-v[\w.-]+\.db$/;

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copias existentes, de la más nueva a la más antigua. */
function list(dataDir) {
  const dir = path.join(dataDir, DIR_NAME);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => NAME_RE.test(f))
    .map(f => ({ file: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function prune(dataDir, keep = KEEP) {
  list(dataDir).slice(keep).forEach(x => { try { fs.unlinkSync(x.path); } catch {} });
}

/**
 * Hace la copia si toca. Devuelve su ruta, o null si no tocaba, está
 * desactivada (PITWALL_NO_AUTOBACKUP=1, tests) o ha fallado.
 */
function snapshot(db, dataDir, version, { now = Date.now(), force = false } = {}) {
  try {
    if (!force && (process.env.PITWALL_NO_AUTOBACKUP === '1' || process.env.NODE_TEST_CONTEXT)) return null;
    const tag = String(version || 'x').replace(/[^0-9A-Za-z.-]/g, '') || 'x';
    const last = list(dataDir)[0];
    if (!force && last && last.file.endsWith(`-v${tag}.db`) && now - last.mtime < MIN_INTERVAL_MS) return null;

    const dir = path.join(dataDir, DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `pitwall-${stamp(now)}-v${tag}.db`);
    if (fs.existsSync(target)) return null;
    db.prepare('VACUUM INTO ?').run(target);
    prune(dataDir);
    console.log('[database] Copia automática al arrancar:', target);
    return target;
  } catch (err) {
    console.warn('[database] No se pudo hacer la copia automática:', err.message);
    return null;
  }
}

module.exports = { snapshot, list, prune, DIR_NAME, KEEP, MIN_INTERVAL_MS };
