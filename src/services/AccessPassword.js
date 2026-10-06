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
// Contraseña de acceso a la parte de organización (Ajustes → Seguridad).
// Se guarda solo el hash scrypt con sal: `scrypt$<sal hex>$<hash hex>`.
// PITWALL_DISABLE_PASSWORD=1 la ignora: es la salida si el club la olvida.

const crypto   = require('crypto');
const Settings = require('../models/Settings');

const KEY_ENABLED = 'access_password_enabled';
const KEY_HASH    = 'access_password_hash';
const MIN_LENGTH  = 4;

// Bloqueo por IP tras varios fallos seguidos, para que no se pueda probar a ciegas.
const MAX_FAILS = 5;
const LOCK_MS   = 30000;
const _fails = new Map();

function hash(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

function verify(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

// En memoria: annotateAccess lo consulta en cada petición (Lap web hace decenas
// por segundo). Solo cambia por setPassword/setEnabled.
let _enabled = null;
function isEnabled() {
  if (process.env.PITWALL_DISABLE_PASSWORD === '1') return false;
  if (_enabled === null) _enabled = Settings.get(KEY_ENABLED, '0') === '1' && !!Settings.get(KEY_HASH, '');
  return _enabled;
}

function hasPassword() {
  return !!Settings.get(KEY_HASH, '');
}

function setPassword(password) {
  Settings.set(KEY_HASH, hash(password));
  _enabled = null;
}

function setEnabled(on) {
  Settings.set(KEY_ENABLED, on ? '1' : '0');
  if (!on) Settings.set(KEY_HASH, '');
  _enabled = null;
}

function lockedFor(ip) {
  const f = _fails.get(ip);
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { _fails.delete(ip); return 0; }
  return left;
}

// Comprueba la contraseña llevando la cuenta de fallos de esa IP. El propio
// equipo (`lockable: false`) nunca se bloquea: quien está delante del PC de
// cronometraje no puede quedarse fuera por equivocarse. Devuelve { ok, lockedMs }.
function attempt(ip, password, { lockable = true } = {}) {
  const locked = lockable ? lockedFor(ip) : 0;
  if (locked) return { ok: false, lockedMs: locked };
  if (verify(password, Settings.get(KEY_HASH, ''))) {
    _fails.delete(ip);
    return { ok: true, lockedMs: 0 };
  }
  if (!lockable) return { ok: false, lockedMs: 0 };
  const f = _fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= MAX_FAILS) { f.n = 0; f.until = Date.now() + LOCK_MS; }
  _fails.set(ip, f);
  return { ok: false, lockedMs: lockedFor(ip) };
}

module.exports = {
  MIN_LENGTH, hash, verify, isEnabled, hasPassword, setPassword, setEnabled, attempt,
  _resetFails: () => { _fails.clear(); _enabled = null; },
};
