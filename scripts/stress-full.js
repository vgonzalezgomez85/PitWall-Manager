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
 * Stress integral SlotTime — escenario realista:
 *   • 4 "DS-300" simulados (4 circuitos × 8 carriles = 32 total)
 *   • Vueltas inyectadas a ritmo real (12s media por vuelta, jitter ±15%)
 *   • 200 clientes HTTP concurrentes pidiendo endpoints (web + app móvil)
 *
 * Duración configurable. Mide latencias, throughput, errores y RSS del
 * proceso del server. Se autodestruye los datos al final.
 *
 * Uso:
 *   STRESS_PID=<pid> node scripts/stress-full.js
 *   STRESS_DURATION_S=60 STRESS_CONC=200 STRESS_PID=<pid> node scripts/stress-full.js
 */

const http        = require('http');
const { URL }     = require('url');
const path        = require('path');
const { spawn }   = require('child_process');
const Database    = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const BASE        = process.env.STRESS_BASE        || 'http://localhost:3000';
const DURATION_S  = parseInt(process.env.STRESS_DURATION_S || '60', 10);
const CONCURRENCY = parseInt(process.env.STRESS_CONC       || '200', 10);
const PID         = process.env.STRESS_PID ? parseInt(process.env.STRESS_PID, 10) : null;
const DB_PATH     = path.join(__dirname, '..', 'database', 'pitwall.db');

// 4 circuitos × 8 carriles
const N_CIRCUITS = 4;
const LANES_PER  = 8;
const N_LANES    = N_CIRCUITS * LANES_PER;     // 32
const N_TEAMS    = 40;                         // 40 equipos (8 descansando cada manga)
const AVG_LAP_MS = 12000;
const JITTER     = 0.15;

const db = new Database(DB_PATH);

function rssMB(pid) {
  if (!pid) return null;
  try {
    const out = require('child_process').execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString();
    return parseInt(out.trim(), 10) / 1024;
  } catch { return null; }
}

// ── Crear race + manga sintéticas (32 lanes + 40 teams = 8 descansando) ─
function setupTestRace() {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM laps         WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_FULL__')`).run();
    db.prepare(`DELETE FROM manga_lanes  WHERE manga_id IN (SELECT id FROM mangas WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_FULL__'))`).run();
    db.prepare(`DELETE FROM mangas       WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_FULL__')`).run();
    db.prepare(`DELETE FROM tandas       WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_FULL__')`).run();
    db.prepare(`DELETE FROM teams        WHERE race_id IN (SELECT id FROM races WHERE name = '__STRESS_FULL__')`).run();
    db.prepare(`DELETE FROM races        WHERE name = '__STRESS_FULL__'`).run();
  });
  tx();

  const raceId = db.prepare(
    `INSERT INTO races (name, type, format, lanes_count, manga_duration_minutes, status) VALUES (?, 'club', 'team', ?, 30, 'active')`
  ).run('__STRESS_FULL__', N_LANES).lastInsertRowid;
  const tandaId = db.prepare(`INSERT INTO tandas (race_id, number) VALUES (?, 1)`).run(raceId).lastInsertRowid;
  const mangaId = db.prepare(`INSERT INTO mangas (race_id, tanda_id, number, status) VALUES (?, ?, 1, 'active')`).run(raceId, tandaId).lastInsertRowid;

  // 40 equipos para esta carrera
  const teamCols  = db.prepare(`PRAGMA table_info(teams)`).all().map(c => c.name);
  const hasColor  = teamCols.includes('color');
  const insTeam = hasColor
    ? db.prepare(`INSERT INTO teams (race_id, name, color) VALUES (?, ?, ?)`)
    : db.prepare(`INSERT INTO teams (race_id, name) VALUES (?, ?)`);
  const teamIds = [];
  const palette = ['#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4','#ff5722','#607d8b'];
  for (let i = 1; i <= N_TEAMS; i++) {
    const id = hasColor
      ? insTeam.run(raceId, `Team ${i}`, palette[i % palette.length]).lastInsertRowid
      : insTeam.run(raceId, `Team ${i}`).lastInsertRowid;
    teamIds.push(id);
  }

  // 32 carriles activos + (40 - 32) = 8 plazas de descanso
  const mlReal = db.prepare(`INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, ?, ?, 0)`);
  const mlRest = db.prepare(`INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, 0,  ?, 1)`);
  for (let l = 1; l <= N_LANES; l++) mlReal.run(mangaId, l, teamIds[l - 1]);
  for (let i = N_LANES; i < N_TEAMS; i++) mlRest.run(mangaId, teamIds[i]);

  return { raceId, tandaId, mangaId, teamIds };
}

function cleanupTestRace(raceId, mangaId) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM laps         WHERE race_id = ?`).run(raceId);
    db.prepare(`DELETE FROM manga_lanes  WHERE manga_id = ?`).run(mangaId);
    db.prepare(`DELETE FROM mangas       WHERE race_id = ?`).run(raceId);
    db.prepare(`DELETE FROM tandas       WHERE race_id = ?`).run(raceId);
    db.prepare(`DELETE FROM teams        WHERE race_id = ?`).run(raceId);
    db.prepare(`DELETE FROM races        WHERE id = ?`).run(raceId);
  });
  tx();
}

// ── Stress HTTP ────────────────────────────────────────────────────────
const stats = new Map();
function record(label, latencyMs, ok) {
  let s = stats.get(label);
  if (!s) { s = { count: 0, errors: 0, latencies: [] }; stats.set(label, s); }
  s.count++; if (!ok) s.errors++; s.latencies.push(latencyMs);
}

function fetchOnce(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(BASE + endpoint.path);
    const start = process.hrtime.bigint();
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: { 'User-Agent': 'slotime-stress-full/1.0', 'Connection': 'keep-alive' },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const dt = Number(process.hrtime.bigint() - start) / 1e6;
        record(endpoint.label, dt, res.statusCode >= 200 && res.statusCode < 400);
        resolve();
      });
    });
    req.on('error', () => {
      const dt = Number(process.hrtime.bigint() - start) / 1e6;
      record(endpoint.label, dt, false);
      resolve();
    });
    req.setTimeout(15000, () => req.destroy());
    req.end();
  });
}

async function httpWorker(stopAt, endpoints) {
  while (Date.now() < stopAt) {
    const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
    await fetchOnce(ep);
  }
}

// ── Inyector de vueltas (simula 4 DS-300) ──────────────────────────────
function startLapInjector(raceId, mangaId, stopAt, teamIds) {
  const ins = db.prepare(
    `INSERT INTO laps (race_id, manga_id, lane, team_id, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, is_pit_stop) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`
  );
  const laneTeam = {};
  for (let l = 1; l <= N_LANES; l++) laneTeam[l] = teamIds[l - 1];   // mismo orden
  const laneState = {};
  for (let l = 1; l <= N_LANES; l++) laneState[l] = { count: 0, elapsed: 0 };

  // Cada carril vuelve a cruzar cada ~AVG_LAP_MS (con jitter). Programamos un
  // setTimeout por carril que se reagenda al terminar cada vuelta.
  const timers = [];
  const counts = { laps: 0 };
  function scheduleLap(lane) {
    if (Date.now() >= stopAt) return;
    const t = Math.round(AVG_LAP_MS * (1 + (Math.random() * 2 - 1) * JITTER));
    const tm = setTimeout(() => {
      const s = laneState[lane];
      s.count++;
      s.elapsed += t;
      try { ins.run(raceId, mangaId, lane, laneTeam[lane], s.count, t, s.elapsed); } catch {}
      counts.laps++;
      scheduleLap(lane);
    }, t);
    timers.push(tm);
  }
  for (let l = 1; l <= N_LANES; l++) scheduleLap(l);

  return { counts, cancel: () => timers.forEach(t => clearTimeout(t)) };
}

// ── Endpoints a martillar (mix web + móvil) ────────────────────────────
function buildEndpoints(raceId, mangaId) {
  return [
    // Spectadores web (HTML+CSS+JS)
    { path: '/',                                                       label: 'home',           weight: 1 },
    { path: '/css/live.css',                                           label: 'css/live',       weight: 2 },
    { path: '/js/live.js',                                             label: 'js/live',        weight: 2 },
    { path: `/races/${raceId}`,                                        label: 'race/show',      weight: 2 },
    // Móviles (JSON) — endpoints calientes
    { path: `/races/${raceId}/live-stats.json?mangaId=${mangaId}`,    label: 'json/live-stats', weight: 10 },
    { path: '/api/settings/ports',                                     label: 'api/ports',      weight: 1 },
  ];
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🏁 SlotTime stress test integral`);
  console.log(`   Circuitos:   ${N_CIRCUITS} × ${LANES_PER} carriles  =  ${N_LANES} corriendo`);
  console.log(`   Equipos:     ${N_TEAMS} (${N_TEAMS - N_LANES} descansando por manga)`);
  console.log(`   Pace:        ~${AVG_LAP_MS/1000}s media/vuelta (jitter ±${JITTER*100}%)`);
  console.log(`   HTTP:        ${CONCURRENCY} clientes concurrentes`);
  console.log(`   Duración:    ${DURATION_S}s\n`);

  const { raceId, mangaId, teamIds } = setupTestRace();
  console.log(`   race=${raceId} manga=${mangaId} (${teamIds.length} equipos, ${N_LANES} corren, ${N_TEAMS - N_LANES} descansan)\n`);

  // Sanity
  await fetchOnce({ path: '/', label: 'sanity' });
  if ((stats.get('sanity')?.errors || 0) > 0) {
    console.error('❌ Server no responde');
    cleanupTestRace(raceId, mangaId);
    process.exit(1);
  }
  stats.delete('sanity');

  const rssBefore = rssMB(PID);
  if (rssBefore != null) console.log(`📊 RSS antes: ${rssBefore.toFixed(1)} MB\n`);

  const stopAt = Date.now() + DURATION_S * 1000;
  const endpoints = buildEndpoints(raceId, mangaId);

  // RSS sampling
  const rssSamples = [];
  const rssInt = setInterval(() => {
    const r = rssMB(PID);
    if (r != null) rssSamples.push(r);
  }, 1000);

  console.log(`🔥 Inyectando vueltas + ${CONCURRENCY} clientes HTTP...\n`);

  // Inyector de vueltas (4 DS-300 simulados)
  const injector = startLapInjector(raceId, mangaId, stopAt, teamIds);

  // Workers HTTP
  const t0 = Date.now();
  const workers = Array.from({ length: CONCURRENCY }, () => httpWorker(stopAt, endpoints));
  await Promise.all(workers);
  const elapsed = (Date.now() - t0) / 1000;

  injector.cancel();
  clearInterval(rssInt);

  // ── Resultados ───────────────────────────────────────────────────────
  const rssAfter = rssMB(PID);
  let totalReq = 0, totalErr = 0;
  const allLatencies = [];

  const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
  const rp  = (s, n) => { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; };
  const pct = (arr, p) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };

  console.log(`── HTTP ${'─'.repeat(70)}`);
  console.log(`${pad('endpoint', 22)} ${rp('req', 8)} ${rp('err', 6)} ${rp('p50', 8)} ${rp('p95', 8)} ${rp('p99', 8)} ${rp('max', 8)}`);
  console.log('─'.repeat(78));
  const ordered = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [label, s] of ordered) {
    let max = 0; for (const v of s.latencies) if (v > max) max = v;
    console.log(`${pad(label, 22)} ${rp(s.count, 8)} ${rp(s.errors, 6)} ${rp(pct(s.latencies, 50).toFixed(1), 7)}ms ${rp(pct(s.latencies, 95).toFixed(1), 7)}ms ${rp(pct(s.latencies, 99).toFixed(1), 7)}ms ${rp(max.toFixed(1), 7)}ms`);
    totalReq += s.count; totalErr += s.errors;
    for (const v of s.latencies) allLatencies.push(v);
  }
  console.log('─'.repeat(78));
  console.log(`${pad('TOTAL', 22)} ${rp(totalReq, 8)} ${rp(totalErr, 6)} ${rp(pct(allLatencies, 50).toFixed(1), 7)}ms ${rp(pct(allLatencies, 95).toFixed(1), 7)}ms ${rp(pct(allLatencies, 99).toFixed(1), 7)}ms`);
  console.log(`\n⚡ HTTP throughput: ${(totalReq / elapsed).toFixed(1)} req/s`);
  console.log(`✅ Éxito: ${totalReq ? ((100 * (totalReq - totalErr) / totalReq)).toFixed(2) : 0}%   ❌ Errores: ${totalErr}`);

  // ── Vueltas inyectadas ──────────────────────────────────────────────
  const lapsRow = db.prepare(`SELECT COUNT(*) c FROM laps WHERE race_id = ?`).get(raceId);
  console.log(`\n🏎 Vueltas registradas: ${lapsRow.c} (${(lapsRow.c / elapsed).toFixed(2)} laps/s)`);
  // Esperado: 32 lanes × (elapsed / 12) ≈ 32 × elapsed / 12
  const expected = Math.round((N_LANES * elapsed) / (AVG_LAP_MS / 1000));
  console.log(`   Esperado:  ~${expected} (32 carriles × ${elapsed.toFixed(0)}s / ${AVG_LAP_MS/1000}s)`);

  // ── Memoria ─────────────────────────────────────────────────────────
  if (rssBefore != null && rssAfter != null) {
    let rssMax = rssAfter; for (const v of rssSamples) if (v > rssMax) rssMax = v;
    console.log(`\n📊 Memoria server:`);
    console.log(`   RSS antes:  ${rssBefore.toFixed(1)} MB`);
    console.log(`   RSS final:  ${rssAfter.toFixed(1)} MB`);
    console.log(`   RSS pico:   ${rssMax.toFixed(1)} MB`);
    console.log(`   Δ:          ${rssAfter - rssBefore >= 0 ? '+' : ''}${(rssAfter - rssBefore).toFixed(1)} MB`);
  }

  // ── Verdicto ────────────────────────────────────────────────────────
  console.log('\n── Verdicto ' + '─'.repeat(68));
  const issues = [];
  const errPct = totalReq ? (totalErr / totalReq) * 100 : 0;
  const p95 = pct(allLatencies, 95);
  const p99 = pct(allLatencies, 99);
  if (errPct > 1)    issues.push(`Tasa de error alta: ${errPct.toFixed(2)}%`);
  if (p95 > 500)     issues.push(`p95 alta: ${p95.toFixed(1)}ms`);
  if (p99 > 2000)    issues.push(`p99 muy alta: ${p99.toFixed(1)}ms`);
  if (rssBefore != null && rssAfter != null && (rssAfter - rssBefore) > 200) {
    issues.push(`Posible leak: +${(rssAfter - rssBefore).toFixed(1)}MB RSS`);
  }
  if (issues.length === 0) {
    console.log('✅ El server soporta el escenario: 4 circuitos × 8 carriles + 200 móviles.\n');
  } else {
    issues.forEach(i => console.log(`⚠️  ${i}`));
    console.log('');
  }

  cleanupTestRace(raceId, mangaId);
  db.close();
  process.exit(issues.length === 0 ? 0 : 2);
})();
