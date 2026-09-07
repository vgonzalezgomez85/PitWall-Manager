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
// Paso 4: TimingService delega el cálculo caro de la proyección en el worker de
// stats. Se comprueba que:
//   · `_cachedProjection` con el worker disponible NO calcula en el hilo cuando
//     ya hay una entrada cacheada — sirve esa y pide refresco al worker,
//   · el refresco del worker rellena `_projCache` con el MISMO resultado que el
//     cálculo en el hilo,
//   · sin worker, el comportamiento es el de siempre (cálculo síncrono),
//   · `invalidateStandingsCaches()` avisa al worker.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();
delete process.env.PITWALL_NO_WORKER;   // este test SÍ quiere el worker real

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const raceProjection = require('../src/engine/raceProjection');
const TimingService = require('../src/services/TimingService');
const StatsWorkerClient = require('../src/services/StatsWorkerClient');

after(async () => { await StatsWorkerClient.stop(); limpiarBdTemporal(); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function seedActiveRace() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES ('pw4', 'championship', 'team', 'active', 2, '[1,2]', '[2]', 10)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  // Una manga TERMINADA + una ACTIVA (started_at en el pasado lejano → restante 0,
  // resultado determinista aunque el worker y el hilo no midan a la vez).
  const m1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='finished', started_at='2020-01-01 00:00:00', finished_at='2020-01-01 00:10:00', actual_duration_ms=600000 WHERE id=?").run(m1);
  const m2 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 2)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='active', started_at='2020-01-01 00:20:00', actual_duration_ms=600000 WHERE id=?").run(m2);

  const teams = ['A', 'B'].map(n => db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, n).lastInsertRowid);
  let k = 0;
  [[m1, [1, 2]], [m2, [2, 1]]].forEach(([mid, lanes]) => {
    teams.forEach((tid, i) => {
      db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,?,?,0,?)').run(mid, lanes[i], tid, 0.2 * (i + 1));
      Lap.create({ race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: lanes[i], lap_number: ++k, lap_time_ms: 1200, elapsed_ms: 1200, is_warmup: 1 });
      for (let j = 0; j < 6; j++) Lap.create({ race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: lanes[i], lap_number: ++k, lap_time_ms: 9000 + i * 350 + j * 25, elapsed_ms: k * 9000 });
    });
  });
  return raceId;
}

before(() => {
  TimingService.session = null;
  TimingService.invalidateStandingsCaches();
});

test('sin worker: _cachedProjection calcula en el hilo (comportamiento de siempre)', () => {
  const raceId = seedActiveRace();
  assert.equal(StatsWorkerClient.available, false);
  const got = TimingService._cachedProjection(raceId);
  assert.deepEqual(got, raceProjection.buildRaceProjection(raceId, { db, Lap }));
  assert.ok(TimingService._projCache.get(raceId), 'la caché queda poblada');
});

test('_warmStatsCaches (pre-calentado en el GO): deja listas las cachés síncronas', () => {
  const raceId = seedActiveRace();
  const manga = db.prepare("SELECT id FROM mangas WHERE race_id=? AND status='active'").get(raceId);
  TimingService.invalidateStandingsCaches();           // deja _priorCache vacío
  TimingService.session = { race: { id: raceId, min_lap_ms: 0 }, manga: { id: manga.id } };
  const mutBefore = Lap.mutationCount;

  TimingService._warmStatsCaches();

  assert.ok(TimingService._priorCache.get(raceId), '_priorAggregates queda cacheado');
  const settled1 = Lap.startSettledByEntity(raceId);
  // 1er cruce de la manga activa tras el warm: NO re-invalida (noteMangaSeen)
  Lap.create({ race_id: raceId, manga_id: manga.id, team_id: db.prepare('SELECT id FROM teams WHERE race_id=? LIMIT 1').get(raceId).id, driver_id: null, lane: 2, lap_number: 9999, lap_time_ms: 9000, elapsed_ms: 999999 });
  assert.strictEqual(Lap.startSettledByEntity(raceId), settled1, 'la caché de settled aguanta el 1er cruce');
  assert.equal(Lap.mutationCount, mutBefore + 1, 'solo el Lap.create cuenta como mutación (noteMangaSeen no)');
  TimingService.session = null;
});

test('con worker: sirve la caché y el refresco del worker la actualiza con el mismo resultado', async () => {
  const raceId = seedActiveRace();
  const esperado = raceProjection.buildRaceProjection(raceId, { db, Lap });

  const ready = await StatsWorkerClient.whenReady(5000);
  assert.equal(ready, true);

  // 1ª llamada en frío: calcula en hilo y cachea.
  TimingService.invalidateStandingsCaches();
  const first = TimingService._cachedProjection(raceId);
  assert.deepEqual(first, esperado);

  // Envejecemos la entrada para forzar la rama "rancio + pide al worker".
  const entry = TimingService._projCache.get(raceId);
  entry.ts = Date.now() - 10_000;

  const served = TimingService._cachedProjection(raceId);
  assert.deepEqual(served, esperado, 'sirve la última buena mientras llega la del worker');

  // El worker responde y refresca la caché (ts nuevo, mismo valor).
  await sleep(300);
  const refreshed = TimingService._projCache.get(raceId);
  assert.ok(Date.now() - refreshed.ts < 2000, 'el worker actualizó la entrada');
  assert.deepEqual(refreshed.value, esperado);
});

test('peticiones repetidas mientras hay una en vuelo no se apilan', async () => {
  const raceId = seedActiveRace();
  await StatsWorkerClient.whenReady(5000);
  TimingService.invalidateStandingsCaches();
  TimingService._cachedProjection(raceId);           // cachea
  TimingService._projCache.get(raceId).ts = 0;        // rancio

  for (let i = 0; i < 20; i++) TimingService._cachedProjection(raceId);
  assert.equal(TimingService._projRefresh.get(raceId).inFlight, true, 'una sola en vuelo');
  await sleep(300);
  assert.equal(TimingService._projRefresh.get(raceId).inFlight, false);
});

test('invalidateStandingsCaches avisa al worker (invalidate) y limpia _projRefresh', async () => {
  await StatsWorkerClient.whenReady(5000);
  let called = 0;
  const orig = StatsWorkerClient.invalidate.bind(StatsWorkerClient);
  StatsWorkerClient.invalidate = () => { called++; orig(); };
  try {
    TimingService.invalidateStandingsCaches();
    assert.equal(called, 1);
    assert.equal(TimingService._projRefresh.size, 0);
  } finally {
    StatsWorkerClient.invalidate = orig;
  }
});
