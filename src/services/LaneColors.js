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

// Colores de carril. Orden de prioridad: los del circuito (circuits.lane_colors)
// → los globales de Configuración (settings.lane_colors) → la paleta de fábrica.
// En los dos JSON guardados, una posición vacía significa "hereda".

const Settings = require('../models/Settings');
const Circuit  = require('../models/Circuit');

const DEFAULT_LANE_COLORS = Object.freeze([
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717',
]);

const HEX_RE = /^#[0-9a-f]{6}$/;

function normHex(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return HEX_RE.test(s) ? s : null;
}

function parseStored(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normHex) : [];
  } catch { return []; }
}

// Lista de overrides lista para guardar: null donde coincide con `base` (hereda).
// Devuelve null si no queda ningún override.
function toStored(colors, base) {
  const out = (colors || []).map((c, i) => {
    const h = normHex(c);
    return h && h !== base[i % base.length] ? h : null;
  });
  while (out.length && out[out.length - 1] == null) out.pop();
  return out.length ? JSON.stringify(out) : null;
}

function overlay(base, overrides, length) {
  const n = Math.max(length || 0, base.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(overrides[i] || base[i % base.length]);
  return out;
}

function globalColors() {
  return overlay(DEFAULT_LANE_COLORS, parseStored(Settings.get('lane_colors', '')));
}

function forCircuit(circuitOrId) {
  const c = (circuitOrId && typeof circuitOrId === 'object')
    ? circuitOrId
    : (circuitOrId ? Circuit.findById(parseInt(circuitOrId, 10)) : null);
  const base = globalColors();
  if (!c) return base;
  return overlay(base, parseStored(c.lane_colors), c.lanes_count);
}

function forRace(race) {
  return forCircuit(race && race.circuit_id);
}

function forTraining() {
  return forCircuit(Settings.get('training_circuit_id', ''));
}

// Texto legible encima del color (luminancia relativa WCAG).
function ink(hex) {
  const h = normHex(hex);
  if (!h) return '#fff';
  const lin = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return L > 0.4 ? '#000' : '#fff';
}

module.exports = {
  DEFAULT_LANE_COLORS,
  normHex,
  parseStored,
  toStored,
  global: globalColors,
  forCircuit,
  forRace,
  forTraining,
  ink,
};
