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
// Paso 2 de la separación en hilos: `src/workers/statsWorker.js` calcula la
// proyección de carrera en un worker_thread con su propia conexión `readonly`.
// Este test comprueba que:
//   · el worker devuelve EXACTAMENTE lo mismo que el cálculo en el hilo principal
//     (el módulo puro de raceProjection, ya verificado en race-projection-engine),
//   · el protocolo de mensajes responde (ready / projection / ping / error),
//   · una carrera inexistente devuelve [] sin romper el worker.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
const DIR = usarBdTemporal();

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const raceProjection = require('../src/engine/raceProjection');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'workers', 'statsWorker.js');

let worker;
let _reqId = 0;

/** Envía un mensaje y resuelve con la primera respuesta que lleve ese reqId. */
function ask(payload, { timeout = 5000 } = {}) {
  const reqId = ++_reqId;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { cleanup(); reject(new Error('timeout esperando al worker')); }, timeout);
    const onMsg = (m) => {
      if (m && m.reqId === reqId) { cleanup(); resolve(m); }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    function cleanup() {
      clearTimeout(to);
      worker.off('message', onMsg);
      worker.off('error', onErr);
    }
    worker.on('message', onMsg);
    worker.on('error', onErr);
    worker.postMessage({ ...payload, reqId });
  });
}

/** Carrera de campeonato por equipos, 3 equipos, 2 mangas terminadas. */
function seedFinishedRace() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES ('w', 'championship', 'team', 'active', 3, '[1,2,3]', '[3]', 10)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const teams = ['Uno', 'Dos', 'Tres'].map(n =>
    db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, n).lastInsertRowid);

  const mk = (num) => {
    const id = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)').run(tandaId, raceId, num).lastInsertRowid;
    db.prepare("UPDATE mangas SET status='finished', started_at='2020-01-01 00:00:00', finished_at='2020-01-01 00:10:00', actual_duration_ms=600000 WHERE id=?").run(id);
    return id;
  };
  const m1 = mk(1), m2 = mk(2);
  const lane = [[1, 2, 3], [3, 1, 2]];
  [m1, m2].forEach((mid, mi) => {
    teams.forEach((tid, ti) => {
      const ln = lane[mi][ti];
      db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,?,?,0,?)').run(mid, ln, tid, 0.1 * (ti + 1));
      let n = mi * 100 + ti * 20;
      Lap.create({ race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: ln, lap_number: ++n, lap_time_ms: 1200, elapsed_ms: 1200, is_warmup: 1 });
      for (let k = 0; k < 6; k++) Lap.create({ race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: ln, lap_number: ++n, lap_time_ms: 9000 + ti * 200 + k * 30, elapsed_ms: n * 9000 });
    });
  });
  return raceId;
}

before(() => {
  worker = new Worker(WORKER_PATH, { env: { ...process.env, PITWALL_DATA: DIR } });
  worker.unref();   // que no impida salir a node --test
});

after(async () => {
  if (worker) await worker.terminate();
  limpiarBdTemporal();
});

test('el worker emite { type: "ready" } al arrancar', async () => {
  const ready = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no llegó ready')), 5000);
    worker.once('message', (m) => { clearTimeout(to); resolve(m); });
  });
  assert.equal(ready.type, 'ready');
});

test('ping → pong', async () => {
  const r = await ask({ type: 'ping' });
  assert.equal(r.type, 'pong');
});

test('projection: el worker devuelve lo MISMO que el cálculo en el hilo principal', async () => {
  const raceId = seedFinishedRace();
  const enHilo = raceProjection.buildRaceProjection(raceId, { db, Lap });

  const r = await ask({ type: 'projection', raceId });
  assert.equal(r.type, 'projection');
  assert.equal(r.raceId, raceId);
  assert.ok(typeof r.ms === 'number');
  assert.ok(Array.isArray(r.value) && r.value.length === 3);
  assert.deepEqual(r.value, enHilo);
});

test('projection de una carrera inexistente → [] (sin romper el worker)', async () => {
  const r = await ask({ type: 'projection', raceId: 987654 });
  assert.equal(r.type, 'projection');
  assert.deepEqual(r.value, []);
  // el worker sigue vivo:
  const p = await ask({ type: 'ping' });
  assert.equal(p.type, 'pong');
});

test('tipo de mensaje desconocido → { type: "error" }', async () => {
  const r = await ask({ type: 'no-existe' });
  assert.equal(r.type, 'error');
  assert.match(r.error, /desconocido/);
});

test('invalidate no responde pero el worker sigue sirviendo', async () => {
  worker.postMessage({ type: 'invalidate' });
  const r = await ask({ type: 'ping' });
  assert.equal(r.type, 'pong');
});
