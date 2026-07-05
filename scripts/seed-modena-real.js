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
// Alta de la carrera real "24h Modena" con el VUELTA A VUELTA REAL extraído de las
// tramas DS-300 (info para proyecto infolap slot/tramas_20_junio.txt).
//
// Sustituye la reconstrucción sintética (seed-modena-24h.js) por los cruces reales:
//   · Rotación r (1..22) = ventana entre GO#(38+r) y GO#(39+r) de DS1 (mangas de 57 min).
//     GO#39 (11:45 d0) = rotación 1 … GO#60 (10:05 d1) = rotación 22. (GO#38 fue salida abortada.)
//     La 22ª se corrió físicamente pero TicTac no la clasificó (se reinició a las 11:06);
//     el resultado oficial del PDF se queda en 21 rotaciones.
//   · Carril global = offset del DS (DS1:0, DS2:8, DS3:16) + bitmask del byte 10.
//   · Equipo en cada carril/rotación = parcial del registro (rot 1-21) o "Situación
//     Parcial 22/22" (rot 22), ambos en modena.json.
//   · Tiempo de vuelta = bytes 14-17 (decimal-en-hex); 1ª vuelta = out-lap (warmup);
//     cruces con tiempo < min_lap (8,5s) = fantasma, su tiempo se fusiona con la vuelta
//     siguiente (igual que la "vuelta acumulada" de TicTac).
//
// Uso: node scripts/seed-modena-real.js

const path = require('path');
const fs = require('fs');
const db = require('../src/config/database');
const Race = require('../src/models/Race');
const Tanda = require('../src/models/Tanda');
const Team = require('../src/models/Team');

const TRAMAS = path.join(__dirname, '../info para proyecto infolap slot/tramas_20_junio.txt');
const modena = require('./modena.json');

const RACE_NAME = '24h Modena';
const LANE_SEQUENCE = [1,3,5,7,9,11,13,15,0,17,19,21,23,0,24,22,20,18,16,14,12,10,8,6,4,2,0]
  .filter((v,i,a)=>true); // se sobreescribe abajo según activos reales
const ACTIVE_SEQ = [1,3,5,7,9,11,13,15,17,19,21,22,20,18,16,14,12,10,8,6,4,2]; // 22 carriles, orden de rotación
const CIRCUITS = [8, 8, 6];
const MIN_LAP_MS = 8500;
const EXIT_MARGIN_MS = 1700;       // salida: lap − mediaLimpia ≥ 1,7s (igual que TimingService)
const PIT_STOP_MULTIPLIER = 2;     // pit-stop: salida y lap ≥ 2× mediaLimpia
const MANGA_MIN = 57;
const MANGA_MS = MANGA_MIN * 60 * 1000;
const N_ROTATIONS = 22;           // carrera física completa (la 22ª no la clasificó TicTac)
const GO_INDEX_ROT1 = 38;         // gosDS1[38] = GO#39 = rotación 1
const BASE_DATE = Date.UTC(2026, 5, 20, 0, 0, 0); // sábado 20-jun-2026 00:00 UTC

// ── Decodificación DS-300 ────────────────────────────────────────────────────
const OFFSET = { DS1: 0, DS2: 8, DS3: 16 };
const LANE_MAP = { 0x80:1,0x40:2,0x20:3,0x10:4,0x08:5,0x04:6,0x02:7,0x01:8 };
const dsv = b => (((b>>4)<=9 && (b&0xF)<=9) ? parseInt(b.toString(16),10) : null);
const lapMs = f => { const m=dsv(f[14]),s=dsv(f[15]),c=dsv(f[16]),d=dsv(f[17]); return [m,s,c,d].some(x=>x===null)?null:m*60000+s*1000+c*10+d*0.1; };

// ── Parseo de tramas ──────────────────────────────────────────────────────────
const lines = fs.readFileSync(TRAMAS, 'utf8').replace(/^﻿/, '').replace(/\r/g, '').split('\n');
let day = 0, prevSecs = null;
const gosDS1 = [];                 // ts absolutos de los GO de DS1
const crossings = [];              // { ts, lane, lap }  (lap = ms o null)

for (const ln of lines) {
  const m = ln.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(DS[123])\s+(.+)$/);
  if (!m) continue;
  const b = m[3].trim().split(/\s+/).map(h => parseInt(h, 16));
  if (b.length < 21) continue;
  const [hh, mm, rest] = m[1].split(':');
  const [ss, mmm] = rest.split('.');
  const secs = (+hh)*3600 + (+mm)*60 + (+ss);
  if (prevSecs != null && secs < prevSecs - 1) day++;
  prevSecs = secs;
  const ts = BASE_DATE + day*86400000 + secs*1000 + (+mmm);

  if (b[7] === 0x3e && b[8] === 0xa1) { if (m[2] === 'DS1') gosDS1.push(ts); continue; }
  if (b[7] === 0x00 && (b[8] === 0xC0 || b[8] === 0xa2 || b[8] === 0xa3)) continue;
  const local = LANE_MAP[b[10]];
  if (!local) continue;            // frames de control sin carril
  crossings.push({ ts, lane: local + OFFSET[m[2]], lap: lapMs(b) });
}
crossings.sort((a, b) => a.ts - b.ts);
console.log(`Tramas: ${gosDS1.length} GO(DS1), ${crossings.length} cruces.`);

// ── Por rotación y carril: lista de cruces ordenados ─────────────────────────
function crossingsInWindow(t0, t1) {
  // búsqueda lineal acotada (crossings ya ordenados)
  return crossings.filter(c => c.ts >= t0 && c.ts < t1);
}

// Genera las vueltas de un carril a partir de sus cruces (en orden temporal).
// Devuelve [{ lap_time_ms, elapsed_ms, ts, is_warmup, is_ghost, lap_number }]
function buildLaps(laneCross, goTs) {
  const out = [];
  let lapNum = 0, ghostAccum = 0;
  // Medias corrientes por carril (se reinician cada manga): "limpia" = sin
  // salidas; "total" = todas las de carrera (fallback antes de tener limpias).
  let cleanSum = 0, cleanCount = 0, totalSum = 0, totalCount = 0;
  laneCross.forEach((c, idx) => {
    if (idx === 0) {
      // out-lap (primer paso por el sensor): warmup, no cuenta para mejor/media/salidas
      lapNum++;
      out.push({ lap_time_ms: Math.round(c.ts - goTs), elapsed_ms: Math.round(c.ts - goTs), ts: c.ts, is_warmup: 1, is_exit: 0, is_pit_stop: 0, lap_number: lapNum });
      return;
    }
    let t = c.lap;
    if (t == null) t = c.ts - laneCross[idx-1].ts; // sin referencia → delta por ts
    if (t < MIN_LAP_MS) { ghostAccum += t; return; } // fantasma: fusiona con la siguiente
    t += ghostAccum; ghostAccum = 0;
    lapNum++;
    // Clasificación salida/pit-stop con la media limpia ANTES de esta vuelta.
    const refAvg = cleanCount > 0 ? cleanSum / cleanCount : (totalCount > 0 ? totalSum / totalCount : 0);
    const isExit = refAvg > 0 && (t - refAvg >= EXIT_MARGIN_MS);
    const isPit  = isExit && t >= refAvg * PIT_STOP_MULTIPLIER;
    totalSum += t; totalCount++;
    if (!isExit) { cleanSum += t; cleanCount++; }  // las salidas no ensucian la media limpia
    out.push({ lap_time_ms: Math.round(t), elapsed_ms: Math.round(c.ts - goTs), ts: c.ts, is_warmup: 0, is_exit: isExit ? 1 : 0, is_pit_stop: isPit ? 1 : 0, lap_number: lapNum });
  });
  return out;
}

// ── Limpieza idempotente ─────────────────────────────────────────────────────
const existing = db.prepare('SELECT id FROM races WHERE name = ?').all(RACE_NAME);
if (existing.length) {
  const wipe = db.transaction(ids => {
    for (const { id } of ids) {
      db.prepare('DELETE FROM laps WHERE race_id=?').run(id);
      db.prepare('DELETE FROM manga_lanes WHERE manga_id IN (SELECT id FROM mangas WHERE race_id=?)').run(id);
      db.prepare('DELETE FROM mangas WHERE race_id=?').run(id);
      db.prepare('DELETE FROM driver_shifts WHERE race_id=?').run(id);
      db.prepare('DELETE FROM drivers WHERE race_id=?').run(id);
      db.prepare('DELETE FROM teams WHERE race_id=?').run(id);
      db.prepare('DELETE FROM tandas WHERE race_id=?').run(id);
      db.prepare('DELETE FROM races WHERE id=?').run(id);
    }
  });
  wipe(existing);
  console.log(`Borradas ${existing.length} carrera(s) "${RACE_NAME}" previas.`);
}

// ── Alta de carrera + tanda + equipos ────────────────────────────────────────
const COLORS = Array.from({ length: 22 }, (_, i) => `hsl(${Math.round(i*360/22)}, 70%, 50%)`);
const TEAM_NAMES = modena.teams;
const raceId = Race.create({
  name: RACE_NAME, type: 'club', format: 'team', lanes_count: 22,
  lane_sequence: ACTIVE_SEQ, manga_duration_minutes: MANGA_MIN, circuits: CIRCUITS, has_pole: 0, min_lap_ms: MIN_LAP_MS,
});
const tandaId = Tanda.create(raceId);
const teamIdByName = {};
TEAM_NAMES.forEach((name, i) => {
  teamIdByName[name] = Team.create({ race_id: raceId, tanda_id: tandaId, name, lane: 0, color: COLORS[i % COLORS.length] });
});
console.log(`Carrera #${raceId} "${RACE_NAME}" creada con ${TEAM_NAMES.length} equipos.`);

// ── Mangas + carriles + vueltas reales ───────────────────────────────────────
const insManga = db.prepare(
  `INSERT INTO mangas (tanda_id, race_id, number, status, started_at, finished_at, actual_duration_ms)
   VALUES (?, ?, ?, 'finished', ?, ?, ?)`);
const insLane = db.prepare(
  `INSERT INTO manga_lanes (manga_id, lane, team_id, driver_id, is_rest, coma) VALUES (?, ?, ?, NULL, 0, ?)`);
const insLap = db.prepare(
  `INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms,
                     is_exit, is_ghost, is_pit_stop, is_warmup, timestamp)
   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);

let totalLaps = 0, totalWarmup = 0, totalExits = 0, totalPits = 0;
const run = db.transaction(() => {
  for (let r = 1; r <= N_ROTATIONS; r++) {
    const goTs = gosDS1[GO_INDEX_ROT1 + (r - 1)];
    const endTs = gosDS1[GO_INDEX_ROT1 + r] || (goTs + MANGA_MS + 10*60000);
    const startISO = new Date(goTs).toISOString();
    const finISO = new Date(goTs + MANGA_MS).toISOString();
    const { lastInsertRowid: mangaId } = insManga.run(tandaId, raceId, r, startISO, finISO, MANGA_MS);

    const winCross = crossingsInWindow(goTs, endTs);
    const byLane = {};
    winCross.forEach(c => { (byLane[c.lane] = byLane[c.lane] || []).push(c); });

    // Mapeo carril→equipo del parcial (rot 1-21) o de la "Situación 22/22" (rot 22)
    const rows = (r <= 21) ? modena.parciales[r - 1].rows : modena.rot22;
    const teamByLane = {};
    rows.forEach(row => { teamByLane[row.lane] = teamIdByName[row.name]; });

    rows.forEach(row => {
      const lane = row.lane;
      const teamId = teamByLane[lane];
      insLane.run(mangaId, lane, teamId, (row.coma || 0) / 1000);
      const laneCross = byLane[lane] || [];
      if (!laneCross.length) return;
      const laps = buildLaps(laneCross, goTs);
      laps.forEach(L => {
        insLap.run(raceId, mangaId, teamId, lane, L.lap_number, L.lap_time_ms, L.elapsed_ms,
                   L.is_exit, L.is_pit_stop, L.is_warmup, new Date(L.ts).toISOString());
        totalLaps++; if (L.is_warmup) totalWarmup++;
        if (L.is_exit) totalExits++; if (L.is_pit_stop) totalPits++;
      });
    });
  }
});
run();

Race.updateStatus(raceId, 'finished');
Tanda.updateStatus(tandaId, 'finished');
console.log(`Insertadas ${N_ROTATIONS} mangas y ${totalLaps} vueltas reales (${totalWarmup} out-laps, ${totalExits} salidas, ${totalPits} pit-stops).`);
console.log('Hecho.');
