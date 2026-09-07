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
// Paso 4d: los agregados race-wide de live-stats (la parte cara, ~250 ms sobre
// 150.000 vueltas) se sacaron de `LiveStatsController.json` a
// `src/engine/raceWideStats.js` y se calculan en el worker de stats. Este test
// fija: el módulo puro produce lo esperado, el worker devuelve EXACTAMENTE lo
// mismo, y el controlador sirve el mismo `entities`/`projection` con y sin worker.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
const DIR = usarBdTemporal();
delete process.env.PITWALL_NO_WORKER;

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const raceWideStats = require('../src/engine/raceWideStats');
const StatsWorkerClient = require('../src/services/StatsWorkerClient');
const LiveStatsController = require('../src/controllers/LiveStatsController');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'workers', 'statsWorker.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

after(async () => { await StatsWorkerClient.stop(); limpiarBdTemporal(); });

function seedRace() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes, min_lap_ms)
    VALUES ('rw', 'championship', 'team', 'active', 3, '[1,2,3]', '[3]', 10, 4000)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const teams = ['Alfa', 'Bravo', 'Charlie'].map(n =>
    db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, n).lastInsertRowid);

  const mk = (num, status) => {
    const id = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)').run(tandaId, raceId, num).lastInsertRowid;
    db.prepare('UPDATE mangas SET status=?, started_at=?, actual_duration_ms=600000 WHERE id=?')
      .run(status, status === 'finished' ? '2020-01-01 00:00:00' : '2020-01-01 00:20:00', id);
    if (status === 'finished') db.prepare("UPDATE mangas SET finished_at='2020-01-01 00:10:00' WHERE id=?").run(id);
    return id;
  };
  const m1 = mk(1, 'finished'), m2 = mk(2, 'finished'), m3 = mk(3, 'active');
  let n = 0;
  [[m1, [1, 2, 3]], [m2, [3, 1, 2]], [m3, [2, 3, 1]]].forEach(([mid, lanes]) => {
    teams.forEach((tid, i) => {
      const ln = lanes[i];
      db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,?,?,0)').run(mid, ln, tid);
      Lap.create({ race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: ln, lap_number: ++n, lap_time_ms: 1200, elapsed_ms: 1200, is_warmup: 1 });
      for (let k = 0; k < 9; k++) {
        const exit = k === 4;
        Lap.create({
          race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: ln,
          lap_number: ++n, lap_time_ms: exit ? 22000 : 9000 + i * 250 + (k % 3) * 60,
          elapsed_ms: 20000 + k * 9000, is_exit: exit ? 1 : 0,
        });
      }
    });
  });
  return { raceId, m3, teams };
}

// Normaliza el bundle (Maps → objetos ordenados) para comparar.
function norm(b) {
  const m2o = (m) => Object.fromEntries([...m.entries()].sort());
  return {
    raceByKey: m2o(b.raceByKey),
    raceConsByKey: m2o(b.raceConsByKey),
    raceConsAllByKey: m2o(b.raceConsAllByKey),
    raceExitTimesByKey: m2o(b.raceExitTimesByKey),
    raceProgress: b.raceProgress,
  };
}

test('el módulo puro produce los agregados esperados', () => {
  const { raceId } = seedRace();
  const b = raceWideStats.build(raceId, { db, minLapMs: 4000 });
  assert.equal(b.raceByKey.size, 3);
  for (const [, r] of b.raceByKey) {
    assert.equal(r.total_laps, 30, '10 vueltas × 3 mangas');
    assert.equal(r.exits, 3, 'una salida por manga');
    assert.equal(r.mangas_raced, 3);
    assert.ok(r.pace_all_ms > 0 && r.best_ms >= 4000);
  }
  assert.deepEqual(b.raceProgress.mangas, [1, 2, 3]);
  assert.equal(b.raceExitTimesByKey.get('team_' + [...b.raceByKey.keys()][0].split('_')[1]) === undefined, false);
});

test('minLapMs se respeta (una vuelta por debajo del mínimo no cuenta como best)', () => {
  const { raceId, m3, teams } = seedRace();
  // vuelta rapidísima pero por debajo del min_lap_ms (4000) → ignorada para best
  Lap.create({ race_id: raceId, manga_id: m3, team_id: teams[0], driver_id: null, lane: 2, lap_number: 999, lap_time_ms: 1500, elapsed_ms: 500000 });
  const b = raceWideStats.build(raceId, { db, minLapMs: 4000 });
  const r = b.raceByKey.get('team_' + teams[0]);
  assert.ok(r.best_ms >= 4000, 'la vuelta de 1500 ms no puede ser la mejor');
});

// ── Worker ────────────────────────────────────────────────────────────────

test('el worker devuelve EXACTAMENTE lo mismo que el módulo en el hilo', async () => {
  const { raceId } = seedRace();
  const enHilo = raceWideStats.build(raceId, { db, minLapMs: 4000 });

  const worker = new Worker(WORKER_PATH, { env: { ...process.env, PITWALL_DATA: DIR } });
  worker.unref();
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('no ready')), 5000);
      worker.once('message', (m) => { clearTimeout(to); res(m); });
    });
    const got = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), 5000);
      worker.on('message', (m) => { if (m.type === 'raceWide' && m.reqId === 1) { clearTimeout(to); res(m); } });
      worker.postMessage({ type: 'raceWide', reqId: 1, raceId, minLapMs: 4000 });
    });
    assert.equal(got.raceId, raceId);
    assert.deepEqual(norm(got.value), norm(enHilo));
  } finally {
    await worker.terminate();
  }
});

// ── Controlador ───────────────────────────────────────────────────────────

test('LiveStatsController._raceWideBundle: mismo resultado con y sin worker', async () => {
  const { raceId, m3 } = seedRace();
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id=?').get(m3);

  LiveStatsController._resetCache();
  // Sin worker aún (no arrancado): calcula en el hilo.
  assert.equal(StatsWorkerClient.available, false);
  const sinWorker = norm(LiveStatsController._raceWideBundle(race, manga.number, true));

  // Con worker.
  const ok = await StatsWorkerClient.whenReady(5000);
  assert.equal(ok, true);
  LiveStatsController._resetCache();
  // 1ª llamada en frío → hilo; envejecemos y forzamos la vía worker.
  LiveStatsController._raceWideBundle(race, manga.number, true);
  const c = require('../src/controllers/LiveStatsController');
  // segunda llamada: rancia → pide al worker y sirve la de antes; esperamos y comprobamos
  await sleep(400);
  const conWorker = norm(LiveStatsController._raceWideBundle(race, manga.number, true));
  assert.deepEqual(conWorker, sinWorker);
  assert.ok(c);
});
