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
 * Stress test para SlotTime.
 *
 * Mide:
 *   - Throughput y latencias (p50/p95/p99) en endpoints HTTP clave
 *   - Tasa de errores / no-2xx
 *   - Estabilidad de memoria del server bajo carga (RSS) si se ejecuta con
 *     STRESS_PID=<pid_del_servidor>
 *
 * Uso:
 *   node scripts/stress-test.js
 *   STRESS_BASE=http://localhost:3000 STRESS_DURATION_S=20 STRESS_CONC=40 node scripts/stress-test.js
 */

const http = require('http');
const { URL } = require('url');

const BASE        = process.env.STRESS_BASE        || 'http://localhost:3000';
const DURATION_S  = parseInt(process.env.STRESS_DURATION_S || '15', 10);
const CONCURRENCY = parseInt(process.env.STRESS_CONC       || '20', 10);
const PID         = process.env.STRESS_PID ? parseInt(process.env.STRESS_PID, 10) : null;

const RACE_ID  = process.env.STRESS_RACE_ID  || '18';
const MANGA_ID = process.env.STRESS_MANGA_ID || '251';

// Mezcla representativa de tráfico app móvil + spectadores web.
// Las apps móviles llamarían sobre todo a los endpoints JSON; los spectadores
// además cargan HTML+CSS+JS.
const ENDPOINTS = [
  // Estáticos (un spectador los pide 1 vez al abrir la página)
  { path: '/',                                              label: 'home',           weight: 1 },
  { path: '/css/live.css',                                  label: 'css/live',       weight: 2 },
  { path: '/js/live.js',                                    label: 'js/live',        weight: 2 },
  { path: '/css/style.css',                                 label: 'css/style',      weight: 1 },
  // HTML pesados (live, lemans, results, stats)
  { path: `/races/${RACE_ID}`,                              label: 'race/show',      weight: 2 },
  { path: `/races`,                                         label: 'races/list',     weight: 1 },
  // JSON dinámicos — los hits "calientes" en una carrera en vivo
  { path: `/races/${RACE_ID}/live-stats.json?mangaId=${MANGA_ID}`,  label: 'json/live-stats', weight: 10 },
  { path: '/api/settings/ports',                            label: 'api/ports',      weight: 1 },
];

// Pondera por peso: endpoints con weight más alto reciben más tráfico
const POOL = ENDPOINTS.flatMap(e => Array(e.weight).fill(e));

const stats = new Map();  // label → { count, errors, latencies[] }
function record(label, latencyMs, ok) {
  let s = stats.get(label);
  if (!s) { s = { count: 0, errors: 0, latencies: [] }; stats.set(label, s); }
  s.count++;
  if (!ok) s.errors++;
  s.latencies.push(latencyMs);
}

function fetchOnce(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(BASE + endpoint.path);
    const start = process.hrtime.bigint();
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + (url.search || ''), method: 'GET',
      headers: { 'User-Agent': 'pitwall-stress/1.0', 'Connection': 'keep-alive' },
    }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => {
        const dt = Number(process.hrtime.bigint() - start) / 1e6;
        record(endpoint.label, dt, res.statusCode >= 200 && res.statusCode < 400);
        resolve({ status: res.statusCode, bytes, dt });
      });
    });
    req.on('error', () => {
      const dt = Number(process.hrtime.bigint() - start) / 1e6;
      record(endpoint.label, dt, false);
      resolve({ status: 0, bytes: 0, dt });
    });
    req.setTimeout(15000, () => req.destroy());
    req.end();
  });
}

async function worker(stopAt) {
  while (Date.now() < stopAt) {
    const ep = POOL[Math.floor(Math.random() * POOL.length)];
    await fetchOnce(ep);
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function rp(s, n)  { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }

async function probeMemory() {
  if (!PID) return null;
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn('ps', ['-o', 'rss=', '-p', String(PID)]);
    let out = '';
    p.stdout.on('data', (b) => out += b.toString());
    p.on('close', () => resolve(parseInt(out.trim(), 10) || null));
    p.on('error', () => resolve(null));
  });
}

(async () => {
  console.log(`\n🧪 SlotTime stress test`);
  console.log(`   base:        ${BASE}`);
  console.log(`   duration:    ${DURATION_S}s`);
  console.log(`   concurrency: ${CONCURRENCY}`);
  console.log(`   pool:        ${ENDPOINTS.length} endpoints (ponderado)`);
  if (PID) console.log(`   tracking PID ${PID} para RSS`);

  // Sanity check: el server responde?
  try {
    const r = await fetchOnce({ path: '/', label: 'sanity' });
    if (r.status === 0) {
      console.error(`\n❌ El server no responde en ${BASE}. ¿Está arrancado?`);
      process.exit(1);
    }
    console.log(`\n✓ Sanity OK (HTTP ${r.status}, ${r.bytes} bytes, ${r.dt.toFixed(1)}ms)\n`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const rssBefore = await probeMemory();
  if (rssBefore != null) console.log(`📊 RSS antes: ${(rssBefore / 1024).toFixed(1)} MB\n`);

  const stopAt = Date.now() + DURATION_S * 1000;
  const t0 = Date.now();
  const workers = Array.from({ length: CONCURRENCY }, () => worker(stopAt));

  // Sondeo periódico de RSS durante la carga
  const rssSamples = [];
  const rssInt = setInterval(async () => {
    const r = await probeMemory();
    if (r != null) rssSamples.push(r);
  }, 1000);

  await Promise.all(workers);
  clearInterval(rssInt);
  const elapsed = (Date.now() - t0) / 1000;

  const rssAfter = await probeMemory();

  // ── Resultados ────────────────────────────────────────────────────────
  let totalReq = 0, totalErr = 0, allLatencies = [];
  console.log(`\n── Resultados ${'─'.repeat(58)}`);
  console.log(`${pad('endpoint', 22)} ${rp('req', 8)} ${rp('err', 6)} ${rp('p50', 8)} ${rp('p95', 8)} ${rp('p99', 8)} ${rp('max', 8)}`);
  console.log('─'.repeat(80));
  const ordered = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [label, s] of ordered) {
    const p50 = percentile(s.latencies, 50);
    const p95 = percentile(s.latencies, 95);
    const p99 = percentile(s.latencies, 99);
    let max = 0;
    for (const v of s.latencies) if (v > max) max = v;
    console.log(
      `${pad(label, 22)} ${rp(s.count, 8)} ${rp(s.errors, 6)} ${rp(p50.toFixed(1), 7)}ms ${rp(p95.toFixed(1), 7)}ms ${rp(p99.toFixed(1), 7)}ms ${rp(max.toFixed(1), 7)}ms`
    );
    totalReq += s.count;
    totalErr += s.errors;
    for (const v of s.latencies) allLatencies.push(v);
  }
  console.log('─'.repeat(80));
  const totP50 = percentile(allLatencies, 50);
  const totP95 = percentile(allLatencies, 95);
  const totP99 = percentile(allLatencies, 99);
  const rps = totalReq / elapsed;
  console.log(`${pad('TOTAL', 22)} ${rp(totalReq, 8)} ${rp(totalErr, 6)} ${rp(totP50.toFixed(1), 7)}ms ${rp(totP95.toFixed(1), 7)}ms ${rp(totP99.toFixed(1), 7)}ms`);
  console.log(`\n⚡ Throughput: ${rps.toFixed(1)} req/s   ⏱  Duración: ${elapsed.toFixed(1)}s`);
  const errPct = totalReq ? (totalErr / totalReq) * 100 : 0;
  console.log(`✅ Éxito: ${(100 - errPct).toFixed(2)}%   ❌ Errores: ${totalErr} (${errPct.toFixed(2)}%)`);

  if (rssBefore != null && rssAfter != null) {
    const dKB = rssAfter - rssBefore;
    const maxRss = Math.max(...rssSamples, rssAfter);
    console.log(`\n📊 Memoria server:`);
    console.log(`   RSS antes:    ${(rssBefore / 1024).toFixed(1)} MB`);
    console.log(`   RSS después:  ${(rssAfter  / 1024).toFixed(1)} MB`);
    console.log(`   RSS pico:     ${(maxRss    / 1024).toFixed(1)} MB`);
    console.log(`   Δ:            ${dKB >= 0 ? '+' : ''}${(dKB / 1024).toFixed(2)} MB`);
  }

  // ── Verdicto ──────────────────────────────────────────────────────────
  console.log('\n── Verdicto ' + '─'.repeat(67));
  const issues = [];
  if (errPct > 1) issues.push(`Tasa de error alta: ${errPct.toFixed(2)}%`);
  if (totP95 > 500) issues.push(`p95 alta: ${totP95.toFixed(1)}ms`);
  if (totP99 > 2000) issues.push(`p99 muy alta: ${totP99.toFixed(1)}ms`);
  if (rssAfter && rssBefore && (rssAfter - rssBefore) / 1024 > 80) {
    issues.push(`Posible leak: +${((rssAfter - rssBefore) / 1024).toFixed(1)}MB RSS`);
  }
  if (rps < 50) issues.push(`Throughput bajo: ${rps.toFixed(1)} req/s`);

  if (issues.length === 0) {
    console.log('✅ Todo OK: el server soporta bien la carga aplicada.\n');
    process.exit(0);
  } else {
    issues.forEach(i => console.log(`⚠️  ${i}`));
    console.log('');
    process.exit(2);
  }
})();
