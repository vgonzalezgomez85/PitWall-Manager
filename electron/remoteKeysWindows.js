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
// Qué hace el proceso principal de Electron cuando llega un atajo global del
// Control remoto: a qué ventanas se lo ofrece y en qué orden. Módulo PURO (sin
// Electron): se prueba con `npm test`.
//
// Primero la ventana enfocada; después el resto, la usada más recientemente
// primero. La primera que responda `true` (había un botón que pulsar) se queda
// con la orden y no se repite en las demás.

function createFocusTracker() {
  const last = new Map();   // id de ventana → marca del último foco
  let seq = 0;
  return {
    note(id) { last.set(id, ++seq); },
    forget(id) { last.delete(id); },
    last(id) { return last.get(id) || 0; },
  };
}

// windows: [{ id, focused }] → ids en orden de intento.
function orderTargets(windows, tracker) {
  return windows
    .map((w, i) => ({ w, i }))
    .sort((a, b) =>
      (b.w.focused ? 1 : 0) - (a.w.focused ? 1 : 0)
      || tracker.last(b.w.id) - tracker.last(a.w.id)
      || a.i - b.i)
    .map(x => x.w.id);
}

const ACTIONS = ['go', 'pause', 'stop'];

function scriptFor(action) {
  if (!ACTIONS.includes(action)) throw new Error('acción desconocida: ' + action);
  return `typeof window.pwRemote==='function' ? window.pwRemote(${JSON.stringify(action)}) : false`;
}

// `attempt(id)` → Promise<boolean>; un fallo cuenta como «no». Devuelve el id
// que actuó o null.
async function dispatch(ids, attempt) {
  for (const id of ids) {
    let ok = false;
    try { ok = (await attempt(id)) === true; } catch { ok = false; }
    if (ok) return id;
  }
  return null;
}

module.exports = { createFocusTracker, orderTargets, scriptFor, dispatch, ACTIONS };
