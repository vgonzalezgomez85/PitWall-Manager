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
// Simulación completa de una carrera de 24 h tipo Modena/Llinars, para ver cómo
// quedan los datos UNA VEZ FINALIZADA: 24 equipos (uno por carril), 5 pilotos
// por equipo (120 pilotos), 48 mangas de 25 min y el escaneo QR de cada piloto
// al entrar a cada uno de sus turnos.
//
// Nada de esto viene de una carrera real: equipos, pilotos, tiempos y vueltas
// son inventados (PRNG con semilla fija → la simulación sale idéntica en cada
// ejecución). Lo que SÍ es real es el formato y el encadenado con la app:
//
//   · Formato de Llinars: 24 carriles en 3 cajas (8+8+8), lane_sequence real,
//     lane_repeat 2 (el mismo carril dos mangas seguidas y luego rota) y mangas
//     de 25 min cada 30 (5 min de descanso) → 48 mangas = 24 h de reloj.
//   · Reparto carril↔equipo por manga con Manga.buildSchedule, el mismo motor
//     que usa la app en producción.
//   · Uniones del informe de turnos: teams_catalog ↔ teams por nombre y
//     teams_catalog_members ↔ driver_shifts por nombre DENTRO del equipo, con
//     driver_profiles.qr_code en el formato que espera el escáner (DRV:…).
//   · Turnos: cada turno nace de un escaneo QR antes del GO (pre_armed), el GO
//     lo activa (started_at_ms) y el fin de manga lo cierra (ended_at_ms), igual
//     que hace TimingService durante una carrera de verdad. 1.152 turnos = 48
//     mangas × 24 carriles, sin ningún fichaje olvidado.
//   · Reglas de piloto: mínimo 2 h 50 min, máximo 5 h (24 h entre 5 pilotos sale
//     a 4,8 h de media, así que el máximo tiene que ser mayor que eso) y 12
//     turnos (un turno = una manga). Salen 9-10 mangas por piloto (3 h 45 -
//     4 h 10) en relevos de 2-3 mangas → informe final TODO OK, sin avisos ni
//     infracciones.
//
// Uso: node scripts/seed-24h-simulada-24x5.js
//      (re-ejecutable: borra y vuelve a crear la carrera con el mismo nombre)

'use strict';

const db    = require('../src/config/database');
const Race  = require('../src/models/Race');
const Tanda = require('../src/models/Tanda');
const Manga = require('../src/models/Manga');
const Team  = require('../src/models/Team');
const { evaluate } = require('../src/utils/shiftCompliance');

// ── Parámetros de la carrera ────────────────────────────────────────────────
const RACE_NAME     = '24h SIMULADA — 24 equipos × 5 pilotos';
const LANES         = 24;
const CIRCUITS      = [8, 8, 8];
const LANE_SEQUENCE = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
const PASSES        = 1;
const LANE_REPEAT   = 2;
const N_MANGAS      = LANES * LANE_REPEAT;           // 48 mangas
const MANGA_MS      = 25 * 60000;                    // manga de 25 min
const CYCLE_MS      = 30 * 60000;                    // 25 de pista + 5 de descanso
const T0_MS         = Date.UTC(2026, 9, 3, 8, 0, 0); // sáb 03-oct-2026 10:00 Madrid (CEST = UTC+2)
const MIN_LAP_MS    = 13000;                         // por debajo de esto la app lo trata como fantasma

// Reglas de piloto que juzga el informe final (0 = sin límite, como en la app)
const DRIVER_MIN_MS    = 10_200_000;   // 2 h 50 min
const DRIVER_MAX_MS    = 18_000_000;   // 5 h 00 min
// OJO: en esta app un "turno" es UNA manga (cada manga el piloto vuelve a
// fichar), así que 48 mangas entre 5 pilotos son 9-10 turnos por piloto. El
// máximo tiene que ser mayor que eso o el informe los marca a todos.
const DRIVER_MAX_RUNS  = 12;           // turnos máximos por piloto
const DRIVERS_PER_TEAM = 5;

// ── PRNG determinista (mulberry32): misma simulación en cada ejecución ──────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng     = mulberry32(20261003);
const rand    = (a, b) => a + rng() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick    = (arr) => arr[Math.floor(rng() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const gauss = () => (rng() + rng() + rng() + rng() - 2) / 2;   // media 0, σ ≈ 0,29

// ── Equipos y pilotos inventados ────────────────────────────────────────────
// Nombres de club inventados con sabor catalán (ninguno es un equipo real de
// Llinars/Modena) para que la simulación se reconozca como tal de un vistazo.
const TEAM_NAMES = [
  'APEX RACING', 'VELOCITAT CLUB', 'NITRO TEAM', 'GRAELLA SLOT',
  'TURBO NORD', 'CIRCUIT NOCTURN', 'ESCUDERIA MARESME', 'SLOT VALLES',
  'RAPID FALCONS', 'MUNTANYA RACING', 'DELTA SLOT TEAM', 'FOC NOCTURN',
  'LLAMP RACING', 'TRAMUNTANA SLOT', 'VENT RACING', 'SILENCI NOCTURN',
  'PISTA ZERO', 'MOMENTUM RACING', 'ESCUDERIA COSTA', 'SLOT PIRINEU',
  'ONADA RACING', 'GARBI TEAM', 'SEGRE SLOT', 'PONENT RACING',
];

const FIRST_NAMES = [
  'AARON', 'ADRIÀ', 'ALBERT', 'ALEIX', 'ANDRÉS', 'ÀNGEL', 'ARNAU', 'BERTA', 'CARLES',
  'CRISTIAN', 'DANI', 'DAVID', 'EDUARD', 'ELOI', 'ENRIC', 'ERIC', 'ESTEVE', 'FERRAN',
  'FRANCESC', 'GERARD', 'GUILLEM', 'HUGO', 'IGNASI', 'IVAN', 'JAN', 'JOAN', 'JORDI',
  'JOSEP', 'LAIA', 'LLUÍS', 'MARC', 'MARTÍ', 'MIQUEL', 'NIL', 'ORIOL', 'OSCAR', 'PAU',
  'PERE', 'POL', 'QUIM', 'RAMON', 'RICARD', 'ROGER', 'SERGI', 'TONI', 'VÍCTOR', 'XAVI',
];
const LAST_NAMES = [
  'ABELLÓ', 'AGUILAR', 'ALBA', 'ALCARAZ', 'AMAT', 'ARENAS', 'BAGÉ', 'BALAGUER',
  'BALLESTER', 'BARRUFET', 'BELTRAN', 'BONET', 'BOSCH', 'CABRERA', 'CALVET', 'CAMPS',
  'CANALS', 'CARRERAS', 'CASALS', 'CASTELLS', 'CLARET', 'COLL', 'COSTA', 'DURAN',
  'ESTEVE', 'FABRA', 'FERRER', 'FONT', 'GALÍ', 'GARRIGA', 'GIRALT', 'GRAU', 'GUARDIA',
  'IGLESIAS', 'JULIÀ', 'LLORENS', 'MARTÍ', 'MAS', 'MATEU', 'MIRÓ', 'MOLINS', 'MORERA',
  'NAVARRO', 'OLIVA', 'PADRÓ', 'PALAU', 'PASCUAL', 'PIQUÉ', 'PLANAS', 'PONS', 'PRAT',
  'PUIG', 'RIERA', 'ROCA', 'ROIG', 'ROMEU', 'SALA', 'SÁNCHEZ', 'SERRA', 'SOLER',
  'SORIA', 'TORRES', 'VALLS', 'VENDRELL', 'VIDAL', 'VILA',
];
const CATEGORIES    = ['platino', 'oro', 'plata', 'bronce'];
const CATEGORY_W    = [0.15, 0.30, 0.35, 0.20];
const CATEGORY_PACE = { platino: -0.12, oro: 0, plata: 0.12, bronce: 0.25 };  // segundos

const usedNames = new Set();
function newDriverName() {
  for (let i = 0; i < 2000; i++) {
    const n = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)} ${pick(LAST_NAMES)}`;
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
  throw new Error('No quedan nombres de piloto disponibles');
}
function pickCategory() {
  let r = rng(), acc = 0;
  for (let i = 0; i < CATEGORIES.length; i++) { acc += CATEGORY_W[i]; if (r < acc) return CATEGORIES[i]; }
  return 'bronce';
}

// ── Rotación de pilotos: 48 mangas entre 5 pilotos ──────────────────────────
// Tres pilotos ruedan 10 mangas y dos ruedan 9 (10·3 + 9·2 = 48), en turnos de
// 2-3 mangas alternando pilotos. Totales por piloto: 3 h 45 min - 4 h 10 min.
function chunkStint(total) {
  const options = total === 10
    ? [[3, 3, 2, 2], [3, 2, 3, 2], [2, 3, 2, 3], [2, 2, 3, 3], [2, 2, 2, 2, 2]]
    : [[3, 3, 3], [3, 2, 2, 2], [2, 3, 2, 2], [2, 2, 3, 2], [2, 2, 2, 3]];
  return [...pick(options)];
}
function stintPlan() {
  const totals = shuffle([10, 10, 10, 9, 9]);
  const pool   = totals.map(chunkStint);   // lista de turnos pendientes por piloto
  const seq    = [];                       // piloto (índice) que conduce cada manga
  let d = randInt(0, DRIVERS_PER_TEAM - 1);
  while (seq.length < N_MANGAS) {
    const idx = d % DRIVERS_PER_TEAM;
    if (pool[idx].length) seq.push(...Array(pool[idx].shift()).fill(idx));
    d++;
  }
  return seq;
}

// ── Limpieza idempotente (mismo patrón que seed-llinars-24h-simulada.js) ────
const existing = db.prepare('SELECT id FROM races WHERE name = ?').all(RACE_NAME);
if (existing.length) {
  const wipe = db.transaction(ids => {
    for (const { id } of ids) {
      for (const t of ['race_events', 'laps', 'driver_shifts']) {
        db.prepare(`DELETE FROM ${t} WHERE race_id=?`).run(id);
      }
      db.prepare('DELETE FROM manga_lanes WHERE manga_id IN (SELECT id FROM mangas WHERE race_id=?)').run(id);
      db.prepare('DELETE FROM mangas  WHERE race_id=?').run(id);
      db.prepare('DELETE FROM drivers WHERE race_id=?').run(id);
      db.prepare('DELETE FROM teams   WHERE race_id=?').run(id);
      db.prepare('DELETE FROM tandas  WHERE race_id=?').run(id);
      db.prepare('DELETE FROM races   WHERE id=?').run(id);
    }
  });
  wipe(existing);
  // Fichas de piloto y equipos de catálogo de simulaciones anteriores
  db.prepare("DELETE FROM driver_profiles WHERE qr_code LIKE 'DRV:SIM24H-%'").run();
  for (const name of TEAM_NAMES) {
    const cat = db.prepare('SELECT id FROM teams_catalog WHERE name = ?').get(name);
    if (cat) {
      db.prepare('DELETE FROM teams_catalog_members WHERE team_id = ?').run(cat.id);
      db.prepare('DELETE FROM teams_catalog WHERE id = ?').run(cat.id);
    }
  }
  console.log(`Borrada(s) ${existing.length} carrera(s) "${RACE_NAME}" previa(s) y sus catálogos.`);
}

// ── Alta de la carrera ──────────────────────────────────────────────────────
const raceId = Race.create({
  name: RACE_NAME, type: 'championship', format: 'team',
  lanes_count: LANES, lane_sequence: LANE_SEQUENCE, circuits: CIRCUITS,
  manga_duration_minutes: 25, has_pole: 0, min_lap_ms: MIN_LAP_MS,
  passes: PASSES, lane_repeat: LANE_REPEAT,
  driver_min_total_ms: DRIVER_MIN_MS, driver_max_total_ms: DRIVER_MAX_MS,
  driver_max_runs: DRIVER_MAX_RUNS, driver_change_lockout_ms: 120000,
});
const tandaId = Tanda.create(raceId);

// ── Equipos + catálogo + 120 fichas de piloto con su QR ─────────────────────
const insertProfile = db.prepare('INSERT INTO driver_profiles (name, category, qr_code) VALUES (?, ?, ?)');
const insertMember  = db.prepare('INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES (?, ?, ?, ?)');
const insertDriver  = db.prepare('INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, ?)');
const insertCatTeam = db.prepare('INSERT INTO teams_catalog (name, color) VALUES (?, ?)');

const teams = [];
let qrSeq = 0;
TEAM_NAMES.forEach((name, idx) => {
  const color  = `hsl(${Math.round(idx * 360 / LANES)}, 70%, 50%)`;
  const teamId = Team.create({ race_id: raceId, tanda_id: tandaId, name, lane: 0, color });
  const catId  = insertCatTeam.run(name, color).lastInsertRowid;

  const drivers = [];
  for (let k = 0; k < DRIVERS_PER_TEAM; k++) {
    const dName    = newDriverName();
    const category = pickCategory();
    // El QR va en el mismo formato que genera la app (DRV:…) para que el
    // escáner del control de pilotos lo resolvería igual que uno de verdad.
    const profileId = insertProfile.run(dName, category, `DRV:SIM24H-${String(++qrSeq).padStart(3, '0')}`).lastInsertRowid;
    insertMember.run(catId, profileId, dName, k);
    const driverId = insertDriver.run(raceId, tandaId, teamId, dName).lastInsertRowid;
    drivers.push({
      profileId, driverId, name: dName, category,
      paceMod: CATEGORY_PACE[category] + rand(-0.08, 0.08),   // segundos
    });
  }
  // Ritmo base del equipo: de 14,40 s (los rápidos) a ~15,75 s (los lentos)
  teams.push({ idx, name, teamId, catId, drivers, basePace: rand(14.40, 15.75) });
});
const teamById = new Map(teams.map(t => [t.teamId, t]));

// ── Calendario de mangas (mismo motor que la app) ───────────────────────────
// entities[i] = equipo que en la manga 1 ocupa el carril LANE_SEQUENCE[i], así
// la manga 1 sale "carril N → equipo N" y el resto rota como en la carrera real.
const entities = LANE_SEQUENCE.map(laneNum => {
  const t = teams[laneNum - 1];
  return { id: t.teamId, type: 'team', name: t.name };
});
const fullSchedule = Manga.buildSchedule(LANE_SEQUENCE, entities, PASSES, LANE_REPEAT);
const schedule     = fullSchedule.slice(0, N_MANGAS);
if (fullSchedule.length !== N_MANGAS) {
  throw new Error(`El calendario cubre ${fullSchedule.length} mangas y se esperaban ${N_MANGAS}`);
}
const mangaIds = Manga.persistSchedule(tandaId, raceId, schedule);

// Rotación de pilotos de cada equipo
const rotations = teams.map(() => stintPlan());

// ── Sentencias de escritura masiva ──────────────────────────────────────────
const updateManga = db.prepare(
  `UPDATE mangas SET status='finished', started_at=?, finished_at=?, actual_duration_ms=? WHERE id=?`);
const setLaneDriver = db.prepare('UPDATE manga_lanes SET driver_id=? WHERE manga_id=? AND lane=?');
const insertLap = db.prepare(`
  INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms,
                    elapsed_ms, timestamp, is_exit, is_ghost, is_pit_stop, is_warmup, is_estimated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`);
const insertShift = db.prepare(`
  INSERT INTO driver_shifts (manga_id, race_id, lane, team_id, driver_id, driver_name,
                             started_at, started_at_ms, ended_at_ms, driving_ms, pre_armed, manual, elapsed_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`);
const insertEvent = db.prepare(`
  INSERT INTO race_events (race_id, manga_id, manga_number, type, circuit, lane, entity_name, payload_json, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const iso   = (ms) => new Date(ms).toISOString();
const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ── Vueltas de un carril en una manga ───────────────────────────────────────
// Mismo criterio que seed-llinars-24h-simulada.js: la 1ª vuelta es la de salida
// (warmup), y una vuelta lenta es "salida" si supera la media del carril en
// 1,7 s y "parada" si además la dobla. `paceMs` es el ritmo del equipo + piloto.
function buildLaps(paceMs, durationMs) {
  const laps = [];
  let elapsed = 0;

  // Vuelta de salida (out-lap): el coche entra desde boxes
  let t = Math.round(paceMs + rand(2200, 3800));
  elapsed += t;
  laps.push({ t, elapsed, warmup: 1, exit: 0, pit: 0 });

  const pitLap = rng() < 0.18 ? randInt(20, 70) : -1;   // parada a mitad de manga
  let degradation = 0;
  for (let k = 1; ; k++) {
    let lt = paceMs + gauss() * 130 + degradation;      // ms
    if (rng() < 0.03) lt += rand(350, 1800);            // tráfico puntual
    if (k === pitLap) lt += rand(14000, 26000);         // entrada a boxes y vuelta a pista
    degradation += 4;                                   // el neumático se va cayendo
    t = Math.max(MIN_LAP_MS + 200, Math.round(lt));
    if (elapsed + t > durationMs) break;
    elapsed += t;
    const isExit = t >= Math.round(paceMs) + 1700;
    laps.push({ t, elapsed, warmup: 0, exit: isExit ? 1 : 0, pit: (isExit && t >= Math.round(paceMs) * 2) ? 1 : 0 });
  }
  return laps;
}

// ── Generación ──────────────────────────────────────────────────────────────
let totalLaps = 0, totalShifts = 0, totalEvents = 0, totalPits = 0, lastEndMs = T0_MS;

const run = db.transaction(() => {
  for (let m = 0; m < N_MANGAS; m++) {
    const startMs    = T0_MS + m * CYCLE_MS;
    const durationMs = MANGA_MS + randInt(0, 40) * 1000;   // 25 min + hasta 40 s de propina
    const endMs      = startMs + durationMs;
    const mangaId    = mangaIds[m];
    lastEndMs = endMs;

    updateManga.run(iso(startMs), iso(endMs), durationMs, mangaId);

    for (const slot of schedule[m]) {
      if (slot.isEmpty || !slot.entity) continue;
      const lane   = slot.lane;
      const team   = teamById.get(slot.entity.id);
      const driver = team.drivers[rotations[team.idx][m]];

      // ── El turno: el piloto escaneó su QR antes del GO ──────────────────
      // (pre_armed mientras la manga estaba pendiente) y el GO lo activó; el
      // fin de manga lo cierra con el tiempo rodado.
      const scanMs = startMs - randInt(120, 480) * 1000;
      insertShift.run(mangaId, raceId, lane, team.teamId, driver.driverId, driver.name,
                      sqlTs(startMs), startMs, endMs, durationMs, durationMs);
      totalShifts++;

      // ── Fichaje en el registro de sucesos (modo pre-armado, como en vivo) ─
      insertEvent.run(raceId, mangaId, m + 1, 'driver_checkin', null, lane, driver.name,
                      JSON.stringify({ mode: 'pre_arm' }), scanMs);
      totalEvents++;

      // ── Vueltas del carril, todas a nombre del piloto de este turno ──────
      setLaneDriver.run(driver.driverId, mangaId, lane);
      const laps = buildLaps((team.basePace + driver.paceMod) * 1000, durationMs);
      laps.forEach((L, i) => {
        insertLap.run(raceId, mangaId, team.teamId, driver.driverId, lane, i + 1, L.t, L.elapsed,
                      sqlTs(startMs + L.elapsed), L.exit, L.pit, L.warmup);
        totalLaps++;
        if (L.pit) totalPits++;
      });
    }

    // GO de las tres cajas (una por circuito) y fin de manga
    for (let c = 0; c < CIRCUITS.length; c++) {
      insertEvent.run(raceId, mangaId, m + 1, 'go', c, null, null, null, startMs);
      totalEvents++;
    }
    insertEvent.run(raceId, mangaId, m + 1, 'stop', null, null, null,
                    JSON.stringify({ isTandaEnd: m === N_MANGAS - 1 }), endMs);
    totalEvents++;
  }
});
run();

// ── Estado final: carrera terminada, con sus horas reales ───────────────────
db.prepare("UPDATE races SET status='finished', started_at=?, finished_at=? WHERE id=?")
  .run(iso(T0_MS), iso(lastEndMs), raceId);
Tanda.updateStatus(tandaId, 'finished');

// ── Resumen + comprobación de reglas con el MISMO validador del informe ─────
const hhmmss = (ms) => `${Math.floor(ms / 3600000)} h ${String(Math.round((ms % 3600000) / 60000)).padStart(2, '0')} min`;

console.log('\n── Resumen ─────────────────────────────────────────────────────');
console.log(`Carrera #${raceId} "${RACE_NAME}"`);
console.log(`  ${LANES} carriles (cajas ${CIRCUITS.join('+')}) · manga de 25 min cada 30 · lane_repeat ${LANE_REPEAT}`);
console.log(`  ${N_MANGAS} mangas · ${totalLaps} vueltas (${totalPits} con parada) · ${totalShifts} turnos · ${totalEvents} sucesos`);
console.log(`  ${new Date(T0_MS).toISOString()} → ${new Date(lastEndMs).toISOString()}`);
console.log(`  ${teams.length} equipos · ${teams.length * DRIVERS_PER_TEAM} pilotos con QR`);

const reglas = { minMs: DRIVER_MIN_MS, maxMs: DRIVER_MAX_MS, maxRuns: DRIVER_MAX_RUNS, final: true };
const resumen = db.prepare(`
  SELECT d.name AS piloto, t.name AS equipo,
         COALESCE(SUM(ds.driving_ms), 0) AS total_ms,
         SUM(CASE WHEN ds.started_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS turnos
  FROM drivers d
  JOIN teams t ON t.id = d.team_id
  LEFT JOIN driver_shifts ds ON ds.driver_id = d.id AND ds.race_id = d.race_id
  WHERE d.race_id = ?
  GROUP BY d.id
  ORDER BY total_ms DESC
`).all(raceId);

const evaluados   = resumen.map(r => ({ ...r, compliance: evaluate({ totalMs: r.total_ms, runs: r.turnos }, reglas) }));
const incidencias = evaluados.filter(r => r.compliance.status !== 'ok');
const totales     = resumen.map(r => r.total_ms);

console.log(`\n  Pilotos: ${resumen.length} · tiempo por piloto entre ${hhmmss(Math.min(...totales))} y ${hhmmss(Math.max(...totales))}`);
console.log(`  Turnos por piloto: ${Math.min(...resumen.map(r => r.turnos))}-${Math.max(...resumen.map(r => r.turnos))} (máx. ${DRIVER_MAX_RUNS}, reglas ${hhmmss(DRIVER_MIN_MS)} – ${hhmmss(DRIVER_MAX_MS)})`);
console.log(incidencias.length === 0
  ? '  Reglas: TODOS los pilotos cumplen (informe todo OK) ✔'
  : `  AVISO: ${incidencias.length} piloto(s) fuera de reglas:`);
incidencias.slice(0, 10).forEach(i => console.log(`    ${i.piloto} (${i.equipo}) — ${i.compliance.status}, ${hhmmss(i.total_ms)}, ${i.turnos} turnos`));

console.log('\nHecho. En la app (pestaña Carreras) o directamente:');
console.log(`  http://localhost:3000/races/${raceId}`);
console.log(`  http://localhost:3000/races/${raceId}/shifts          (histórico de turnos)`);
console.log(`  http://localhost:3000/races/${raceId}/shifts/report   (informe final)`);
console.log(`  http://localhost:3000/races/${raceId}/results         (clasificación)`);
console.log(`  http://localhost:3000/races/${raceId}/events          (sucesos)\n`);
