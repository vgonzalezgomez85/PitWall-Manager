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
// Parser de tramas DS-300 para carreras simuladas. Soporta:
//   · TXT: líneas "HH:MM:SS.mmm  DSn  <21 bytes hex>"  (formato completo multi-DS)
//   · CSV: export "vuelta N;tiempo;hex;e0;35;…;eb"      (un solo DS, por vuelta)
//
// Devuelve { frames, gos, analysis }:
//   frames   = [{ ts(ms relativo), ds:'DS1'|'DS2'|'DS3', bytes:[...] }]  (orden temporal)
//   gos      = [ts] de cada GO (inicio de manga) detectado en DS1 (o el primero disponible)
//   analysis = { mangas, durationMin, lanes, circuits:[{ds,lanes}], crossings, source }

const OFFSET = { DS1: 0, DS2: 8, DS3: 16 };
const LANE_MAP = { 0x80: 1, 0x40: 2, 0x20: 3, 0x10: 4, 0x08: 5, 0x04: 6, 0x02: 7, 0x01: 8 };

// Qué es cada trama lo dice el lector común (dsProtocol), el mismo del cronometraje.
const { decodeFrame } = require('./dsProtocol');

const tipo = b => (b.length >= 21 ? decodeFrame(null, b).type : null);
function isGo(b)     { return tipo(b) === 'go'; }        // arranque (0xA1, cualquier clase)
function isFinish(b) { return tipo(b) === 'finish'; }    // fin de manga
function goDurationMin(b) {                              // minutos de la manga, o null
  const d = decodeFrame(null, b);
  return d.type === 'go' && d.durationMs ? Math.round(d.durationMs / 60000) : null;
}
function laneLocal(b) {                                  // carril local (1-8) de un cruce
  const d = b.length >= 21 ? decodeFrame(null, b) : null;
  return d && d.type === 'crossing' && d.lanes.length === 1 ? d.lanes[0] : undefined;
}

// ── TXT (multi-DS, con timestamp absoluto) ───────────────────────────────────
function parseTxt(content) {
  const lines = content.replace(/^﻿/, '').replace(/\r/g, '').split('\n');
  let day = 0, prevSecs = null;
  const frames = [], gos = [];
  for (const ln of lines) {
    const m = ln.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(DS[123])\s+(.+)$/);
    if (!m) continue;
    const bytes = m[3].trim().split(/\s+/).map(h => parseInt(h, 16));
    if (bytes.length < 21 || bytes.some(isNaN)) continue;
    const [hh, mm, rest] = m[1].split(':'); const [ss, mmm] = rest.split('.');
    const secs = (+hh) * 3600 + (+mm) * 60 + (+ss);
    if (prevSecs != null && secs < prevSecs - 1) day++;   // cruce de medianoche
    prevSecs = secs;
    const ts = day * 86400000 + secs * 1000 + (+mmm);
    frames.push({ ts, ds: m[2], bytes });
    if (isGo(bytes) && m[2] === 'DS1') gos.push(ts);
  }
  return { frames, gos };
}

// ── CSV (un DS, por vuelta: "vuelta N;t;hex;e0;..;eb") ───────────────────────
// No trae timestamp absoluto ni GO; reconstruimos el elapsed sumando los tiempos
// de vuelta (col 2, "4,57" = 4,57 s). Lo tratamos como un único circuito (DS1).
function parseCsv(content) {
  const rows = content.replace(/^﻿/, '').replace(/\r/g, '').split('\n');
  const frames = [], gos = [];
  let elapsed = 0;
  for (const row of rows) {
    const cols = row.split(';');
    if (!/^\s*vuelta\s+\d+/i.test(cols[0] || '')) continue;
    const hexIdx = cols.findIndex(c => c.trim().toLowerCase() === 'hex');
    if (hexIdx < 0) continue;
    const bytes = cols.slice(hexIdx + 1).map(c => parseInt(c.trim(), 16)).filter(b => !isNaN(b));
    if (bytes.length < 21) continue;
    const tStr = (cols[1] || '0').replace(',', '.');
    const lapMs = Math.round((parseFloat(tStr) || 0) * 1000);
    elapsed += lapMs;
    frames.push({ ts: elapsed, ds: 'DS1', bytes });
    if (isGo(bytes)) gos.push(elapsed);
  }
  return { frames, gos };
}

// ── Análisis (para prerrellenar el asistente) ────────────────────────────────
function analyze(frames, gos) {
  const lanesByDs = { DS1: new Set(), DS2: new Set(), DS3: new Set() };
  const lanesGlobal = new Set();
  let crossings = 0, durationMin = null;
  for (const f of frames) {
    if (isGo(f.bytes) && durationMin == null) durationMin = goDurationMin(f.bytes);
    const local = laneLocal(f.bytes);
    if (local) {
      crossings++;
      lanesByDs[f.ds].add(local);
      lanesGlobal.add(local + (OFFSET[f.ds] || 0));
    }
  }
  // Si no hubo GO con duración, estimar por intervalo GO→GO (o null).
  if (durationMin == null && gos.length >= 2) {
    const gaps = [];
    for (let i = 1; i < gos.length; i++) gaps.push(gos[i] - gos[i - 1]);
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    durationMin = med ? Math.round(med / 60000) : null;
  }
  const circuits = ['DS1', 'DS2', 'DS3']
    .filter(ds => lanesByDs[ds].size > 0)
    .map(ds => ({ ds, lanes: Math.max(0, ...lanesByDs[ds]) }));
  return {
    mangas: Math.max(1, gos.length),
    durationMin: durationMin || null,
    lanes: lanesGlobal.size,
    circuits,
    crossings,
  };
}

// ── API principal ────────────────────────────────────────────────────────────
function parse(content, format /* 'txt' | 'csv' | undefined (autodetect) */) {
  const looksCsv = /;/.test(content.slice(0, 2000)) && /vuelta\s+\d+/i.test(content.slice(0, 4000));
  const fmt = format || (looksCsv ? 'csv' : 'txt');
  const { frames, gos } = fmt === 'csv' ? parseCsv(content) : parseTxt(content);
  return { frames, gos, analysis: { ...analyze(frames, gos), source: fmt } };
}

module.exports = { parse, parseTxt, parseCsv, analyze, OFFSET, LANE_MAP, isGo, isFinish, laneLocal, goDurationMin };
