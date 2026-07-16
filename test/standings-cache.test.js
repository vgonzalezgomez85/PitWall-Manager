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
// Auditoría 2026-07-09, D4: `getStandings()` se ejecutaba en CADA cruce y
// recalculaba los agregados de TODA la carrera. Medido sobre las 160.000 vueltas
// reales de la 24h de Modena: 74 ms (media y tiempo por entidad) + 100 ms
// (proyección). Con 24 carriles llega un cruce cada 0,8 s.
//
// Ahora se cachean. Una caché que devuelve un valor rancio es peor que la
// lentitud, así que lo que se prueba aquí es la INVALIDACIÓN: que el contador de
// mutaciones de Lap detecte cualquier escritura sobre otra manga, incluidas las
// que se hacen con SQL crudo saltándose el modelo.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db  = require('../src/config/database');
const Lap = require('../src/models/Lap');

after(limpiarBdTemporal);

beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'teams', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

/** Carrera con dos mangas y un equipo. */
function escenario() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('perf', 'club', 'team', 'active', 2, '[1,2]', '[2]', 10, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const m1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  const m2 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 2)').run(tandaId, raceId).lastInsertRowid;
  const teamId = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'Equipo A').lastInsertRowid;
  return { raceId, tandaId, m1, m2, teamId };
}

const vuelta = (e, mangaId, ms, n) => Lap.create({
  race_id: e.raceId, manga_id: mangaId, team_id: e.teamId, driver_id: null,
  lane: 1, lap_number: n, lap_time_ms: ms, elapsed_ms: n * ms,
});

// ── El contador de mutaciones ──────────────────────────────────────────────

test('insertar vueltas en la manga en curso NO cuenta como mutación de fuera', () => {
  const e = escenario();
  const antes = Lap.mutationsOutside(e.m2);
  vuelta(e, e.m2, 9000, 1);
  vuelta(e, e.m2, 9100, 2);
  assert.equal(Lap.mutationsOutside(e.m2), antes,
    'los cruces de la manga en curso no invalidan la caché de las anteriores');
});

test('insertar una vuelta en OTRA manga sí cuenta', () => {
  const e = escenario();
  const antes = Lap.mutationsOutside(e.m2);
  vuelta(e, e.m1, 9000, 1);
  assert.ok(Lap.mutationsOutside(e.m2) > antes, 'tocar una manga anterior invalida');
});

test('corregir una vuelta de otra manga cuenta, aunque solo se pase el id', () => {
  const e = escenario();
  const id = vuelta(e, e.m1, 9000, 1);
  vuelta(e, e.m2, 9000, 1);

  let antes = Lap.mutationsOutside(e.m2);
  Lap.markGhost(id);
  assert.ok(Lap.mutationsOutside(e.m2) > antes, 'markGhost resuelve la manga por el id de la vuelta');

  antes = Lap.mutationsOutside(e.m2);
  Lap.restore(id);
  assert.ok(Lap.mutationsOutside(e.m2) > antes, 'restore también');

  antes = Lap.mutationsOutside(e.m2);
  Lap.updateTime(id, 8500);
  assert.ok(Lap.mutationsOutside(e.m2) > antes, 'updateTime también');
});

test('corregir una vuelta de la manga EN CURSO no invalida la caché de las anteriores', () => {
  const e = escenario();
  const id = vuelta(e, e.m2, 9000, 1);
  const antes = Lap.mutationsOutside(e.m2);
  Lap.markGhost(id);
  Lap.updateTime(id, 8000);
  assert.equal(Lap.mutationsOutside(e.m2), antes);
});

test('borrar una manga entera invalida', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  const antes = Lap.mutationsOutside(e.m2);
  Lap.deleteByManga(e.m1);
  assert.ok(Lap.mutationsOutside(e.m2) > antes);
});

test('markExternalMutation cubre a quien escribe con SQL crudo', () => {
  const e = escenario();
  const antes = Lap.mutationsOutside(e.m2);
  db.prepare('DELETE FROM laps WHERE manga_id = ?').run(e.m1);   // se salta el modelo
  assert.equal(Lap.mutationsOutside(e.m2), antes, 'el SQL crudo NO se entera solo…');
  Lap.markExternalMutation();
  assert.ok(Lap.mutationsOutside(e.m2) > antes, '…por eso quien lo usa debe avisar');
});

test('addManual y transfer cuentan en su manga', () => {
  const e = escenario();
  const antes = Lap.mutationsOutside(e.m2);
  Lap.addManual({ mangaId: e.m2, raceId: e.raceId, lane: 1, lapTimeMs: 9000 });
  assert.equal(Lap.mutationsOutside(e.m2), antes, 'una vuelta manual en la manga en curso no invalida');

  Lap.addManual({ mangaId: e.m1, raceId: e.raceId, lane: 1, lapTimeMs: 9000 });
  assert.ok(Lap.mutationsOutside(e.m2) > antes, 'en otra manga, sí');
});

// ── La caché de agregados: mismo resultado que sin caché ────────────────────

const TimingService = require('../src/services/TimingService');

test('_priorAggregates devuelve lo mismo cacheado que recién calculado', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  vuelta(e, e.m1, 9400, 2);
  vuelta(e, e.m2, 5000, 1);   // manga en curso: NO debe entrar

  TimingService.invalidateStandingsCaches();
  const primera = TimingService._priorAggregates(e.raceId, e.m2);
  const segunda = TimingService._priorAggregates(e.raceId, e.m2);   // servida de caché
  assert.deepEqual(segunda.priorByEntity, primera.priorByEntity);
  assert.deepEqual(segunda.priorTimeByEntity, primera.priorTimeByEntity);

  const k = 't' + e.teamId;
  assert.equal(primera.priorByEntity[k].count, 2, 'solo las 2 vueltas de la manga anterior');
  assert.equal(Math.round(primera.priorByEntity[k].avg), 9200);
  assert.equal(primera.priorTimeByEntity[k], 18400);
});

// La media y el tiempo de las mangas anteriores salen del MISMO agregado que la
// proyección: un escaneo en vez de tres sobre las mismas 153.000 filas de una 24 h
// (185 ms → 78 ms). Se paga una vez por manga, pero con la carrera en marcha.

test('la media y el tiempo por entidad salen de un ÚNICO escaneo', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  vuelta(e, e.m1, 9400, 2);
  TimingService.invalidateStandingsCaches();

  let escaneos = 0;
  const original = Lap._aggRaw;
  Lap._aggRaw = (...a) => { escaneos++; return original.apply(Lap, a); };
  try { TimingService._priorAggregates(e.raceId, e.m2); }
  finally { Lap._aggRaw = original; }

  assert.equal(escaneos, 1, 'un solo recorrido de las mangas anteriores, no tres');
});

test('la media de las mangas anteriores coincide con la de la vía vieja', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  vuelta(e, e.m1, 9400, 2);
  Lap.create({ race_id: e.raceId, manga_id: e.m1, team_id: e.teamId, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 30000, elapsed_ms: 0, is_warmup: 1 });   // fuera de la media
  Lap.create({ race_id: e.raceId, manga_id: e.m1, team_id: e.teamId, driver_id: null,
    lane: 1, lap_number: 3, lap_time_ms: 50, elapsed_ms: 0, is_ghost: 1 });       // fuera de todo
  TimingService.invalidateStandingsCaches();

  // La consulta que había antes, tal cual.
  const viejo = db.prepare(`
    SELECT CASE WHEN team_id IS NOT NULL THEN 't' || team_id ELSE 'd' || driver_id END AS ekey,
           COUNT(*) AS cnt, AVG(lap_time_ms) AS avg_ms
    FROM laps
    WHERE race_id = ? AND manga_id != ? AND is_ghost = 0 AND is_warmup = 0 AND lap_number > 0
    GROUP BY ekey
  `).all(e.raceId, e.m2);

  const nuevo = TimingService._priorAggregates(e.raceId, e.m2).priorByEntity;
  viejo.forEach(v => {
    assert.equal(nuevo[v.ekey].count, v.cnt, `${v.ekey}: mismo nº de vueltas`);
    assert.ok(Math.abs(nuevo[v.ekey].avg - v.avg_ms) < 1e-9, `${v.ekey}: misma media`);
  });
  const k = 't' + e.teamId;
  assert.equal(nuevo[k].count, 2, 'ni la warmup ni el fantasma entran en la media');
  assert.equal(nuevo[k].avg, 9200);
});

test('el tiempo total por entidad SÍ incluye la warmup (y el fantasma no)', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  Lap.create({ race_id: e.raceId, manga_id: e.m1, team_id: e.teamId, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 30000, elapsed_ms: 0, is_warmup: 1 });
  Lap.create({ race_id: e.raceId, manga_id: e.m1, team_id: e.teamId, driver_id: null,
    lane: 1, lap_number: 3, lap_time_ms: 50, elapsed_ms: 0, is_ghost: 1 });
  TimingService.invalidateStandingsCaches();

  assert.equal(TimingService._priorAggregates(e.raceId, e.m2).priorTimeByEntity['t' + e.teamId],
    39000, 'el tiempo total es el que se pasó en pista: 9000 + 30000, sin el fantasma');
});

test('la caché se REFRESCA sola al tocar una manga anterior', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  vuelta(e, e.m1, 9400, 2);

  TimingService.invalidateStandingsCaches();
  const antes = TimingService._priorAggregates(e.raceId, e.m2);
  const k = 't' + e.teamId;
  assert.equal(antes.priorByEntity[k].count, 2);

  vuelta(e, e.m1, 10000, 3);            // ← alguien corrige la manga anterior
  const despues = TimingService._priorAggregates(e.raceId, e.m2);
  assert.equal(despues.priorByEntity[k].count, 3, 'la caché no puede servir un valor rancio');
  assert.equal(despues.priorTimeByEntity[k], 28400);
});

test('la caché NO se refresca por vueltas de la manga en curso (que es el punto)', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  TimingService.invalidateStandingsCaches();
  const primera = TimingService._priorAggregates(e.raceId, e.m2);

  for (let i = 1; i <= 50; i++) vuelta(e, e.m2, 9000, i);   // 50 cruces
  const segunda = TimingService._priorAggregates(e.raceId, e.m2);
  assert.equal(segunda, primera, 'es literalmente el mismo objeto: no se recalculó nada');
});

test('cambiar de manga invalida la caché', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  TimingService.invalidateStandingsCaches();
  const paraM2 = TimingService._priorAggregates(e.raceId, e.m2);
  const paraM1 = TimingService._priorAggregates(e.raceId, e.m1);
  assert.notEqual(paraM1, paraM2, 'cada manga tiene sus "anteriores"');
  const k = 't' + e.teamId;
  assert.equal(paraM2.priorByEntity[k].count, 1);
  assert.equal(paraM1.priorByEntity[k], undefined, 'para M1 no hay mangas anteriores');
});

// ── La caché de proyección ─────────────────────────────────────────────────

test('la proyección se sirve de caché dentro del TTL y se recalcula fuera', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  TimingService.invalidateStandingsCaches();

  const a = TimingService._cachedProjection(e.raceId);
  const b = TimingService._cachedProjection(e.raceId);
  assert.equal(a, b, 'dentro del TTL, el mismo objeto');

  // Envejecemos la caché a mano en vez de esperar un segundo.
  TimingService._projCache.get(e.raceId).ts -= TimingServiceClassTtl() + 10;
  const c = TimingService._cachedProjection(e.raceId);
  assert.notEqual(c, a, 'pasado el TTL se recalcula');
  assert.deepEqual(c, a, 'y el resultado es el mismo si nada cambió');
});

function TimingServiceClassTtl() {
  return Object.getPrototypeOf(TimingService).constructor.PROJECTION_TTL_MS;
}

test('invalidateStandingsCaches tira las dos cachés', () => {
  const e = escenario();
  vuelta(e, e.m1, 9000, 1);
  TimingService._priorAggregates(e.raceId, e.m2);
  TimingService._cachedProjection(e.raceId);
  assert.ok(TimingService._priorCache.size > 0 && TimingService._projCache.size > 0);

  TimingService.invalidateStandingsCaches();
  assert.equal(TimingService._priorCache.size, 0);
  assert.equal(TimingService._projCache.size, 0);
});

// ── Las cachés son POR CARRERA ─────────────────────────────────────────────
//
// Con una sola ranura compartida, un móvil del cliente Lap abierto en una carrera
// vieja expulsaba en cada refresco la caché de la carrera EN CURSO, y el motor
// volvía a pagar los 100 ms en el siguiente cruce. Justo lo que veníamos a evitar.

test('consultar otra carrera NO expulsa la caché de la carrera en curso', () => {
  const enCurso = escenario();
  vuelta(enCurso, enCurso.m1, 9000, 1);
  const vieja = escenario();
  vuelta(vieja, vieja.m1, 9000, 1);

  TimingService.invalidateStandingsCaches();
  const prior = TimingService._priorAggregates(enCurso.raceId, enCurso.m2);
  const proj  = TimingService._cachedProjection(enCurso.raceId);

  // El móvil de un equipo despistado, machacando la carrera de la semana pasada.
  for (let i = 0; i < 5; i++) {
    TimingService._priorAggregates(vieja.raceId, vieja.m2);
    TimingService._cachedProjection(vieja.raceId);
  }

  assert.equal(TimingService._priorAggregates(enCurso.raceId, enCurso.m2), prior,
    'el mismo objeto: la carrera en curso no se recalculó');
  assert.equal(TimingService._cachedProjection(enCurso.raceId), proj);
});

test('las cachés no crecen sin límite', () => {
  const techo = Object.getPrototypeOf(TimingService).constructor._CACHE_MAX_RACES;
  TimingService.invalidateStandingsCaches();
  for (let i = 0; i < techo + 5; i++) {
    const e = escenario();
    vuelta(e, e.m1, 9000, 1);
    TimingService._cachedProjection(e.raceId);
  }
  assert.equal(TimingService._projCache.size, techo, 'las carreras viejas caen');
});

// ── Equivalencia: la vía rápida da EXACTAMENTE lo mismo que la lenta ────────
//
// Es lo único que hace defendible el troceado. Se comprobó también contra las
// 22 mangas y las 160.569 vueltas reales de la 24h de Modena, entidad a entidad.

/** Carrera con varias mangas y todos los casos raros que el agregado distingue. */
function carreraRica() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('rica', 'club', 'team', 'active', 3, '[1,2,3]', '[3]', 10, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mangas = [1, 2, 3, 4].map(n =>
    db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)').run(tandaId, raceId, n).lastInsertRowid);
  const equipos = ['Alfa', 'Beta', 'Gamma'].map((n, i) =>
    db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, 0, ?)')
      .run(raceId, tandaId, n, '#00' + i + '000').lastInsertRowid);

  // coma por manga y carril (alimenta el desempate)
  mangas.forEach((m, mi) => equipos.forEach((t, ti) => {
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, ?, ?, 0, ?)')
      .run(m, ti + 1, t, 0.1 * (mi + 1) * (ti + 1));
  }));

  let n = 0;
  const mk = (mangaId, teamId, ms, extra = {}) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: teamId, driver_id: null,
    lane: 1, lap_number: ++n, lap_time_ms: ms, elapsed_ms: n * ms, ...extra,
  });

  mangas.forEach((m, mi) => equipos.forEach((t, ti) => {
    mk(m, t, 9000 + ti * 100, { lap_number: 1, is_warmup: 1 });   // warmup: fuera de la media
    mk(m, t, 8500 + ti * 50);                                      // vuelta buena
    mk(m, t, 12000, { is_exit: 1 });                               // salida de pista
    mk(m, t, 100, { is_ghost: 1 });                                // fantasma: se ignora
    if (mi === 0 && ti === 0) mk(m, t, 8200);                      // mejor vuelta del líder
  }));

  // Un equipo que solo corre una manga (mangas_raced distinto)
  const tardio = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)')
    .run(raceId, tandaId, 'Delta').lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, 3, ?, 0, 0.5)').run(mangas[3], tardio);
  mk(mangas[3], tardio, 8800);

  return { raceId, mangas };
}

test('aggregateByRaceSplit == aggregateByRace, para cada manga activa posible', () => {
  const { raceId, mangas } = carreraRica();
  const directo = Lap.aggregateByRace(raceId);
  assert.ok(directo.length >= 4, 'hay entidades que comparar');

  for (const m of mangas) {
    const prior = Lap._aggRaw(raceId, { excludeManga: m });
    const split = Lap.aggregateByRaceSplit(raceId, m, prior);
    assert.deepEqual(split, directo, `la manga ${m} como activa debe dar el mismo agregado`);
  }
});

test('el troceado respeta warmup, fantasmas, salidas y la mejor vuelta', () => {
  const { raceId, mangas } = carreraRica();
  const directo = Lap.aggregateByRace(raceId);
  const lider = directo[0];

  assert.equal(lider.best_lap_ms, 8200, 'la mejor vuelta ignora warmup, salidas y fantasmas');
  assert.ok(lider.exit_count > 0, 'las salidas se cuentan');
  assert.ok(lider.avg_lap_ms > 0);

  const prior = Lap._aggRaw(raceId, { excludeManga: mangas[0] });
  const split = Lap.aggregateByRaceSplit(raceId, mangas[0], prior);
  assert.equal(split[0].best_lap_ms, lider.best_lap_ms, 'la mejor vuelta sobrevive a la fusión');
  assert.equal(split[0].avg_lap_ms, lider.avg_lap_ms, 'y la media ponderada también');
});

test('una carrera sin manga activa usa la vía directa y no se rompe', () => {
  const { raceId } = carreraRica();
  const directo = Lap.aggregateByRace(raceId);
  TimingService.invalidateStandingsCaches();
  const proj = TimingService.buildRaceProjection(raceId);
  assert.equal(proj.length, directo.filter(d => d.entity_id != null).length);
});

test('la proyección con manga activa coincide con la de la vía directa', () => {
  const { raceId, mangas } = carreraRica();
  const activa = mangas[mangas.length - 1];
  db.prepare("UPDATE mangas SET status = 'active', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), activa);

  TimingService.invalidateStandingsCaches();
  const conCache = TimingService.buildRaceProjection(raceId);

  // Forzamos la vía lenta sustituyendo el agregado troceado por el directo.
  const split = Lap.aggregateByRaceSplit;
  Lap.aggregateByRaceSplit = (rid) => Lap.aggregateByRace(rid);
  TimingService.invalidateStandingsCaches();
  const sinCache = TimingService.buildRaceProjection(raceId);
  Lap.aggregateByRaceSplit = split;

  // `remainingMs` y `projectedRaw` se derivan de Date.now(), así que las dos
  // llamadas difieren en el milisegundo que las separa. Comparar la proyección
  // entera con deepEqual hacía este test dependiente del reloj: pasaba solo si
  // ambas caían en el mismo ms. Se compara lo que el test dice comprobar —que la
  // caché no cambia ni una posición— y la proyección con tolerancia.
  const estable = (p) => ({
    entityId: p.entityId, name: p.name, position: p.position,
    totalLaps: p.totalLaps, avgLapMs: p.avgLapMs, bestLapMs: p.bestLapMs,
    comaTotal: p.comaTotal, mangasRaced: p.mangasRaced,
  });
  assert.deepEqual(conCache.map(estable), sinCache.map(estable),
    'la caché no puede cambiar ni una posición');

  conCache.forEach((p, i) => {
    const q = sinCache[i];
    if (p.projectedRaw == null || q.projectedRaw == null) {
      assert.equal(p.projectedRaw, q.projectedRaw);
      return;
    }
    assert.ok(Math.abs(p.projectedRaw - q.projectedRaw) < 0.01,
      `${p.name}: proyección ${p.projectedRaw} vs ${q.projectedRaw}`);
    assert.ok(Math.abs(p.remainingMs - q.remainingMs) <= 50,
      `${p.name}: restante ${p.remainingMs} vs ${q.remainingMs}`);
  });
});
