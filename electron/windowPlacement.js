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
// En qué pantalla y cómo se abre cada tipo de ventana (Ajustes → Ventanas y
// pantallas). Módulo PURO: no carga Electron, así se prueba con `npm test`.
//
// Las pantallas se guardan por POSICIÓN (1 = la principal, 2.. el resto de
// izquierda a derecha), nunca por el `id` de Electron: ese id cambia al
// reiniciar o al reconectar el monitor, y en macOS el nombre suele venir vacío.

const TYPES = ['training', 'live', 'tv', 'pole', 'lemans'];
const MODES = ['normal', 'maximized', 'fullscreen'];

const ROUTES = [
  ['training', /^\/training(\/free|\/live)?$/],
  ['live',     /^\/races\/\d+\/mangas\/\d+\/live$/],
  ['tv',       /^\/races\/\d+\/mangas\/\d+\/tv$/],
  ['pole',     /^\/races\/\d+\/pole\/timing$/],
  ['lemans',   /^\/races\/\d+\/lemans$/],
];

function classify(url) {
  let p;
  try { p = new URL(url, 'http://x').pathname.replace(/\/+$/, '') || '/'; } catch { return null; }
  for (const [type, re] of ROUTES) if (re.test(p)) return type;
  return null;
}

// La principal primero; el resto de izquierda a derecha y, a igual x, de arriba abajo.
function orderDisplays(displays, primaryId) {
  const list = Array.isArray(displays) ? displays.slice() : [];
  const primary = list.find(d => d.id === primaryId) || list[0];
  const rest = list.filter(d => d !== primary)
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y));
  return primary ? [primary, ...rest] : rest;
}

// display 0 = sin asignar (la ventana se abre como siempre).
function sanitize(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const type of TYPES) {
    const r = src[type] && typeof src[type] === 'object' ? src[type] : {};
    const display = Number.isInteger(r.display) && r.display >= 0 && r.display <= 16 ? r.display : 0;
    const mode = MODES.includes(r.mode) ? r.mode : 'normal';
    out[type] = { display, mode };
    if (type === 'training') out[type].autostart = r.autostart === true;
  }
  return out;
}

// Ventana centrada en el área útil de la pantalla y que quepa en ella.
function boundsFor(display, width, height) {
  const wa = display.workArea || display.bounds;
  const w = Math.min(width, wa.width);
  const h = Math.min(height, wa.height);
  return {
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    width: w,
    height: h,
  };
}

// null = sin regla para esa ventana. Si la pantalla asignada no está conectada
// va a la principal y en ventana normal: a pantalla completa taparía al
// operador, y en las coordenadas de un monitor que ya no existe la ventana
// quedaría abierta pero invisible.
function resolve(prefs, type, displays, primaryId, size = { width: 1280, height: 860 }) {
  const rule = sanitize(prefs)[type];
  if (!rule || !rule.display) return null;
  const ordered = orderDisplays(displays, primaryId);
  if (!ordered.length) return null;
  const target = ordered[rule.display - 1];
  const display = target || ordered[0];
  return {
    bounds: boundsFor(display, size.width, size.height),
    mode: target ? rule.mode : 'normal',
    fallback: !target,
  };
}

module.exports = { TYPES, MODES, classify, orderDisplays, sanitize, boundsFor, resolve };
