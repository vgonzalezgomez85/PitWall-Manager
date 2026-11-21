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
// Control remoto (teclado de macros): ajustes `remote_keys_*` (Ajustes → Preferencias).
const Settings = require('../models/Settings');
const RK = require('../lib/remoteKeys');

const KEY = { enabled: 'remote_keys_enabled', go: 'remote_key_go', pause: 'remote_key_pause', stop: 'remote_key_stop' };

/** {enabled, keys:{go,pause,stop}}; un valor guardado inválido o repetido cae al de fábrica. */
function get() {
  const keys = {};
  for (const a of RK.ACTIONS) keys[a] = RK.normalize(Settings.get(KEY[a])) || RK.DEFAULTS[a];
  if (!RK.validate(keys).ok) Object.assign(keys, RK.DEFAULTS);
  return { enabled: Settings.get(KEY.enabled) === '1', keys };
}

/** Valida y guarda. Devuelve {ok:true, config} o {ok:false, errors}. */
function save({ enabled, keys }) {
  const v = RK.validate(keys);
  if (!v.ok) return { ok: false, errors: v.errors };
  Settings.set(KEY.enabled, enabled ? '1' : '0');
  for (const a of RK.ACTIONS) Settings.set(KEY[a], RK.normalize(keys[a]));
  return { ok: true, config: get() };
}

module.exports = { get, save };
