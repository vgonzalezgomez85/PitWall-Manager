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
// Paso 3: `StatsWorkerClient` envuelve al worker de stats con:
//   · casado de peticiones/respuestas por reqId,
//   · fallback a cálculo EN HILO cuando el worker no está o PITWALL_NO_WORKER=1,
//   · re-arranque si el worker muere.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const raceProjection = require('../src/engine/raceProjection');
const client = require('../src/services/StatsWorkerClient');
const ClientClass = Object.getPrototypeOf(client).constructor;

after(async () => { await client.stop(); limpiarBdTemporal(); });

function seedRace(name, spread) {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES (?, 'championship', 'team', 'active', 2, '[1,2]', '[2]', 10)
  `).run(name).lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='finished', started_at='2020-01-01 00:00:00', finished_at='2020-01-01 00:10:00', actual_duration_ms=600000 WHERE id=?").run(mId);
  ['A', 'B'].forEach((n, i) => {
    const tid = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, name + n).lastInsertRowid;
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,?,?,0,0)').run(mId, i + 1, tid);
    let k = i * 50;
    Lap.create({ race_id: raceId, manga_id: mId, team_id: tid, driver_id: null, lane: i + 1, lap_number: ++k, lap_time_ms: 1200, elapsed_ms: 1200, is_warmup: 1 });
    for (let j = 0; j < 5; j++) Lap.create({ race_id: raceId, manga_id: mId, team_id: tid, driver_id: null, lane: i + 1, lap_number: ++k, lap_time_ms: 9000 + i * spread + j * 20, elapsed_ms: k * 9000 });
  });
  return raceId;
}

// ── Modo deshabilitado (PITWALL_NO_WORKER) ──────────────────────────────────

test('con PITWALL_NO_WORKER: available=false y requestProjection calcula en hilo', async () => {
  const prev = process.env.PITWALL_NO_WORKER;
  process.env.PITWALL_NO_WORKER = '1';
  const off = new ClientClass();
  process.env.PITWALL_NO_WORKER = prev;

  const raceId = seedRace('off', 300);
  assert.equal(off.available, false);
  off.start();                       // no-op
  assert.equal(off._worker, null);
  off.invalidate();                  // no-op, no lanza

  const got = await off.requestProjection(raceId, { db, Lap });
  assert.deepEqual(got, raceProjection.buildRaceProjection(raceId, { db, Lap }));
  assert.equal(await off.whenReady(100), false);
});

// ── Con worker real ────────────────────────────────────────────────────────

before(async () => {
  const ok = await client.whenReady(5000);
  assert.equal(ok, true, 'el worker debería estar listo');
});

test('available=true tras whenReady', () => {
  assert.equal(client.available, true);
});

test('requestProjection por el worker === cálculo en hilo', async () => {
  const raceId = seedRace('w1', 400);
  const viaWorker = await client.requestProjection(raceId, { db, Lap });
  assert.deepEqual(viaWorker, raceProjection.buildRaceProjection(raceId, { db, Lap }));
});

test('peticiones concurrentes se casan con su respuesta (reqId)', async () => {
  const r1 = seedRace('c1', 100);
  const r2 = seedRace('c2', 700);
  const r3 = seedRace('c3', 1300);
  const [p1, p2, p3] = await Promise.all([
    client.requestProjection(r1, { db, Lap }),
    client.requestProjection(r2, { db, Lap }),
    client.requestProjection(r3, { db, Lap }),
  ]);
  assert.deepEqual(p1, raceProjection.buildRaceProjection(r1, { db, Lap }));
  assert.deepEqual(p2, raceProjection.buildRaceProjection(r2, { db, Lap }));
  assert.deepEqual(p3, raceProjection.buildRaceProjection(r3, { db, Lap }));
  assert.notDeepEqual(p1, p2);
});

test('si el worker muere, requestProjection sigue resolviendo (en hilo) y re-arranca', async () => {
  const raceId = seedRace('recycle', 250);
  assert.equal(client.available, true);

  client._recycle();                 // simula caída
  assert.equal(client.available, false);

  const got = await client.requestProjection(raceId, { db, Lap });
  assert.deepEqual(got, raceProjection.buildRaceProjection(raceId, { db, Lap }));

  const back = await client.whenReady(5000);
  assert.equal(back, true, 'el cliente re-arranca el worker');
});

test('invalidate no lanza aunque el worker esté ocupado', async () => {
  const raceId = seedRace('inv', 200);
  client.invalidate();
  const got = await client.requestProjection(raceId, { db, Lap });
  assert.equal(got.length, 2);
});
