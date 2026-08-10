#!/usr/bin/env node
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
'use strict';

/*
 * Simulación de carga: carrera de 32 carriles, 30 min, vuelta media 12s.
 *
 * Genera 4800 vueltas (32 lanes × 150 vueltas/manga) directamente en BD
 * para medir capacidad. Mide:
 *   - Tiempo total y throughput (laps/s)
 *   - Latencia por insert (p50/p95/p99)
 *   - Crecimiento de memoria del server (si STRESS_PID está definido)
 *   - Stress de las queries de standings/aggregate después
 */

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const DB_PATH = path.join(__dirname, '..', 'database', 'pitwall.db');
const PID     = process.env.STRESS_PID ? parseInt(process.env.STRESS_PID, 10) : null;

const N_LANES   = 32;
const MANGA_MIN = 30;
const AVG_LAP_MS = 12000;
const N_LAPS_PER_LANE = Math.floor((MANGA_MIN * 60 * 1000) / AVG_LAP_MS); // ~150
const N_TOTAL   = N_LANES * N_LAPS_PER_LANE;

function rssMB(pid) {
  if (!pid) return null;
  try {
    const out = require('child_process').execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString();
    return parseInt(out.trim(), 10) / 1024;
  } catch { return null; }
}

const db = new Database(DB_PATH, { readonly: false });

console.log('\n🏎  Simulación 32 carriles × 30 min @ 12s avg');
console.log(`   ${N_TOTAL} vueltas totales (${N_LAPS_PER_LANE} por carril)\n`);

const rssBefore = rssMB(PID);
if (rssBefore != null) console.log(`📊 RSS server antes: ${rssBefore.toFixed(1)} MB`);

// ── Crear carrera + tanda + manga sintéticas ────────────────────────────
const tx = db.transaction(() => {
  // Limpieza previa de cualquier test anterior
  db.prepare(`DELETE FROM laps   WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_TEST_32L__')`).run();
  db.prepare(`DELETE FROM mangas WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_TEST_32L__')`).run();
  db.prepare(`DELETE FROM tandas WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_TEST_32L__')`).run();
  db.prepare(`DELETE FROM races  WHERE name = '__STRESS_TEST_32L__'`).run();
});
tx();

const raceCols = db.prepare("PRAGMA table_info(races)").all().map(c => c.name);
const required = { name: '__STRESS_TEST_32L__', type: 'club', format: 'individual', lanes_count: N_LANES, manga_duration_minutes: MANGA_MIN, status: 'active' };
const cols = Object.keys(required).filter(k => raceCols.includes(k));
const placeholders = cols.map(() => '?').join(',');
const raceId = db.prepare(
  `INSERT INTO races (${cols.join(',')}) VALUES (${placeholders})`
).run(...cols.map(k => required[k])).lastInsertRowid;
console.log(`   raceId=${raceId}`);

const tandaId = db.prepare(`INSERT INTO tandas (race_id, number) VALUES (?, 1)`).run(raceId).lastInsertRowid;
const mangaId = db.prepare(`INSERT INTO mangas (race_id, tanda_id, number, status) VALUES (?, ?, 1, 'active')`).run(raceId, tandaId).lastInsertRowid;
console.log(`   tandaId=${tandaId}  mangaId=${mangaId}`);

// 32 manga_lanes — sin team_id/driver_id por simplicidad
const mlStmt = db.prepare(`INSERT INTO manga_lanes (manga_id, lane, is_rest) VALUES (?, ?, 0)`);
for (let lane = 1; lane <= N_LANES; lane++) mlStmt.run(mangaId, lane);

// ── Insertar 4800 vueltas, midiendo tiempo por insert ────────────────────
const lapStmt = db.prepare(`
  INSERT INTO laps (race_id, manga_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, is_pit_stop)
  VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)
`);

const latencies = [];
const t0 = Date.now();

const txLaps = db.transaction((laps) => {
  for (const l of laps) {
    const tStart = process.hrtime.bigint();
    lapStmt.run(l.race_id, l.manga_id, l.lane, l.lap_number, l.lap_time_ms, l.elapsed_ms);
    latencies.push(Number(process.hrtime.bigint() - tStart) / 1e6);
  }
});

// Generamos en chunks de 100 con pequeño jitter en lap_time (±15%)
const laps = [];
for (let lap = 1; lap <= N_LAPS_PER_LANE; lap++) {
  for (let lane = 1; lane <= N_LANES; lane++) {
    const jitter = 1 + (Math.random() * 0.3 - 0.15);
    const lapTime = Math.round(AVG_LAP_MS * jitter);
    laps.push({ race_id: raceId, manga_id: mangaId, lane, lap_number: lap, lap_time_ms: lapTime, elapsed_ms: lapTime * lap });
  }
}
console.log(`\n🔥 Insertando ${N_TOTAL} vueltas...`);
const CHUNK = 200;
for (let i = 0; i < laps.length; i += CHUNK) txLaps(laps.slice(i, i + CHUNK));
const totalMs = Date.now() - t0;

// ── Latencias ────────────────────────────────────────────────────────────
const sorted = [...latencies].sort((a, b) => a - b);
const p = (x) => sorted[Math.min(sorted.length - 1, Math.floor((x / 100) * sorted.length))];

console.log(`\n📈 Inserts:`);
console.log(`   Total:       ${totalMs}ms para ${N_TOTAL} vueltas`);
console.log(`   Throughput:  ${(N_TOTAL / (totalMs / 1000)).toFixed(0)} laps/s`);
console.log(`   p50 / p95:   ${p(50).toFixed(3)}ms / ${p(95).toFixed(3)}ms`);
console.log(`   p99 / max:   ${p(99).toFixed(3)}ms / ${Math.max(...latencies).toFixed(3)}ms`);

// ── Stress de queries que la UI ejecuta en cada lap ─────────────────────
console.log(`\n🔍 Queries típicas de la UI sobre el dataset insertado:`);
function timeIt(label, fn, iter = 50) {
  const ts = [];
  for (let i = 0; i < iter; i++) {
    const t = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ts.sort((a, b) => a - b);
  console.log(`   ${label.padEnd(38)} p50=${ts[iter/2|0].toFixed(2)}ms  p95=${ts[Math.floor(iter*.95)].toFixed(2)}ms`);
}

const Lap          = require(path.join(__dirname, '..', 'src', 'models', 'Lap'));
timeIt('Lap.findByManga(mangaId)',         () => Lap.findByManga(mangaId));
timeIt('Lap.aggregateByRace(raceId)',      () => Lap.aggregateByRace(raceId));
timeIt('Lap.raceBestByLane(raceId)',       () => Lap.raceBestByLane(raceId));

// ── RSS server final ─────────────────────────────────────────────────────
const rssAfter = rssMB(PID);
if (rssBefore != null && rssAfter != null) {
  console.log(`\n📊 Memoria server:`);
  console.log(`   RSS antes:  ${rssBefore.toFixed(1)} MB`);
  console.log(`   RSS final:  ${rssAfter.toFixed(1)} MB   Δ ${(rssAfter - rssBefore >= 0 ? '+' : '')}${(rssAfter - rssBefore).toFixed(1)} MB`);
}

// ── Limpieza ─────────────────────────────────────────────────────────────
const cleanup = db.transaction(() => {
  db.prepare(`DELETE FROM laps         WHERE race_id = ?`).run(raceId);
  db.prepare(`DELETE FROM manga_lanes  WHERE manga_id = ?`).run(mangaId);
  db.prepare(`DELETE FROM mangas       WHERE race_id = ?`).run(raceId);
  db.prepare(`DELETE FROM tandas       WHERE race_id = ?`).run(raceId);
  db.prepare(`DELETE FROM races        WHERE id = ?`).run(raceId);
});
cleanup();

console.log('\n✅ Test datos limpiados de BD.\n');
db.close();
