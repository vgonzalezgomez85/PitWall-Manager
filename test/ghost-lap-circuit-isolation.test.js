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
// Con varios circuitos (agrupador DS-300 o multi-Master BART) los carriles de
// cada circuito son físicamente independientes. Un fantasma detectado en un
// carril de un circuito NUNCA debe certificarse/asignarse a un carril de OTRO
// circuito, aunque un cruce 2× "encaje" por ventana de tiempo — están en
// pistas separadas. Solo se puede certificar dentro del MISMO circuito.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga         = require('../src/models/Manga');
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

// 2 circuitos de 2 carriles cada uno: carriles 1-2 → circuito 0, carriles 3-4 → circuito 1.
function escenario({ minLapMs = 5000 } = {}) {
  const equipos = ['E1', 'E2', 'E3', 'E4'].map(nombre => {
    const p = { nombre: `${nombre}-piloto`, id: crearPerfil(`${nombre}-piloto`) };
    crearEquipoCatalogo(nombre, [p]);
    return { nombre, pilotos: [p] };
  });
  const { raceId, mangaId } = crearCarreraConManga(equipos, { circuitsConfig: [2, 2] });
  db.prepare('UPDATE races SET min_lap_ms = ? WHERE id = ?').run(minLapMs, raceId);
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return { raceId, mangaId, race, manga };
}

function darGo(e) {
  const lanes   = Manga.getLanes(e.mangaId);
  const teams   = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id);
  TimingService.startManga(e.manga, e.race, lanes, teams, drivers, 60 * MIN);
}

function cruce(lane, timestamp, lapTimeMs, circuit) {
  SerialService.emit('lane_crossing', { lane, timestamp, lapTimeMs, circuit });
}

test('un fantasma NO se certifica en un carril de otro circuito (2× espuria en circuito distinto)', () => {
  const e = escenario();
  darGo(e);
  const t0 = TimingService.session.circuits[0].startTime;
  const t1 = TimingService.session.circuits[1].startTime;

  // Salidas de los 4 carriles (parciales, sin tiempo de vuelta).
  cruce(1, t0 + 1000, null, 0);
  cruce(2, t0 + 1000, null, 0);
  cruce(3, t1 + 1000, null, 1);
  cruce(4, t1 + 1000, null, 1);

  let t;

  // Carril 1 (circuito 0) rueda normal para tener una media de referencia.
  t = t0 + 1000;
  for (const ms of [12000, 12000, 12000]) { t += ms; cruce(1, t, ms, 0); }

  // Carril 3 (circuito 1) rueda normal para tener su propia media.
  let t3 = t1 + 1000;
  for (const ms of [12000, 12000, 12000]) { t3 += ms; cruce(3, t3, ms, 1); }

  // Carril 2 (circuito 0) genera un fantasma: cruce por debajo del Pt.
  t += 100;
  cruce(2, t, 3000, 0); // 3000ms < minLapMs (5000ms) → fantasma retenido, circuito 0

  const ghostRow = db.prepare('SELECT * FROM laps WHERE is_ghost = 1 AND lane = 2').get();
  assert.ok(ghostRow, 'el fantasma debe quedar persistido en el carril 2 (circuito 0)');

  // Carril 4 (circuito 1, DISTINTO al del fantasma) cruza con una vuelta ~2×
  // su media (23000 ~ 2x12000): sin el fix, esto certificaría y robaría el
  // fantasma del carril 2 (circuito 0) aunque estén en pistas separadas.
  t3 += 23500;
  cruce(4, t3, 23500, 1);

  const ghostAfter = db.prepare('SELECT * FROM laps WHERE id = ?').get(ghostRow.id);
  assert.equal(ghostAfter.is_ghost, 1, 'el fantasma del circuito 0 NO debe certificarse desde un carril del circuito 1');

  const transferredToLane4 = db.prepare('SELECT * FROM laps WHERE source_lap_id = ? AND lane = 4').get(ghostRow.id);
  assert.equal(transferredToLane4, undefined, 'no debe haberse creado ninguna vuelta transferida al carril 4');
});

test('un fantasma SÍ se certifica en otro carril del MISMO circuito', () => {
  const e = escenario();
  darGo(e);
  const t0 = TimingService.session.circuits[0].startTime;

  cruce(1, t0 + 1000, null, 0);
  cruce(2, t0 + 1000, null, 0);

  let t = t0 + 1000;
  for (const ms of [12000, 12000, 12000]) { t += ms; cruce(1, t, ms, 0); }

  // Carril 2 (mismo circuito 0) genera el fantasma.
  t += 100;
  cruce(2, t, 3000, 0);
  const ghostRow = db.prepare('SELECT * FROM laps WHERE is_ghost = 1 AND lane = 2').get();
  assert.ok(ghostRow);

  // Carril 1 (mismo circuito 0) cruza con vuelta ~2× su media → certifica.
  t += 23500;
  cruce(1, t, 23500, 0);

  const ghostAfter = db.prepare('SELECT * FROM laps WHERE id = ?').get(ghostRow.id);
  assert.equal(ghostAfter.is_ghost, 1, 'la fila original del fantasma queda marcada is_ghost tras certificarse');

  const transferred = db.prepare('SELECT * FROM laps WHERE source_lap_id = ? AND lane = 1').get(ghostRow.id);
  assert.ok(transferred, 'debe haberse creado la vuelta transferida al carril 1 (mismo circuito)');
});
