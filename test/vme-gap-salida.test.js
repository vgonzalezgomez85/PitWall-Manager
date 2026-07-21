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
// Dos correcciones que integran la posición en pista y el artefacto de salida:
//
//   1) GAP FRACCIONARIO — la proyección/distancia incluye la coma (posición
//      fraccionaria dentro de la vuelta en curso): en pista la coma VIVA, y al
//      terminar la coma de la ÚLTIMA manga. Antes, al caer la bandera colapsaba a
//      vueltas ENTERAS e ignoraba quién iba más adelantado en pista. Bug real
//      (carrera 90): Victor "a 3,0 v" de Oscar (145 vs 142) cuando la realidad era
//      2,8 v ≈ 35,5" (lo que muestra TicTac). 2,8 × 12,67 s ≈ 35,5"; 3,0 daría 38".
//
//   2) settledAvg — el tiempo total de la 1ª manga de cada entidad sustituye el
//      tiempo del cruce de salida (is_warmup, ~1,2 s, rejilla→línea) por la media
//      de las completas del primer 60 %. Solo el TIEMPO TOTAL, NUNCA la media de
//      carril (avg_lap_ms, que sigue clavando TicTac).

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const TimingService = require('../src/services/TimingService');

after(limpiarBdTemporal);

beforeEach(() => {
  TimingService.session = null;
  TimingService.invalidateStandingsCaches();
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'drivers', 'teams', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

function nuevaCarrera(format = 'team', mins = 5) {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('gap', 'club', ?, 'active', 2, '[1,2]', '[2]', ?, 0, 0, 0, 0)
  `).run(format, mins).lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  return { raceId, tandaId };
}

/** Inserta una entidad (equipo o piloto) con sus vueltas en una manga y su coma. */
function sembrarEntidad({ raceId, tandaId, mangaId, format, nombre, lane, coma,
                          warmupMs = null, racingMs = [], elapsedFrom = 0 }) {
  const isTeam = format === 'team';
  let teamId = null, driverId = null;
  if (isTeam) {
    teamId = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)')
      .run(raceId, tandaId, nombre).lastInsertRowid;
  } else {
    driverId = db.prepare('INSERT INTO drivers (race_id, tanda_id, name) VALUES (?, ?, ?)')
      .run(raceId, tandaId, nombre).lastInsertRowid;
  }
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, driver_id, is_rest, coma) VALUES (?,?,?,?,0,?)')
    .run(mangaId, lane, teamId, driverId, coma);

  let ln = 0, elapsed = elapsedFrom;
  const mk = (ms, extra = {}) => {
    elapsed += ms;
    Lap.create({
      race_id: raceId, manga_id: mangaId, team_id: teamId, driver_id: driverId,
      lane, lap_number: ++ln, lap_time_ms: ms, elapsed_ms: elapsed, ...extra,
    });
  };
  if (warmupMs != null) mk(warmupMs, { is_warmup: 1 });
  racingMs.forEach(ms => mk(ms));
  return { teamId, driverId };
}

// ════════════════════════════════════════════════════════════════════════════
//  1) GAP FRACCIONARIO — regresión del bug de la carrera 90
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reproduce la carrera 90 al final: Oscar 145 v (media 12475, coma última 0.221) vs
 * Victor 142 v (media 12669, coma última 0.418). Carrera TERMINADA (nadie en
 * pista) → la posición fraccionaria es la coma de la última manga.
 */
function carrera90(format = 'team') {
  const { raceId, tandaId } = nuevaCarrera(format, 5);
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, actual_duration_ms) VALUES (?,?,1,?,?)')
    .run(tandaId, raceId, 'finished', 300000).lastInsertRowid;

  sembrarEntidad({ raceId, tandaId, mangaId, format, nombre: 'OSCAR', lane: 1, coma: 0.221,
    warmupMs: 1196, racingMs: Array(144).fill(12475) });
  sembrarEntidad({ raceId, tandaId, mangaId, format, nombre: 'VICTOR', lane: 2, coma: 0.418,
    warmupMs: 1196, racingMs: Array(141).fill(12669) });
  return { raceId };
}

test('la distancia incluye la coma: gap Oscar↔Victor = 2,8 v (no 3,0)', () => {
  const { raceId } = carrera90('team');
  const proj = TimingService.buildRaceProjection(raceId);
  const oscar  = proj.find(p => p.name === 'OSCAR');
  const victor = proj.find(p => p.name === 'VICTOR');

  assert.equal(oscar.totalLaps, 145);
  assert.equal(victor.totalLaps, 142);
  // Distancia = vueltas + coma última manga.
  assert.ok(Math.abs(oscar.projectedRaw  - 145.221) < 1e-6, `Oscar ${oscar.projectedRaw}`);
  assert.ok(Math.abs(victor.projectedRaw - 142.418) < 1e-6, `Victor ${victor.projectedRaw}`);

  // Gap fraccionario: 145.221 − 142.418 = 2.803, NO el entero 3.
  assert.equal(victor.gapV, 2.8, `gapV=${victor.gapV} (antes colapsaba a 3.0)`);
  assert.notEqual(victor.gapV, 3.0);
});

test('el gap en segundos usa la media del perseguidor y cuadra con los 35,5" de TicTac', () => {
  const { raceId } = carrera90('team');
  const victor = TimingService.buildRaceProjection(raceId).find(p => p.name === 'VICTOR');

  // 2,803 v × 12669 ms ≈ 35,5 s. El bug (3,0 v) daría ~38 s.
  assert.ok(Math.abs(victor.gapSec - 35500) < 600, `gapSec=${victor.gapSec}ms`);
  assert.ok(victor.gapSec < 37000, 'claramente por debajo de los 38 s del gap entero');
});

test('el orden de la proyección coincide con aggregateByRace (desempate coherente)', () => {
  const { raceId } = carrera90('team');
  TimingService.invalidateStandingsCaches();
  const proj = TimingService.buildRaceProjection(raceId).map(p => p.name);
  const res  = Lap.aggregateByRace(raceId).filter(r => r.entity_id != null).map(r => r.entity_name);
  assert.deepEqual(proj, res, 'proyección y resultados no pueden salir en orden opuesto');
  assert.equal(proj[0], 'OSCAR');
});

test('mismo gap fraccionario en formato individual (agregación por piloto)', () => {
  const { raceId } = carrera90('individual');
  const proj = TimingService.buildRaceProjection(raceId);
  const victor = proj.find(p => p.name === 'VICTOR');
  assert.equal(victor.gapV, 2.8, 'la coma también separa en formato individual');
  assert.ok(Math.abs(victor.gapSec - 35500) < 600);
});

// ── Posición VIVA (en pista) sin doble conteo ────────────────────────────────

test('en pista: projRaw = vueltas + liveFrac + remMs/avg, sin doble conteo', () => {
  const { raceId, tandaId } = nuevaCarrera('individual', 10);   // 600 s
  const startedMs = Date.now() - 550000;                        // elapsed ≈ 550 s
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, started_at, actual_duration_ms) VALUES (?,?,1,?,?,?)')
    .run(tandaId, raceId, 'active', new Date(startedMs).toISOString(), 600000).lastInsertRowid;

  // 8 vueltas a 10 s; el último cruce a 545 s → liveFrac = (550−545)/10 = 0,5.
  const { driverId } = sembrarEntidad({ raceId, tandaId, mangaId, format: 'individual',
    nombre: 'VIVO', lane: 1, coma: 0.10, racingMs: Array(8).fill(10000) });
  db.prepare('UPDATE laps SET elapsed_ms = 545000 WHERE manga_id = ? AND lane = 1 ORDER BY id DESC LIMIT 1')
    .run(mangaId);

  TimingService.invalidateStandingsCaches();
  const vivo = TimingService.buildRaceProjection(raceId).find(p => p.entityId === driverId);

  // activeRemMs ≈ 50 s → remMs/avg = 5,0 · liveFrac = 0,5 → 8 + 5,5. La deriva del
  // reloj entre el sellado y el cálculo se cancela (liveFrac sube lo que remMs baja).
  assert.ok(Math.abs(vivo.projectedRaw - 13.5) < 0.05, `projRaw=${vivo.projectedRaw} (esperado ≈13.5)`);
  assert.ok(vivo.onTrack, 'está en pista');
});

// ════════════════════════════════════════════════════════════════════════════
//  2) settledAvg — corrección del tiempo total de la salida (1ª manga)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 1ª (y única) manga de un piloto: salida 1196 ms + 14 completas a 12343 dentro del
 * primer 60 % (≤180 s de 300 s) + 3 completas a 13000 más allá del 60 %.
 *   settledAvg = 12343 (solo las de dentro del 60 %) · warmup = 1196 · delta = 11147.
 */
function primeraMangaConSalida() {
  const { raceId, tandaId } = nuevaCarrera('individual', 5);   // 300 s
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, actual_duration_ms) VALUES (?,?,1,?,?)')
    .run(tandaId, raceId, 'finished', 300000).lastInsertRowid;

  const isTeam = false;
  const driverId = db.prepare('INSERT INTO drivers (race_id, tanda_id, name) VALUES (?, ?, ?)')
    .run(raceId, tandaId, 'SOLO').lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, driver_id, is_rest, coma) VALUES (?,1,?,0,0.2)').run(mangaId, driverId);

  let ln = 0;
  const mk = (ms, elapsed, extra = {}) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: null, driver_id: driverId,
    lane: 1, lap_number: ++ln, lap_time_ms: ms, elapsed_ms: elapsed, ...extra,
  });
  mk(1196, 1196, { is_warmup: 1 });                     // salida (artefacto)
  for (let k = 1; k <= 14; k++) mk(12343, 1196 + 12343 * k);   // dentro del 60 % (≤ 174 s)
  for (let k = 1; k <= 3;  k++) mk(13000, 200000 + 13000 * k); // más allá del 60 %

  const rawSum = 1196 + 14 * 12343 + 3 * 13000;
  return { raceId, driverId, rawSum };
}

test('settledAvg = media de las completas del primer 60 % (determinista, incl. salidas)', () => {
  const { raceId, driverId } = primeraMangaConSalida();
  const map1 = Lap.startSettledByEntity(raceId);
  const c = map1.get('driver:' + driverId);
  assert.ok(Math.abs(c.settledAvg - 12343) < 1e-6, `settledAvg=${c.settledAvg}`);
  assert.equal(c.warmupMs, 1196);
  assert.ok(Math.abs(c.delta - (12343 - 1196)) < 1e-6, `delta=${c.delta}`);

  // Determinista / restart-safe: recalcular tras una mutación da lo mismo.
  Lap.markExternalMutation();
  const c2 = Lap.startSettledByEntity(raceId).get('driver:' + driverId);
  assert.deepEqual(c2, c);
});

test('el tiempo total sube settledAvg − warmup; la media de carril NO cambia', () => {
  const { raceId, driverId, rawSum } = primeraMangaConSalida();
  const row = Lap.aggregateByRace(raceId).find(r => r.entity_id === driverId);

  // total_time_ms = suma cruda − salida + settledAvg (sube ~11,1 s).
  assert.ok(Math.abs(row.total_time_ms - (rawSum - 1196 + 12343)) < 1e-6,
    `total_time_ms=${row.total_time_ms}`);

  // INVARIANTE CRÍTICA: avg_lap_ms (media de carril = TicTac) intacta: media SIMPLE
  // de TODAS las completas sin warmup (17 vueltas), sin tocar por la corrección.
  const avgEsperada = (14 * 12343 + 3 * 13000) / 17;
  assert.ok(Math.abs(row.avg_lap_ms - avgEsperada) < 1e-6, `avg_lap_ms=${row.avg_lap_ms}`);
});

test('la corrección de salida NO desincroniza las dos vías del agregado', () => {
  const { raceId } = primeraMangaConSalida();
  const directo = Lap.aggregateByRace(raceId);
  const prior   = Lap._aggRaw(raceId, { excludeManga: -1 });
  const split   = Lap.aggregateByRaceSplit(raceId, -1, prior);
  assert.deepEqual(split, directo, 'aggregateByRace y aggregateByRaceSplit deben coincidir');
});

test('mangas 2+ no se tocan: solo la 1ª manga de la entidad recibe settledAvg', () => {
  const { raceId, tandaId } = nuevaCarrera('individual', 5);
  const m1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, actual_duration_ms) VALUES (?,?,1,?,?)')
    .run(tandaId, raceId, 'finished', 300000).lastInsertRowid;
  const m2 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, actual_duration_ms) VALUES (?,?,2,?,?)')
    .run(tandaId, raceId, 'finished', 300000).lastInsertRowid;
  const driverId = db.prepare('INSERT INTO drivers (race_id, tanda_id, name) VALUES (?, ?, ?)')
    .run(raceId, tandaId, 'DOS').lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, driver_id, is_rest, coma) VALUES (?,1,?,0,0.1)').run(m1, driverId);
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, driver_id, is_rest, coma) VALUES (?,2,?,0,0.1)').run(m2, driverId);
  let ln = 0;
  const mk = (mid, ms, el, extra = {}) => Lap.create({
    race_id: raceId, manga_id: mid, team_id: null, driver_id: driverId,
    lane: 1, lap_number: ++ln, lap_time_ms: ms, elapsed_ms: el, ...extra });
  // 1ª manga: salida 1196 + completas 10000.  2ª manga: salida 8000 + completas 10000.
  mk(m1, 1196, 1196, { is_warmup: 1 }); for (let k = 1; k <= 5; k++) mk(m1, 10000, 1196 + 10000 * k);
  mk(m2, 8000, 8000, { is_warmup: 1 }); for (let k = 1; k <= 5; k++) mk(m2, 10000, 8000 + 10000 * k);

  const map = Lap.startSettledByEntity(raceId);
  const c = map.get('driver:' + driverId);
  assert.equal(c.firstMangaId, m1, 'la 1ª manga es la de menor id');
  assert.equal(c.warmupMs, 1196, 'la corrección apunta a la salida de la 1ª manga, no a la de la 2ª (8000)');
  assert.ok(Math.abs(c.settledAvg - 10000) < 1e-6);

  // El total corregido sustituye SOLO el 1196; la warmup de la 2ª (8000) sigue dentro.
  const rawSum = 1196 + 5 * 10000 + 8000 + 5 * 10000;
  const row = Lap.aggregateByRace(raceId).find(r => r.entity_id === driverId);
  assert.ok(Math.abs(row.total_time_ms - (rawSum - 1196 + 10000)) < 1e-6, `total=${row.total_time_ms}`);
});

// ── PROVISIONAL ──────────────────────────────────────────────────────────────

test('la estimada es PROVISIONAL antes del 60 % de la 1ª manga y firme después', () => {
  const { raceId, tandaId } = nuevaCarrera('individual', 10);   // 600 s
  // 1ª manga ACTIVA arrancada hace 120 s (< 60 % de 600 s = 360 s) → provisional.
  const startedMs = Date.now() - 120000;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, started_at, actual_duration_ms) VALUES (?,?,1,?,?,?)')
    .run(tandaId, raceId, 'active', new Date(startedMs).toISOString(), 600000).lastInsertRowid;
  const { driverId } = sembrarEntidad({ raceId, tandaId, mangaId, format: 'individual',
    nombre: 'PROV', lane: 1, coma: 0.1, warmupMs: 1196, racingMs: Array(10).fill(10000) });

  TimingService.invalidateStandingsCaches();
  let p = TimingService.buildRaceProjection(raceId).find(x => x.entityId === driverId);
  assert.equal(p.provisional, true, 'antes del 60 % de su 1ª manga → provisional');

  // Avanzamos el arranque: la manga ya lleva > 60 % (450 s de 600 s).
  db.prepare('UPDATE mangas SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 450000).toISOString(), mangaId);
  TimingService.invalidateStandingsCaches();
  p = TimingService.buildRaceProjection(raceId).find(x => x.entityId === driverId);
  assert.equal(p.provisional, false, 'pasado el 60 %, settledAvg queda bloqueado → firme');
});
