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
// Media de carril = media SIMPLE de los tiempos de vuelta, igual que TicTac.
//
// El único cruce que NO se promedia es el parcial de salida (rejilla→línea,
// arranque desde parado): un artefacto sin tiempo de vuelta representativo. La
// PRIMERA VUELTA COMPLETA sí es ritmo real y DEBE entrar en la media y competir
// por mejor vuelta. Verificado al ms contra el export de TicTac de la carrera 90
// (test oscar victor, 20-jul-2026): descartarla de más dejaba la media ~14 ms
// por debajo de TicTac y una vuelta menos en el divisor.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga         = require('../src/models/Manga');
const MangaCircuit  = require('../src/models/MangaCircuit');
const Lap           = require('../src/models/Lap');
const SerialService = require('../src/services/SerialService');
const TimingService = require('../src/services/TimingService');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

const MIN = 60000;

function apagarTimers() {
  clearInterval(TimingService._tickInt);      TimingService._tickInt = null;
  clearTimeout(TimingService._autoStopTimer); TimingService._autoStopTimer = null;
  clearTimeout(TimingService._outageReconcileTimer); TimingService._outageReconcileTimer = null;
  if (TimingService.session) {
    Object.values(TimingService.session.circuits).forEach(c => {
      if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    });
  }
  TimingService._detachLapHandler();
  TimingService.session = null;
}

after(() => { apagarTimers(); limpiarBdTemporal(); });

beforeEach(() => {
  apagarTimers();
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

/** Un equipo, un carril, un circuito. */
function escenario() {
  const p = { nombre: 'Ana', id: crearPerfil('Ana') };
  crearEquipoCatalogo('E1', [p]);
  const { raceId, mangaId, teams } = crearCarreraConManga(
    [{ nombre: 'E1', pilotos: [p] }], { circuitsConfig: [1] });
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return { raceId, mangaId, race, manga, teams };
}

function darGo(e) {
  const lanes   = Manga.getLanes(e.mangaId);
  const teams   = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id);
  TimingService.startManga(e.manga, e.race, lanes, teams, drivers, 60 * MIN);
}

function cruce(lane, timestamp, lapTimeMs) {
  SerialService.emit('lane_crossing', { lane, timestamp, lapTimeMs, circuit: 0 });
}

// ── La 1ª vuelta completa cuenta; solo el parcial de salida se descarta ──────

test('la salida se descarta pero la 1ª vuelta completa entra en la media (= TicTac)', () => {
  const e = escenario();
  darGo(e);
  const t0 = TimingService.session.circuits[0].startTime;

  // Cruce de salida: el DS no reporta tiempo de vuelta (parcial rejilla→línea).
  cruce(1, t0 + 1196, null);
  // Vueltas completas, con tiempo del DS.
  let t = t0 + 1196;
  for (const ms of [12612, 12500, 12400]) { t += ms; cruce(1, t, ms); }

  const ld = TimingService.session.laneMap[1];
  assert.equal(ld.lapCount, 4, 'salida + 3 vueltas completas cuentan para el total');
  assert.equal(ld.avgLapCount, 3, 'las 3 completas entran en la media; la salida no');
  assert.equal(ld.lapAvgMs, (12612 + 12500 + 12400) / 3, 'media simple de las 3 completas');
  assert.equal(ld.bestLapMs, 12400, 'la 1ª vuelta completa compite por mejor vuelta (aquí no gana)');
});

// ── El mismo bug tras una recuperación: firstRealLapDone (no firstLapDone) ───

test('tras recuperar a media manga, la siguiente vuelta NO se marca warmup', () => {
  const e = escenario();
  darGo(e);
  // Salida + 2 completas ya en disco (como las dejaría el motor antes de morir).
  [[1, 1196, 1], [2, 12612, 0], [3, 12500, 0]].forEach(([lap_number, lap_time_ms, is_warmup]) =>
    Lap.create({
      race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
      lane: 1, lap_number, lap_time_ms, elapsed_ms: lap_number * 12000, is_warmup,
    }));
  TimingService._persistCircuits();
  apagarTimers();  // el proceso muere

  TimingService.rehydrateManga({
    manga: db.prepare('SELECT * FROM mangas WHERE id = ?').get(e.mangaId),
    race:  db.prepare('SELECT * FROM races  WHERE id = ?').get(e.raceId),
    lanes: Manga.getLanes(e.mangaId),
    teams: db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id),
    drivers: db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id),
    circuits: MangaCircuit.findByManga(e.mangaId),
    outageMs: 0,
  });

  const ld = TimingService.session.laneMap[1];
  assert.equal(ld.avgLapCount, 2, 'la salida no; las 2 completas sí');

  // Nueva vuelta tras recuperar: debe contar (firstRealLapDone quedó en true).
  const c0 = TimingService.session.circuits[0];
  cruce(1, c0.startTime + 40000, 12400);
  assert.equal(ld.avgLapCount, 3, 'la vuelta tras la recuperación entra en la media');
});
