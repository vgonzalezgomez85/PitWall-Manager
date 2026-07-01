// Simula EN VIVO la 24h (Italia) reproduciendo las tramas DS-300 sobre los
// puertos serie que lee el server, armando cada manga por HTTP. El server lo
// procesa como un DS-300 real (GO, cruces, fantasmas, fin de manga).
//
//   node scripts/replay-italia.js [velocidad]
//   SPEED=60 node scripts/replay-italia.js          → ×60  (~22 min)
//   node scripts/replay-italia.js 300               → ×300 (~4-5 min)
//   node scripts/replay-italia.js 1                 → tiempo real (~22 h)
//   ROT=3 node scripts/replay-italia.js 600         → solo rotación 3 (prueba)
//
// Requisitos: socat + server corriendo, en modo serie con los 3 puertos. Este
// script REEMPLAZA a los emuladores (los para al arrancar).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { SerialPort } = require('serialport');
const db = require('../src/config/database');
const Race = require('../src/models/Race');
const Tanda = require('../src/models/Tanda');
const Team = require('../src/models/Team');
const Manga = require('../src/models/Manga');

const SPEED = parseFloat(process.env.SPEED || process.argv[2] || '60');
const ONLY_ROT = process.env.ROT ? parseInt(process.env.ROT, 10) : null; // 1-based, opcional
const BASE = path.join(__dirname, '../info para proyecto infolap slot');
const TRAMAS = path.join(BASE, 'tramas_Italia_24h.txt');
const CSV = path.join(BASE, 'Pilotos_Italia.csv');
const RACE_NAME = 'Italia 24h';
const MANGA_MIN = 57, MIN_LAP_MS = 8500, LANES = 22, CIRCUITS = [8, 8, 6];
const SERVER = process.env.SERVER || 'http://localhost:3000';
const PORTS = { DS1: process.env.DS1 || '/dev/ttys000', DS2: process.env.DS2 || '/dev/ttys003', DS3: process.env.DS3 || '/dev/ttys005' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Equipos (CSV: orden = carril de salida) ──────────────────────────────────
const teamNames = fs.readFileSync(CSV, 'utf8').replace(/\r/g, '').split('\n')
  .map(l => l.split(',')[0].trim()).filter(Boolean);
console.log(`Equipos: ${teamNames.length}`);

// ── Parseo de tramas (ts relativo en ms, DS, 21 bytes) + GOs (DS1) ───────────
const lines = fs.readFileSync(TRAMAS, 'utf8').replace(/^﻿/, '').replace(/\r/g, '').split('\n');
let day = 0, prevSecs = null;
const frames = [], gos = [];
for (const ln of lines) {
  const m = ln.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(DS[123])\s+(.+)$/);
  if (!m) continue;
  const hex = m[3].trim().split(/\s+/);
  if (hex.length < 21) continue;
  const buf = Buffer.from(hex.map(h => parseInt(h, 16)));
  const [hh, mm, rest] = m[1].split(':'); const [ss, mmm] = rest.split('.');
  const secs = (+hh) * 3600 + (+mm) * 60 + (+ss);
  if (prevSecs != null && secs < prevSecs - 1) day++;
  prevSecs = secs;
  const ts = day * 86400000 + secs * 1000 + (+mmm);
  frames.push({ ts, ds: m[2], buf });
  if (buf[7] === 0x3e && buf[8] === 0xa1 && m[2] === 'DS1') gos.push(ts);
}
console.log(`Tramas: ${frames.length}, rotaciones (GO): ${gos.length}`);

// ── Crear la carrera lista para correr (idempotente) ─────────────────────────
function createRace() {
  const ex = db.prepare('SELECT id FROM races WHERE name=?').all(RACE_NAME);
  db.transaction(() => {
    for (const { id } of ex) {
      db.prepare('DELETE FROM laps WHERE race_id=?').run(id);
      db.prepare('DELETE FROM manga_lanes WHERE manga_id IN (SELECT id FROM mangas WHERE race_id=?)').run(id);
      db.prepare('DELETE FROM mangas WHERE race_id=?').run(id);
      db.prepare('DELETE FROM teams WHERE race_id=?').run(id);
      db.prepare('DELETE FROM tandas WHERE race_id=?').run(id);
      db.prepare('DELETE FROM races WHERE id=?').run(id);
    }
  })();
  const laneSeq = Array.from({ length: LANES }, (_, i) => i + 1); // 1..22
  const raceId = Race.create({
    name: RACE_NAME, type: 'club', format: 'team', lanes_count: LANES,
    lane_sequence: laneSeq, manga_duration_minutes: MANGA_MIN, circuits: CIRCUITS, has_pole: 0, min_lap_ms: MIN_LAP_MS,
  });
  const tandaId = Tanda.create(raceId);
  const COLORS = Array.from({ length: LANES }, (_, i) => `hsl(${Math.round(i * 360 / LANES)},70%,50%)`);
  const entities = teamNames.map((name, i) => ({
    id: Team.create({ race_id: raceId, tanda_id: tandaId, name, lane: 0, color: COLORS[i] }),
    type: 'team', name,
  }));
  const schedule = Manga.buildSchedule(laneSeq, entities);
  const mangaIds = Manga.persistSchedule(tandaId, raceId, schedule);
  // Asegurar pending (por si el default no lo es).
  db.prepare("UPDATE mangas SET status='pending' WHERE race_id=?").run(raceId);
  Race.updateStatus(raceId, 'active');
  console.log(`Carrera #${raceId} "${RACE_NAME}" creada: ${entities.length} equipos, ${mangaIds.length} mangas.`);
  return { raceId, mangaIds };
}

async function armManga(raceId, mangaId) {
  try {
    const res = await fetch(`${SERVER}/races/${raceId}/mangas/${mangaId}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual',
    });
    return res.status; // 302 = armada OK
  } catch (e) { return 'ERR ' + e.message; }
}

async function main() {
  // Parar los emuladores sintéticos para liberar los puertos del lado emulador.
  try { execSync('pkill -f "ds300-emulator|emulator.js"'); } catch {}
  await sleep(800);

  const { raceId, mangaIds } = createRace();

  const ports = {};
  for (const ds of ['DS1', 'DS2', 'DS3']) {
    ports[ds] = new SerialPort({ path: PORTS[ds], baudRate: 57600, autoOpen: false });
    await new Promise((res, rej) => ports[ds].open(e => e ? rej(e) : res()));
  }
  console.log(`Puertos abiertos (${PORTS.DS1}, ${PORTS.DS2}, ${PORTS.DS3}). Velocidad ×${SPEED}.`);

  const writeF = f => new Promise(r => ports[f.ds].write(f.buf, () => r()));

  for (let r = 0; r < gos.length; r++) {
    if (ONLY_ROT && (r + 1) !== ONLY_ROT) continue;
    const t0 = gos[r], t1 = gos[r + 1] || (t0 + (MANGA_MIN + 10) * 60000);
    const win = frames.filter(f => f.ts >= t0 && f.ts < t1);
    const mangaId = mangaIds[r];
    if (!mangaId) break;
    const st = await armManga(raceId, mangaId);
    console.log(`\n── Rotación ${r + 1}/${gos.length}: manga ${mangaId} armada (${st}), ${win.length} tramas`);
    await sleep(400);
    let prev = win.length ? win[0].ts : t0, n = 0;
    for (const f of win) {
      const dt = (f.ts - prev) / SPEED; prev = f.ts;
      if (dt >= 1) await sleep(dt);
      await writeF(f);
      if (++n % 500 === 0) process.stdout.write(`  ${n}/${win.length}\r`);
    }
    await sleep(800); // dejar procesar el frame de fin (A4)
    console.log(`  rotación ${r + 1} reproducida (${win.length} tramas).`);
  }

  console.log('\nReplay completado.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
