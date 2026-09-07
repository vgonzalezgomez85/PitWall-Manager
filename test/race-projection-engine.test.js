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
// Paso 1 de la separación en hilos (ver memoria threads/worker viabilidad):
// `buildRaceProjection` se sacó de TimingService a `src/engine/raceProjection.js`
// como MÓDULO PURO. Este test fija que el módulo puro, llamado standalone (sin
// la instancia de TimingService, sin sus cachés), da EXACTAMENTE el mismo
// resultado que la vía de TimingService — que es justo la propiedad que
// necesita el worker: ejecutar el cálculo contra una conexión `readonly` y
// obtener lo mismo que obtendría el hilo principal.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const Manga = require('../src/models/Manga');
const TimingService = require('../src/services/TimingService');
const raceProjection = require('../src/engine/raceProjection');

after(limpiarBdTemporal);

beforeEach(() => {
  TimingService.session = null;
  TimingService.invalidateStandingsCaches();
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'drivers', 'teams', 'teams_catalog', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

// ── Fixture: carrera por equipos con varias mangas, warmup/exit/pit y comas ──

function seedRace({ activeManga = false, withPending = false } = {}) {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES ('proj', 'championship', 'team', 'active', 3, '[1,2,3]', '[3]', 10)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;

  const names = ['Alfa', 'Bravo', 'Charlie'];
  const teams = names.map(n => {
    // Categoría por catálogo (empareja por nombre) — ejercita ese JOIN.
    db.prepare('INSERT INTO teams_catalog (name, categoria) VALUES (?, ?)').run(n, n === 'Alfa' ? 'oro' : 'plata');
    return db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, n).lastInsertRowid;
  });

  // 2 mangas terminadas + (opcional) 1 activa + (opcional) 1 pendiente.
  const mkManga = (num, status, opts = {}) => {
    const id = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)').run(tandaId, raceId, num).lastInsertRowid;
    if (status) {
      db.prepare('UPDATE mangas SET status = ?, started_at = ?, finished_at = ?, actual_duration_ms = ? WHERE id = ?')
        .run(status, opts.started_at ?? null, opts.finished_at ?? null, opts.actual_duration_ms ?? null, id);
    }
    return id;
  };

  const m1 = mkManga(1, 'finished', { started_at: '2020-01-01 00:00:00', finished_at: '2020-01-01 00:10:00', actual_duration_ms: 600000 });
  const m2 = mkManga(2, 'finished', { started_at: '2020-01-01 00:10:00', finished_at: '2020-01-01 00:20:00', actual_duration_ms: 600000 });
  const m3 = activeManga ? mkManga(3, 'active', { started_at: '2020-01-01 00:20:00', actual_duration_ms: 600000 }) : null;
  const m4 = withPending ? mkManga(4, null) : null;

  // manga_lanes: rotación de carril + comas por manga.
  const setLane = (mangaId, lane, teamId, coma) =>
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, ?, ?, 0, ?)').run(mangaId, lane, teamId, coma);

  setLane(m1, 1, teams[0], 0.20); setLane(m1, 2, teams[1], 0.50); setLane(m1, 3, teams[2], 0.10);
  setLane(m2, 2, teams[0], 0.35); setLane(m2, 3, teams[1], 0.40); setLane(m2, 1, teams[2], 0.60);
  if (m3) { setLane(m3, 3, teams[0], 0); setLane(m3, 1, teams[1], 0); setLane(m3, 2, teams[2], 0); }
  if (m4) { setLane(m4, 1, teams[0], 0); setLane(m4, 2, teams[1], 0); setLane(m4, 3, teams[2], 0); }

  // Vueltas: warmup (cruce de salida) + normales + una exit + un pit-stop.
  let lapN = 0;
  const mkLap = (mangaId, teamId, lane, ms, flags = {}) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: teamId, driver_id: null,
    lane, lap_number: ++lapN, lap_time_ms: ms, elapsed_ms: lapN * ms,
    is_warmup: flags.warmup ? 1 : 0, is_exit: flags.exit ? 1 : 0, is_pit_stop: flags.pit ? 1 : 0,
  });

  const fillManga = (mangaId, laneByTeam, base) => {
    teams.forEach((tid, i) => {
      const lane = laneByTeam[i];
      mkLap(mangaId, tid, lane, 1200, { warmup: true });
      for (let k = 0; k < 8; k++) mkLap(mangaId, tid, lane, base + i * 150 + (k % 3) * 40);
      mkLap(mangaId, tid, lane, (base + i * 150) * 3, { pit: true });
      mkLap(mangaId, tid, lane, base + i * 150 + 2500, { exit: true });
    });
  };

  fillManga(m1, [1, 2, 3], 9000);
  fillManga(m2, [2, 3, 1], 9100);
  if (m3) {
    // Manga activa: solo warmup + unas pocas normales (menos del 60% recorrido
    // igualmente porque started_at es de 2020 → elapsed enorme, no provisional).
    teams.forEach((tid, i) => {
      const lane = [3, 1, 2][i];
      mkLap(m3, tid, lane, 1200, { warmup: true });
      for (let k = 0; k < 3; k++) mkLap(m3, tid, lane, 9050 + i * 120);
    });
  }

  return { raceId, teams, mangas: { m1, m2, m3, m4 } };
}

/** El módulo puro, standalone: sin instancia de TimingService, sin sus cachés. */
const puro = (raceId) => raceProjection.buildRaceProjection(raceId, { db, Lap });

/** La vía de TimingService (con sus cachés de mangas anteriores). */
const viaService = (raceId) => {
  TimingService.invalidateStandingsCaches();
  return TimingService.buildRaceProjection(raceId);
};

test('carrera TERMINADA: módulo puro === vía TimingService', () => {
  const { raceId } = seedRace();
  assert.deepEqual(puro(raceId), viaService(raceId));
});

test('carrera con manga ACTIVA + pendientes: módulo puro === vía TimingService', () => {
  const { raceId } = seedRace({ activeManga: true, withPending: true });
  // started_at de 2020 → elapsed gigante: activeRemMs=0, frac saturada a 0.99,
  // provisional=false. Determinista aunque las dos llamadas no sean simultáneas.
  assert.deepEqual(puro(raceId), viaService(raceId));
});

test('carrera SIN vueltas (equipos asignados, nada corrido): ambos devuelven las entidades con proyección null', () => {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES ('vacia', 'championship', 'team', 'pending', 2, '[1,2]', '[2]', 10)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  const tA = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'X').lastInsertRowid;
  const tB = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'Y').lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,1,?,0)').run(mId, tA);
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,2,?,0)').run(mId, tB);

  const p = puro(raceId);
  assert.deepEqual(p, viaService(raceId));
  assert.equal(p.length, 2);
  assert.ok(p.every(r => r.projectedRaw == null));
});

test('carrera inexistente → []', () => {
  assert.deepEqual(puro(999999), []);
  assert.deepEqual(viaService(999999), []);
});

test('el reloj se puede inyectar (deps.now) y cambia el restante de la manga activa', () => {
  const { raceId, mangas } = seedRace({ activeManga: true });
  // started_at "2020-01-01 00:20:00" UTC = 1577838000000 ms. Con now justo
  // 60 s después y duración 600 s, el restante debe ser 540 s para los de pista.
  const started = Date.parse('2020-01-01T00:20:00Z');
  const res = raceProjection.buildRaceProjection(raceId, { db, Lap, now: () => started + 60000 });
  const onTrack = res.filter(r => r.onTrack);
  assert.ok(onTrack.length > 0, 'hay entidades en pista en la manga activa');
  onTrack.forEach(r => assert.equal(r.remainingMs, 540000, `${r.name}: restante = 600s − 60s`));
  assert.ok(mangas.m3);
});
