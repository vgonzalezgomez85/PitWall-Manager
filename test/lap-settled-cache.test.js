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
// Paso 4b: la caché de `Lap.startSettledByEntity` se invalidaba con `_mutTotal`
// (cualquier escritura en `laps`), así que su escaneo de toda la carrera (~57 ms
// en una 24 h) se repetía en CADA cruce. Ahora solo se invalida si una mutación
// puede afectar de verdad a la corrección de salida (que solo depende de la 1ª
// manga de cada entidad). Este test fija tanto la corrección (mismo resultado)
// como que la caché aguanta los cruces a mangas posteriores.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');

after(limpiarBdTemporal);
beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'teams', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
  Lap.markExternalMutation();   // fuerza recálculo entre tests (BD nueva)
});

function seed() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes)
    VALUES ('sc', 'championship', 'team', 'active', 2, '[1,2]', '[2]', 10)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const m1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='finished', actual_duration_ms=600000 WHERE id=?").run(m1);
  const m2 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 2)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='active', actual_duration_ms=600000 WHERE id=?").run(m2);
  const A = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'A').lastInsertRowid;
  const B = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'B').lastInsertRowid;
  [[m1, [1, 2]], [m2, [2, 1]]].forEach(([mid, ln]) => {
    [A, B].forEach((tid, i) => db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,?,?,0)').run(mid, ln[i], tid));
  });
  // Manga 1: warmup (cruce de salida, inflado) + vueltas normales en el 1er 60%.
  let n = 0;
  [A, B].forEach((tid, i) => {
    Lap.create({ race_id: raceId, manga_id: m1, team_id: tid, driver_id: null, lane: i + 1, lap_number: ++n, lap_time_ms: 1500, elapsed_ms: 1500, is_warmup: 1 });
    for (let k = 0; k < 5; k++) Lap.create({ race_id: raceId, manga_id: m1, team_id: tid, driver_id: null, lane: i + 1, lap_number: ++n, lap_time_ms: 9000 + i * 300, elapsed_ms: 20000 + k * 9000 });
  });
  return { raceId, m1, m2, A, B };
}

const snap = (map) => [...map.entries()].map(([k, v]) => [k, v.firstMangaId, v.warmupMs, Math.round(v.settledAvg ?? -1), Math.round(v.delta)]).sort();

test('la corrección es la misma que recalculando en cada cambio', () => {
  const { raceId, m2, A } = seed();
  const base = snap(Lap.startSettledByEntity(raceId));
  assert.equal(base.length, 2);
  assert.ok(base.every(r => r[4] !== 0), 'hay delta (settledAvg − warmup) en las dos entidades');

  // Cruces en la manga 2 (posterior): no cambian la corrección de salida.
  let n = 500;
  for (let k = 0; k < 8; k++) {
    Lap.create({ race_id: raceId, manga_id: m2, team_id: A, driver_id: null, lane: 1, lap_number: ++n, lap_time_ms: 9500, elapsed_ms: k * 9500 });
    assert.deepEqual(snap(Lap.startSettledByEntity(raceId)), base, 'un cruce a la manga 2 no toca la corrección');
  }
});

test('la caché devuelve la MISMA instancia mientras solo entran cruces a mangas ya en marcha', () => {
  const { raceId, m2, A, B } = seed();
  // m2 ya rodando (como en carrera real cuando la corrección de salida importa):
  Lap.create({ race_id: raceId, manga_id: m2, team_id: A, driver_id: null, lane: 2, lap_number: 800, lap_time_ms: 9000, elapsed_ms: 0 });
  Lap.create({ race_id: raceId, manga_id: m2, team_id: B, driver_id: null, lane: 1, lap_number: 801, lap_time_ms: 9000, elapsed_ms: 0 });

  const first = Lap.startSettledByEntity(raceId);
  for (let k = 0; k < 10; k++) {
    Lap.create({ race_id: raceId, manga_id: m2, team_id: B, driver_id: null, lane: 1, lap_number: 900 + k, lap_time_ms: 9200, elapsed_ms: k * 9200 });
    assert.strictEqual(Lap.startSettledByEntity(raceId), first, 'cache hit: misma Map');
  }
});

test('una corrección en la 1ª manga SÍ invalida', () => {
  const { raceId, m1, A } = seed();
  const before = Lap.startSettledByEntity(raceId);
  const beforeSnap = snap(before);

  // Sube el tiempo de una vuelta normal de A en la manga 1 → su settledAvg cambia.
  const lap = db.prepare('SELECT id FROM laps WHERE manga_id=? AND team_id=? AND is_warmup=0 ORDER BY id LIMIT 1').get(m1, A);
  Lap.updateTime(lap.id, 14000);

  const after = Lap.startSettledByEntity(raceId);
  assert.notStrictEqual(after, before, 'la caché se rehízo');
  assert.notDeepEqual(snap(after), beforeSnap, 'y el valor de A cambió');
});

test('una manga nueva con su 1ª vuelta invalida (rotación / entidad que no había corrido)', () => {
  const { raceId, m2 } = seed();
  const before = Lap.startSettledByEntity(raceId);

  // Equipo C, asignado pero sin correr hasta ahora; su 1ª vuelta cae en m2.
  const tandaId = db.prepare('SELECT id FROM tandas WHERE race_id=?').get(raceId).id;
  const C = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'C').lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,?,?,0)').run(m2, 3, C);
  // (m2 ya tenía cruces en otros tests; aquí es su 1ª mutación en ESTE test →
  // mangaCount sube y además aparece la entidad C.)
  Lap.create({ race_id: raceId, manga_id: m2, team_id: C, driver_id: null, lane: 3, lap_number: 1, lap_time_ms: 1400, elapsed_ms: 1400, is_warmup: 1 });
  Lap.create({ race_id: raceId, manga_id: m2, team_id: C, driver_id: null, lane: 3, lap_number: 2, lap_time_ms: 9000, elapsed_ms: 20000 });

  const after = Lap.startSettledByEntity(raceId);
  assert.notStrictEqual(after, before);
  assert.ok(after.has('team:' + C), 'C aparece en la corrección');
  assert.equal(after.get('team:' + C).firstMangaId, m2);
});

test('markExternalMutation (transferencia/restore) invalida', () => {
  const { raceId } = seed();
  const before = Lap.startSettledByEntity(raceId);
  Lap.markExternalMutation();
  assert.notStrictEqual(Lap.startSettledByEntity(raceId), before);
});

test('noteMangaSeen: registra la manga sin contar mutación, y el 1er cruce ya no invalida', () => {
  const { raceId, m2, A } = seed();
  const mutBefore = Lap.mutationCount;
  Lap.noteMangaSeen(m2);
  assert.equal(Lap.mutationCount, mutBefore, 'no cuenta como mutación');

  const first = Lap.startSettledByEntity(raceId);   // se cachea con m2 ya "vista"
  // El primer cruce de m2 (una mutación real) NO debe re-invalidar la caché.
  Lap.create({ race_id: raceId, manga_id: m2, team_id: A, driver_id: null, lane: 2, lap_number: 700, lap_time_ms: 9000, elapsed_ms: 0 });
  assert.strictEqual(Lap.startSettledByEntity(raceId), first, 'cache hit: el 1er cruce de una manga ya vista no invalida');
});
