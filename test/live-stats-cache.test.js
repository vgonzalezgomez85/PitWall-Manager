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
// La vista de estadísticas en vivo costaba ~259 ms y 213 KB POR PETICIÓN sobre las
// 160.000 vueltas de una 24 h, y el cliente la repedía en CADA cruce: ~500 ms de
// CPU por segundo por cada espectador con la página abierta. Dos pantallas puestas
// y el proceso —un hilo, better-sqlite3 síncrono— se quedaba sin aire, retrasando
// el tick y el procesado del serie.
//
// Ahora la respuesta se cachea. Como siempre, lo que hay que probar de una caché
// no es que sea rápida: es que no sirva un valor rancio.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db                  = require('../src/config/database');
const Lap                 = require('../src/models/Lap');
const TimingService       = require('../src/services/TimingService');
const LiveStatsController = require('../src/controllers/LiveStatsController');
const MobileController    = require('../src/controllers/MobileController');

after(limpiarBdTemporal);

beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'teams', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
  TimingService.session = null;
  TimingService.invalidateStandingsCaches();
  LiveStatsController._resetCache();
  MobileController._resetCache();
});

/** Respuesta de LiveStatsController.json con req/res de mentira. */
function pedirJson(raceId, mangaId) {
  let payload = null, status = 200;
  const req = { params: { id: String(raceId) }, query: { mangaId: String(mangaId) } };
  const res = {
    json(p) { payload = p; return res; },
    status(s) { status = s; return res; },
  };
  LiveStatsController.json(req, res);
  return { payload, status };
}

function escenario({ activa = false } = {}) {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('stats', 'club', 'team', 'active', 2, '[1,2]', '[2]', 10, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, 1, ?)')
    .run(tandaId, raceId, activa ? 'active' : 'finished').lastInsertRowid;
  if (activa) db.prepare('UPDATE mangas SET started_at = ? WHERE id = ?').run(new Date().toISOString(), mangaId);

  const equipos = ['Alfa', 'Beta'].map((n, i) => {
    const id = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, 0, ?)')
      .run(raceId, tandaId, n, '#00' + i + '000').lastInsertRowid;
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, ?, ?, 0, 0)')
      .run(mangaId, i + 1, id);
    return id;
  });

  let n = 0;
  equipos.forEach((teamId, ti) => {
    for (let i = 0; i < 5; i++) {
      Lap.create({ race_id: raceId, manga_id: mangaId, team_id: teamId, driver_id: null,
        lane: ti + 1, lap_number: ++n, lap_time_ms: 9000 + ti * 100 + i, elapsed_ms: n * 9000 });
    }
  });
  return { raceId, mangaId, equipos };
}

// ── La caché de la respuesta ─────────────────────────────────────────────────

test('con la manga acabada, la respuesta se sirve de caché sin recalcular', () => {
  const e = escenario();
  const primera = pedirJson(e.raceId, e.mangaId);
  assert.equal(primera.status, 200);
  assert.ok(primera.payload.entities.length > 0);

  let recalculos = 0;
  const original = TimingService._cachedProjection.bind(TimingService);
  TimingService._cachedProjection = (id) => { recalculos++; return original(id); };
  try {
    const segunda = pedirJson(e.raceId, e.mangaId);
    assert.equal(segunda.payload, primera.payload, 'el mismo objeto: no se rehízo nada');
  } finally { TimingService._cachedProjection = original; }

  assert.equal(recalculos, 0, 'una manga acabada no se recalcula nunca más');
});

test('una corrección SÍ invalida la respuesta de una manga acabada', () => {
  const e = escenario();
  const antes = pedirJson(e.raceId, e.mangaId).payload;

  const id = db.prepare('SELECT id FROM laps ORDER BY id DESC LIMIT 1').get().id;
  Lap.markGhost(id);                      // el juez anula una vuelta

  const despues = pedirJson(e.raceId, e.mangaId).payload;
  assert.notEqual(despues, antes, 'no puede servir la respuesta vieja');
  const lapsAntes   = antes.entities.reduce((s, x) => s + x.totalLaps, 0);
  const lapsDespues = despues.entities.reduce((s, x) => s + x.totalLaps, 0);
  assert.equal(lapsDespues, lapsAntes - 1, 'la vuelta anulada desaparece');
});

test('cada manga tiene su propia entrada en la caché', () => {
  const e = escenario();
  const otraManga = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status) VALUES ((SELECT id FROM tandas WHERE race_id=?), ?, 2, ?)')
    .run(e.raceId, e.raceId, 'finished').lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, 1, ?, 0, 0)')
    .run(otraManga, e.equipos[0]);
  Lap.create({ race_id: e.raceId, manga_id: otraManga, team_id: e.equipos[0], driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 7777, elapsed_ms: 7777 });

  const m1 = pedirJson(e.raceId, e.mangaId).payload;
  const m2 = pedirJson(e.raceId, otraManga).payload;
  assert.equal(m1.mangaId, e.mangaId);
  assert.equal(m2.mangaId, otraManga, 'pedir otra manga no devuelve la cacheada de la primera');
  assert.notEqual(m1.entities.length, 0);
});

// Ojo: "manga en curso" para la caché significa que ESTE proceso la está
// cronometrando (hay sesión en memoria), no que la BD la tenga en 'active'. Es la
// distinción que toca: sin sesión no llegan cruces, así que lo único que puede
// cambiar los datos es una corrección — y ésa sí debe verse al instante.
test('con la manga EN CURSO la caché caduca por reloj, no por cada cruce', () => {
  const e = escenario({ activa: true });
  const race  = db.prepare('SELECT * FROM races WHERE id = ?').get(e.raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(e.mangaId);
  TimingService.session = {
    race, manga, laneMap: {}, laneToCircuit: {}, startTime: Date.now() - 60000,
    durationMs: 600000, circuits: [{ index: 0, status: 'running', startTime: Date.now() - 60000 }],
  };

  const primera = pedirJson(e.raceId, e.mangaId).payload;
  assert.equal(primera.isActive, true, 'el fixture tiene sesión viva de verdad');

  // Un cruce nuevo NO debe rehacer la vista: rehacerla cuesta 200 ms y llegan
  // 2-3 cruces por segundo — sería exactamente el problema que se vino a evitar.
  Lap.create({ race_id: e.raceId, manga_id: e.mangaId, team_id: e.equipos[0], driver_id: null,
    lane: 1, lap_number: 99, lap_time_ms: 8888, elapsed_ms: 99000 });
  assert.equal(pedirJson(e.raceId, e.mangaId).payload, primera,
    'dentro del segundo, el mismo objeto aunque hayan entrado cruces');
});

// ── El dossier de resultados del móvil ───────────────────────────────────────

test('buildStatsSnapshot se cachea: 100 móviles piden resultados y se calcula una vez', () => {
  const e = escenario();
  const primero = MobileController.buildStatsSnapshot(e.raceId);
  assert.ok(primero.standings.length > 0);

  let recalculos = 0;
  const original = TimingService.raceAggregate.bind(TimingService);
  TimingService.raceAggregate = (id) => { recalculos++; return original(id); };
  try {
    for (let i = 0; i < 100; i++) MobileController.buildStatsSnapshot(e.raceId);
  } finally { TimingService.raceAggregate = original; }

  assert.equal(recalculos, 0, '100 peticiones, 0 agregados: se reparte el mismo dossier');
});

test('el dossier se refresca si alguien corrige una vuelta', () => {
  const e = escenario();
  const antes = MobileController.buildStatsSnapshot(e.raceId).standings
    .reduce((s, x) => s + x.totalLaps, 0);

  const id = db.prepare('SELECT id FROM laps ORDER BY id DESC LIMIT 1').get().id;
  Lap.markGhost(id);

  const despues = MobileController.buildStatsSnapshot(e.raceId).standings
    .reduce((s, x) => s + x.totalLaps, 0);
  assert.equal(despues, antes - 1, 'la caché no puede esconder una corrección');
});

test('las vueltas de carriles sin equipo no salen como líder en los resultados del móvil', () => {
  const e = escenario();
  // Carril sin equipo asignado dando muchas vueltas: el agregado las junta en una
  // fila con entidad nula. Sin filtrar, salía la primera y falseaba el gap.
  for (let i = 0; i < 50; i++) {
    Lap.create({ race_id: e.raceId, manga_id: e.mangaId, team_id: null, driver_id: null,
      lane: 8, lap_number: i + 1, lap_time_ms: 5000, elapsed_ms: i * 5000 });
  }
  const snap = MobileController.buildStatsSnapshot(e.raceId);
  assert.ok(snap.standings.every(s => s.entityId != null && s.name != null),
    'ninguna fila sin entidad se cuela en la clasificación');
  assert.equal(snap.standings[0].name, 'Alfa', 'el líder es un equipo de verdad');
  assert.equal(snap.standings[0].gapLaps, 0);
});
