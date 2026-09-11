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
// Alta de la carrera real "Llinars 24h simulada" con el VUELTA A VUELTA REAL
// extraído de las tramas DS-300 del ensayo del formato de las 24h de Llinars,
// capturado el 22-ago-2026 (info para proyecto infolap slot/llinars/tramas_22_agosto.txt).
//
// Mismo enfoque que seed-modena-real.js, adaptado a este fichero:
//   · El fichero trae 4 marcadores "### Inicio de Carrera ###": el de la línea 1
//     (justo antes del primer GO real, manga 1) y otros 3 pegados al GO de la
//     manga 2 (uno por caja). NO son arranques de calibración — contrastado con
//     "RegistroSucesos SOLO CARRERA.txt" (log real de TICTAC): hay exactamente
//     48 "Inicio Parcial N/48" y las tramas traen 48 clusters de GO que casan
//     con esos timestamps a 2-3s. Saltarse la manga 1 (como hacía una versión
//     anterior de este script) desfasaba en una manga el reparto carril↔equipo
//     calculado por Manga.buildSchedule para el resto de la carrera, mezclando
//     vueltas entre equipos — DZERO/SLOTMANIA acababan en posiciones que no
//     casaban con la clasificación real. Se parsea el fichero ENTERO.
//   · GO = b[7]=0x3E,b[8]=0xA1 (duración BCD en b[10] = 0x25 = 25 min, igual
//     que "24H LLINARS DEL VALLES" id 43 en producción). Las 3 cajas (DS1/DS2/
//     DS3) emiten su propio GO en una ventana de ~1s; se agrupan en un único
//     evento de manga usando el ts MÍNIMO del trío (si no, los cruces de la
//     caja más rápida en avisar caen justo antes del corte y se pierden —
//     mismo problema descrito para el reproductor en vivo).
//   · Fin de manga = b[7]=0x00,b[8]=0xA4 (mismo agrupamiento por trío).
//   · Pausa/reanudación (b[8]=0xA5/0xA6) NO cierran manga: no generan GO/A4
//     nuevos, así que las ventanas GO→GO ya las cubren solas.
//   · Cruce de vuelta = b[7]=0x1B; carril = bitmask de b[10] + offset de caja
//     (DS1:0, DS2:8, DS3:16); tiempo = BCD de b[14..17] (min:seg:centésima:
//     décima-de-centésima). El PRIMER cruce de cada carril en cada manga trae
//     el BCD en blanco (0xAA de relleno): es el registro de salida (out-lap),
//     su duración se calcula como ts − inicio_de_manga, igual que Modena.
//   · Reparto equipo↔carril por manga: Manga.buildSchedule (mismo código que
//     usa la app en producción) con lane_sequence/passes/lane_repeat de la
//     carrera real id 43 (24H LLINARS DEL VALLES). Las tramas NO llevan
//     identidad de equipo, así que la manga 1 se ancla al orden que dio el
//     usuario (carril 1→24) construyendo el array de entidades como la
//     permutación inversa de lane_sequence — comprobado a mano coincide con el
//     reparto real.
//
// Uso: node scripts/seed-llinars-24h-simulada.js

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const Race = require('../src/models/Race');
const Tanda = require('../src/models/Tanda');
const Manga = require('../src/models/Manga');
const Team = require('../src/models/Team');
const Lap = require('../src/models/Lap');
const { normalize } = require('../src/utils/csv');

const RACE_NAME = 'Llinars 24h simulada';
const TRAMAS_PATH = path.join(__dirname, '../info para proyecto infolap slot/llinars/tramas_22_agosto.txt');

// ── Parámetros de la carrera real id 43 "24H LLINARS DEL VALLES" ────────────
const LANES = 24;
const CIRCUITS = [8, 8, 8];
const LANE_SEQUENCE = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
const PASSES = 1;
const LANE_REPEAT = 2;
const MIN_LAP_MS = 11500;          // igual que id 43 (mismo circuito físico)
const EXIT_MARGIN_MS = 1700;       // igual que TimingService/seed-modena-real
const PIT_STOP_MULTIPLIER = 2;

// Orden de equipos en la manga 1 (carril 1→24), tal cual salió en pantalla.
const TEAM_NAMES = [
  'CMBSC PIRATES', 'FLBT', 'TUSCANY FACTORY', 'ESQUADRÓ DIABÒLIC', 'KMOS',
  'AEO RODAMON', 'GASCLAVAT 2', 'ATENEU SLOT', 'PEG 1', 'BATUA CMBSC',
  'GPSLOT RACING', 'SCX LLINARS', 'RAL 2009', 'MARTINI RACING', 'SLOT LLINARS',
  'GASCLAVAT', 'CATANIA SLOT', 'EL SOT FUM', 'EL SOT TEAM', 'PADAWANS',
  'SLOTMANIA PALMARES', 'DZERO', 'SLOTSAB DINAMICS', 'SLOT-CAR',
];

const LANE_COLORS = Array.from({ length: LANES }, (_, i) => `hsl(${Math.round(i * 360 / LANES)}, 70%, 50%)`);

// ── Decodificación DS-300 (dsFrames.js + protocolo conocido) ────────────────
const OFFSET = { DS1: 0, DS2: 8, DS3: 16 };
const LANE_MAP = { 0x80: 1, 0x40: 2, 0x20: 3, 0x10: 4, 0x08: 5, 0x04: 6, 0x02: 7, 0x01: 8 };
const dsv = b => (((b >> 4) <= 9 && (b & 0xF) <= 9) ? parseInt(b.toString(16), 10) : null);
const lapMs = f => {
  const m = dsv(f[14]), s = dsv(f[15]), c = dsv(f[16]), d = dsv(f[17]);
  return [m, s, c, d].some(x => x === null) ? null : m * 60000 + s * 1000 + c * 10 + d * 0.1;
};

// ── Parseo del fichero completo ──────────────────────────────────────────────
const rawLines = fs.readFileSync(TRAMAS_PATH, 'utf8').replace(/^﻿/, '').replace(/\r/g, '').split('\n');

const BASE_DATE = Date.UTC(2026, 7, 22, 0, 0, 0); // 22-ago-2026 00:00 UTC (la captura cruza medianoche)
let day = 0, prevSecs = null;
let badLines = 0, dataLines = 0;
const goEvents = [];       // { ts, ds }
const finishEvents = [];   // { ts, ds }
const crossings = [];      // { ts, lane, lap(ms|null) }

for (let i = 0; i < rawLines.length; i++) {
  const ln = rawLines[i];
  const m = ln.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(DS[123])\s+(.+)$/);
  if (!m) { if (ln.trim()) badLines++; continue; }
  const bytes = m[3].trim().split(/\s+/).map(h => parseInt(h, 16));
  if (bytes.length < 21 || bytes.some(isNaN)) { badLines++; continue; }
  dataLines++;
  const [hh, mm, rest] = m[1].split(':'); const [ss, mmm] = rest.split('.');
  const secs = (+hh) * 3600 + (+mm) * 60 + (+ss);
  if (prevSecs != null && secs < prevSecs - 1) day++;   // cruce de medianoche (captura de 24h)
  prevSecs = secs;
  const ts = BASE_DATE + day * 86400000 + secs * 1000 + (+mmm);
  const b = bytes;
  if (b[7] === 0x3e && b[8] === 0xa1) { goEvents.push({ ts, ds: m[2] }); continue; }
  if (b[7] === 0x00 && b[8] === 0xa4) { finishEvents.push({ ts, ds: m[2] }); continue; }
  if (b[7] === 0x1b) {
    const local = LANE_MAP[b[10]];
    if (local) crossings.push({ ts, lane: local + OFFSET[m[2]], lap: lapMs(b) });
    continue;
  }
  // resto de tramas de control (A2 semáforo, A3 verde, A5 pausa, A6 reanudar,
  // B2/B4/C0 heartbeat/telemetría interna): no aportan cruces ni cierran manga.
}
crossings.sort((a, b) => a.ts - b.ts);
console.log(`Tramas: ${dataLines} de datos (${badLines} sin parsear), ${goEvents.length} GO, ${finishEvents.length} fin-de-manga, ${crossings.length} cruces.`);

// ── Agrupa GO / fin-de-manga por trío de cajas (ventana ~1s entre DS1/DS2/DS3) ─
function clusterByProximity(events, gapMs = 5000) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const clusters = [];
  for (const e of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && e.ts - last.ts < gapMs) last.n++;
    else clusters.push({ ts: e.ts, n: 1 });
  }
  return clusters;
}
const goClusters = clusterByProximity(goEvents);
const finClusters = clusterByProximity(finishEvents);
const incompleteGo = goClusters.filter(c => c.n < 3);
console.log(`Mangas detectadas (GO agrupados por trío): ${goClusters.length}` +
  (incompleteGo.length ? ` (${incompleteGo.length} con trío incompleto, normal en la 1ª si el marcador de corte cae entre GOs)` : ''));

// Ventana [start, end) de cada manga + hora de fin real (1er "fin de manga" dentro de la ventana).
const N_MANGAS = goClusters.length;
const lastCrossingTs = crossings.length ? crossings[crossings.length - 1].ts : goClusters[N_MANGAS - 1].ts;
const mangaWindows = goClusters.map((c, i) => {
  const start = c.ts;
  const nextStart = goClusters[i + 1] ? goClusters[i + 1].ts : (lastCrossingTs + 5 * 60000);
  const fin = finClusters.find(f => f.ts > start && f.ts < nextStart);
  const end = nextStart;
  const finishedAt = fin ? fin.ts : end;
  return { start, end, finishedAt };
});

// ── Índice normalizado del catálogo (case + acentos) ─────────────────────────
const catalogRows = db.prepare('SELECT id, name, color, country FROM teams_catalog').all();
const catalogByNorm = new Map(catalogRows.map(r => [normalize(r.name), r]));
const catalogMatches = [];   // { name, catalogId }
const catalogMisses = [];    // { name }
TEAM_NAMES.forEach(name => {
  const hit = catalogByNorm.get(normalize(name));
  if (hit) catalogMatches.push({ name, catalogId: hit.id });
  else catalogMisses.push({ name });
});

// ── Limpieza idempotente (mismo patrón que seed-modena-real.js / seed-llinars-test.js) ─
const existing = db.prepare('SELECT id FROM races WHERE name = ?').all(RACE_NAME);
if (existing.length) {
  const wipe = db.transaction(ids => {
    for (const { id } of ids) {
      for (const t of ['laps', 'driver_shifts']) db.prepare(`DELETE FROM ${t} WHERE race_id=?`).run(id);
      db.prepare('DELETE FROM manga_lanes WHERE manga_id IN (SELECT id FROM mangas WHERE race_id=?)').run(id);
      db.prepare('DELETE FROM mangas WHERE race_id=?').run(id);
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
const raceId = Race.create({
  name: RACE_NAME, type: 'championship', format: 'team',
  lanes_count: LANES, lane_sequence: LANE_SEQUENCE, circuits: CIRCUITS,
  manga_duration_minutes: 25, has_pole: 0, min_lap_ms: MIN_LAP_MS,
  passes: PASSES, lane_repeat: LANE_REPEAT,
});
const tandaId = Tanda.create(raceId);

const teamIdByName = {};
TEAM_NAMES.forEach((name, i) => {
  const cat = catalogByNorm.get(normalize(name));
  teamIdByName[name] = Team.create({
    race_id: raceId, tanda_id: tandaId, name, lane: 0,
    color: (cat && cat.color) || LANE_COLORS[i], country: (cat && cat.country) || null,
  });
});
console.log(`Carrera #${raceId} "${RACE_NAME}" creada con ${TEAM_NAMES.length} equipos.`);

// entities[i] = equipo que en la manga 1 (rotación s=0) ocupa el carril
// LANE_SEQUENCE[i] — así Manga.buildSchedule (lane = extended[(i+s)%seqLen])
// reproduce exactamente el reparto real "carril N → equipo N" de la manga 1
// que dio el usuario, y deja que el propio motor rote el resto.
const entities = LANE_SEQUENCE.map(laneNum => {
  const name = TEAM_NAMES[laneNum - 1];
  return { id: teamIdByName[name], type: 'team', name };
});
const fullSchedule = Manga.buildSchedule(LANE_SEQUENCE, entities, PASSES, LANE_REPEAT);
if (N_MANGAS > fullSchedule.length) {
  console.warn(`AVISO: hay ${N_MANGAS} mangas reales pero el schedule solo cubre ${fullSchedule.length} (passes/lane_repeat insuficientes) — se recortan las mangas sobrantes.`);
}
const schedule = fullSchedule.slice(0, N_MANGAS);
const mangaIds = Manga.persistSchedule(tandaId, raceId, schedule);

// ── Vueltas reales por carril, dentro de la ventana GO→GO de cada manga ─────
function crossingsInWindow(t0, t1) {
  // crossings ya está ordenado por ts: filtro lineal (barato, 47 mangas).
  return crossings.filter(c => c.ts >= t0 && c.ts < t1);
}

// Igual que seed-modena-real.js: 1er cruce de cada carril en la manga = out-lap
// (warmup); fantasmas (< MIN_LAP_MS) se fusionan con la vuelta siguiente;
// salida/pit-stop por desviación sobre la media limpia corriente del carril.
function buildLaps(laneCross, goTs) {
  const out = [];
  let lapNum = 0, ghostAccum = 0;
  let cleanSum = 0, cleanCount = 0, totalSum = 0, totalCount = 0;
  laneCross.forEach((c, idx) => {
    if (idx === 0) {
      lapNum++;
      out.push({ lap_time_ms: Math.round(c.ts - goTs), elapsed_ms: Math.round(c.ts - goTs), ts: c.ts, is_warmup: 1, is_exit: 0, is_pit_stop: 0, lap_number: lapNum });
      return;
    }
    let t = c.lap;
    if (t == null) t = c.ts - laneCross[idx - 1].ts;
    if (t < MIN_LAP_MS) { ghostAccum += t; return; }
    t += ghostAccum; ghostAccum = 0;
    lapNum++;
    const refAvg = cleanCount > 0 ? cleanSum / cleanCount : (totalCount > 0 ? totalSum / totalCount : 0);
    const isExit = refAvg > 0 && (t - refAvg >= EXIT_MARGIN_MS);
    const isPit = isExit && t >= refAvg * PIT_STOP_MULTIPLIER;
    totalSum += t; totalCount++;
    if (!isExit) { cleanSum += t; cleanCount++; }
    out.push({ lap_time_ms: Math.round(t), elapsed_ms: Math.round(c.ts - goTs), ts: c.ts, is_warmup: 0, is_exit: isExit ? 1 : 0, is_pit_stop: isPit ? 1 : 0, lap_number: lapNum });
  });
  return out;
}

const updateManga = db.prepare(
  `UPDATE mangas SET status='finished', started_at=?, finished_at=?, actual_duration_ms=? WHERE id=?`);

let totalLaps = 0, totalWarmup = 0, totalExits = 0, totalPits = 0;
const emptyLaneAlerts = [];   // { manga, lane, team }

const run = db.transaction(() => {
  schedule.forEach((slots, idx) => {
    const mangaId = mangaIds[idx];
    const win = mangaWindows[idx];
    updateManga.run(new Date(win.start).toISOString(), new Date(win.finishedAt).toISOString(), Math.max(0, Math.round(win.finishedAt - win.start)), mangaId);

    const winCross = crossingsInWindow(win.start, win.end);
    const byLane = {};
    winCross.forEach(c => { (byLane[c.lane] = byLane[c.lane] || []).push(c); });

    slots.forEach(({ lane, entity, isEmpty }) => {
      if (isEmpty || !entity) return;
      const laneCross = byLane[lane] || [];
      if (!laneCross.length) { emptyLaneAlerts.push({ manga: idx + 1, lane, team: entity.name }); return; }
      const laps = buildLaps(laneCross, win.start);
      laps.forEach(L => {
        Lap.create({
          race_id: raceId, manga_id: mangaId, team_id: entity.id, driver_id: null,
          lane, lap_number: L.lap_number, lap_time_ms: L.lap_time_ms, elapsed_ms: L.elapsed_ms,
          is_exit: L.is_exit, is_pit_stop: L.is_pit_stop, is_warmup: L.is_warmup,
        });
        totalLaps++; if (L.is_warmup) totalWarmup++;
        if (L.is_exit) totalExits++; if (L.is_pit_stop) totalPits++;
      });
    });
  });
});
run();

Race.updateStatus(raceId, 'finished');
Tanda.updateStatus(tandaId, 'finished');

// ── Resumen ────────────────────────────────────────────────────────────────
console.log('\n── Resumen ──────────────────────────────────────────────');
console.log(`Carrera #${raceId} "${RACE_NAME}"`);
console.log(`  ${LANES} carriles (cajas 8+8+8) · manga de 25 min · lane_repeat ${LANE_REPEAT} · passes ${PASSES}`);
console.log(`  ${schedule.length} mangas reconstruidas · ${totalLaps} vueltas insertadas (${totalWarmup} out-laps, ${totalExits} salidas, ${totalPits} pit-stops)`);
console.log(`  rango horario: ${new Date(mangaWindows[0].start).toISOString()} → ${new Date(mangaWindows[mangaWindows.length - 1].finishedAt).toISOString()}`);

console.log(`\n  Equipos con match exacto en catálogo (${catalogMatches.length}):`);
catalogMatches.forEach(m => console.log(`    "${m.name}" ↔ teams_catalog#${m.catalogId}`));
console.log(`  Equipos SIN match en catálogo, creados sueltos (${catalogMisses.length}):`);
catalogMisses.forEach(m => console.log(`    "${m.name}"`));

if (badLines) console.log(`\n  AVISO: ${badLines} líneas del fichero no se pudieron parsear (formato inesperado).`);
if (incompleteGo.length) {
  console.log(`\n  Tríos de GO incompletos (< 3 cajas): ${incompleteGo.length}`);
  incompleteGo.forEach(c => console.log(`    ${new Date(c.ts).toISOString()} — ${c.n}/3 caja(s)`));
}
if (fullSchedule.length < N_MANGAS) {
  console.log(`\n  AVISO: se detectaron ${N_MANGAS} GO reales pero el schedule (passes=${PASSES}, lane_repeat=${LANE_REPEAT}, ${LANE_SEQUENCE.length} carriles) solo cubre ${fullSchedule.length} mangas; se ignoraron las ${N_MANGAS - fullSchedule.length} últimas.`);
}
if (emptyLaneAlerts.length) {
  console.log(`\n  Carriles programados SIN ningún cruce real (${emptyLaneAlerts.length}):`);
  emptyLaneAlerts.forEach(a => console.log(`    manga ${a.manga}, carril ${a.lane} (${a.team})`));
} else {
  console.log('\n  Todos los carriles programados tuvieron al menos un cruce real en su manga.');
}
console.log('\nHecho.');
