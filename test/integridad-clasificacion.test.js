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
// Fase 2 de la auditoría 2026-07-09. Cuatro defectos que no paran la carrera pero
// falsean la clasificación final:
//
//   D7 — El contador de vueltas del DS (byte12) es BCD de un byte: cuenta módulo
//        100. Pasadas 100 vueltas en un stint, la reconciliación del cruce "en la
//        bandera" salía negativa y se desactivaba en silencio, justo para los
//        coches que más vueltas dan.
//   Coma — Se calculaba con el fin NOMINAL del circuito. Con varias cajas, la que
//        termina antes veía su coma saturada a 0.99.
//   Desempate — La proyección ordenaba por coma SUMA y los resultados por coma
//        MEDIA por manga: dos equipos empatados podían salir en orden opuesto
//        según la pantalla.
//   started_at — No se limpiaba al devolver una manga a 'pending', así que la
//        proyección la seguía viendo como activa.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga = require('../src/models/Manga');
const TimingService = require('../src/services/TimingService');
const TimingServiceClass = Object.getPrototypeOf(TimingService).constructor;

after(limpiarBdTemporal);

beforeEach(() => {
  TimingService.session = null;
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'teams', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

// ── D7: el contador del DS cuenta módulo 100 ───────────────────────────────

const abs = (ds, reg) => TimingServiceClass.absoluteDsCount(ds, reg);

test('con menos de 100 vueltas el contador se usa tal cual', () => {
  assert.equal(abs(5, 4), 5);
  assert.equal(abs(30, 29), 30);
  assert.equal(abs(99, 98), 99);
  assert.equal(abs(0, 0), 0);
});

test('pasadas 100 vueltas se reconstruye el contador absoluto', () => {
  // El caso del informe: 130 vueltas → el DS manda 30.
  assert.equal(abs(30, 129), 130, 'el DS lleva una más que la BD: la vuelta de bandera');
  assert.equal(abs(30, 130), 130, 'ya cuadran');
  assert.equal(abs(0, 199), 200);
  assert.equal(abs(1, 200), 201);
  assert.equal(abs(50, 349), 350);
});

test('la BD por delante del DS sigue dando desfase negativo (no se repone nada)', () => {
  assert.equal(abs(99, 100) - 100, -1, 'la BD tiene una vuelta más: no hay que reponer');
  assert.equal(abs(28, 130) - 130, -2);
  assert.equal(abs(4, 5) - 5, -1);
});

test('el salto de centena no inventa 99 vueltas', () => {
  // Es el fallo que un arreglo ingenuo introduce: registered=100, ds=99.
  const missing = abs(99, 100) - 100;
  assert.ok(missing < 0, `esperaba desfase negativo, obtuve ${missing}`);
  assert.ok(Math.abs(missing) <= 50, 'nunca un desfase de medio centenar');
});

test('el contador reconstruido siempre es congruente con el byte12, y nunca negativo', () => {
  for (let reg = 0; reg <= 400; reg++) {
    for (let ds = 0; ds <= 99; ds++) {
      const a = abs(ds, reg);
      assert.ok(a >= 0, `ds=${ds} reg=${reg} → ${a}: un contador absoluto no puede ser negativo`);
      assert.equal(a % 100, ds % 100, `ds=${ds} reg=${reg}: debe seguir acabando en el byte12`);
    }
  }
});

test('con el contador ya rodado, el desfase queda acotado a medio ciclo', () => {
  // Por debajo de 50 vueltas registradas no hay ambigüedad que resolver: el
  // único candidato no negativo puede estar lejos, y para eso está la
  // salvaguarda de "desfase grande → capado a 3".
  for (let reg = 50; reg <= 400; reg++) {
    for (let ds = 0; ds <= 99; ds++) {
      const d = abs(ds, reg) - reg;
      assert.ok(d >= -50 && d <= 50, `ds=${ds} reg=${reg} → ${d}`);
    }
  }
});

// ── started_at al volver a pending ─────────────────────────────────────────

function mangaEnBd() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('x', 'club', 'team', 'active', 2, '[1,2]', '[2]', 10, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  return { raceId, mangaId };
}

const fila = (id) => db.prepare('SELECT status, started_at, finished_at FROM mangas WHERE id = ?').get(id);

test('devolver una manga a pending borra sus marcas de tiempo', () => {
  const { mangaId } = mangaEnBd();
  Manga.updateStatus(mangaId, 'active');
  assert.ok(fila(mangaId).started_at, 'arrancar la sella');

  Manga.updateStatus(mangaId, 'pending');
  const f = fila(mangaId);
  assert.equal(f.status, 'pending');
  assert.equal(f.started_at, null, 'una manga pendiente no ha empezado');
  assert.equal(f.finished_at, null);
});

test('repetir una manga terminada también limpia finished_at', () => {
  const { mangaId } = mangaEnBd();
  Manga.updateStatus(mangaId, 'active');
  Manga.updateStatus(mangaId, 'finished');
  assert.ok(fila(mangaId).finished_at);

  Manga.updateStatus(mangaId, 'pending');
  assert.equal(fila(mangaId).finished_at, null, 'ya no está terminada');
  assert.equal(fila(mangaId).started_at, null);
});

test('una manga pendiente NO la ve la proyección como activa', () => {
  const { raceId, mangaId } = mangaEnBd();
  Manga.updateStatus(mangaId, 'active');
  Manga.updateStatus(mangaId, 'pending');   // stop forzado

  const activa = db.prepare(`
    SELECT id FROM mangas
    WHERE race_id = ? AND status != 'finished' AND started_at IS NOT NULL
  `).get(raceId);
  assert.equal(activa, undefined,
    'entre el STOP y el nuevo GO la proyección la trataba como activa Y la excluía de las pendientes');
});

test('arrancar, parar y volver a arrancar deja la manga bien sellada', () => {
  const { mangaId } = mangaEnBd();
  Manga.updateStatus(mangaId, 'active');
  const primera = fila(mangaId).started_at;
  Manga.updateStatus(mangaId, 'pending');
  Manga.updateStatus(mangaId, 'active');
  const segunda = fila(mangaId).started_at;
  assert.ok(segunda, 'el nuevo GO la vuelve a sellar');
  assert.ok(segunda >= primera);
});

// ── Desempate por coma: la misma regla en la proyección y en los resultados ──

const Lap = require('../src/models/Lap');

/**
 * Dos equipos empatados a vueltas, con distinto número de mangas corridas.
 * Es el caso en que la coma SUMA y la coma MEDIA dan órdenes OPUESTOS:
 *   Alfa: 2 mangas, coma 0.30 + 0.30 = 0.60  → media 0.30
 *   Beta: 1 manga,  coma 0.50            = 0.50  → media 0.50
 * Por DISTANCIA (suma de comas) gana Alfa (0.60 > 0.50): recorrió más.
 * (Por la media habría ganado Beta, pero el desempate oficial es la distancia.)
 */
function empateConDescansos() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('empate', 'club', 'team', 'active', 2, '[1,2]', '[2]', 10, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const m1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  const m2 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 2)').run(tandaId, raceId).lastInsertRowid;

  const alfa = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'Alfa').lastInsertRowid;
  const beta = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'Beta').lastInsertRowid;

  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,1,?,0,0.30)').run(m1, alfa);
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,1,?,0,0.30)').run(m2, alfa);
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,2,?,0,0.50)').run(m2, beta);

  let n = 0;
  const mk = (mangaId, teamId, ms) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: teamId, driver_id: null,
    lane: 1, lap_number: ++n, lap_time_ms: ms, elapsed_ms: n * ms,
  });
  // Mismo número de vueltas y mismo tiempo total: solo desempata la coma.
  mk(m1, alfa, 9000); mk(m2, alfa, 9000);
  mk(m2, beta, 9000); mk(m2, beta, 9000);

  // Carrera TERMINADA. Es cuando la divergencia se ve: sin tiempo restante, la
  // proyección empata en vueltas y el desempate por coma decide de verdad. Con
  // mangas pendientes, las vueltas proyectadas ya separan a los equipos.
  Manga.updateStatus(m1, 'finished');
  Manga.updateStatus(m2, 'finished');

  return { raceId, alfa, beta };
}

test('la proyección y los resultados desempatan por distancia con la MISMA regla', () => {
  const { raceId } = empateConDescansos();

  const resultados = Lap.aggregateByRace(raceId).filter(r => r.entity_id != null);
  TimingService.invalidateStandingsCaches();
  const proyeccion = TimingService.buildRaceProjection(raceId);

  assert.equal(resultados[0].total_laps, resultados[1].total_laps, 'el escenario está empatado a vueltas');
  assert.deepEqual(
    proyeccion.map(p => p.name),
    resultados.map(r => r.entity_name),
    'dos equipos empatados no pueden salir en orden opuesto según la pantalla',
  );
});

test('a igualdad de vueltas gana quien más DISTANCIA recorrió (suma de comas)', () => {
  const { raceId } = empateConDescansos();
  TimingService.invalidateStandingsCaches();
  const proj = TimingService.buildRaceProjection(raceId);

  assert.equal(proj[0].projectedRaw, proj[1].projectedRaw, 'el escenario empata en proyección');
  assert.equal(proj[0].name, 'Alfa',
    'Alfa: suma de comas 0.60 (más distancia) · Beta: 0.50');
  assert.ok(proj[0].comaTotal > proj[1].comaTotal,
    'gana por MÁS coma total (más distancia); con la media habría ganado Beta');
});

// ── Coma: fin real del circuito, no el nominal ─────────────────────────────

const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

test('la coma usa el fin REAL de SU circuito, no el de la última caja en terminar', () => {
  // Dos cajas de un carril. La caja 1 termina 5 minutos antes que la caja 2.
  // Antes, la coma se calculaba con `min(nowTs, arranque + duración)` y `nowTs`
  // es cuando terminó la ÚLTIMA caja: al carril de la caja 1 se le regalaban esos
  // 5 minutos y su coma se saturaba a 0.99. En un empate a vueltas eso decide
  // posiciones.
  const MIN = 60000;
  const perfiles = ['P1', 'P2'].map(n => ({ nombre: n, id: crearPerfil(n) }));
  perfiles.forEach((p, i) => crearEquipoCatalogo(`E${i + 1}`, [p]));
  const { raceId, mangaId, teams } = crearCarreraConManga(
    perfiles.map((p, i) => ({ nombre: `E${i + 1}`, pilotos: [p] })),
    { circuitsConfig: [1, 1] },
  );
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  const lanes   = require('../src/models/Manga').getLanes(mangaId);
  const dbTeams = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(manga.tanda_id);

  TimingService.startManga(manga, race, lanes, dbTeams, drivers, 60 * MIN);
  const s = TimingService.session;

  // Ambos carriles cruzaron hace 3 s (respecto al fin de SU circuito) con 10 s de media.
  const ahora = Date.now();
  Object.values(s.laneMap).forEach(ld => {
    ld.lapCount = 5; ld.cleanAvgMs = 10000; ld.lapAvgMs = 10000;
  });

  // La caja 1 (carril 1) terminó hace 5 minutos; la caja 2 (carril 2), ahora.
  s.circuits[0].status = 'finished'; s.circuits[0].endTime = ahora - 5 * MIN;
  s.circuits[1].status = 'finished'; s.circuits[1].endTime = ahora;
  s.laneMap[1].lastCrossing = s.circuits[0].endTime - 3000;
  s.laneMap[2].lastCrossing = s.circuits[1].endTime - 3000;

  TimingService.stopManga(true);

  const coma = (lane) => db.prepare('SELECT coma FROM manga_lanes WHERE manga_id = ? AND lane = ?').get(mangaId, lane).coma;
  assert.equal(coma(1), 0.3, 'carril de la caja que acabó antes: 3 s / 10 s de media');
  assert.equal(coma(2), 0.3, 'y el de la otra caja, lo mismo');
  assert.notEqual(coma(1), 0.99, 'antes se saturaba: se le contaban los 5 min que su caja llevaba parada');
});

// ── Desempate por DISTANCIA (vueltas + suma de comas) ──────────────────────
// Regla de Llinars 2026: a igualdad de vueltas gana quien recorrió MÁS distancia,
// es decir, quien acumuló más coma (más fracción de vuelta al caer cada bandera).
// La distancia manda sobre el tiempo total.

/**
 * Dos equipos empatados a vueltas donde la DISTANCIA (coma) y el tiempo total
 * APUNTAN A DISTINTO ganador:
 *   Lento : 2 vueltas de 9500 → total 19000 ms · coma 0.90  (más tiempo, MÁS distancia)
 *   Rápido: 2 vueltas de 9000 → total 18000 ms · coma 0.10  (menos tiempo, MENOS distancia)
 * Con la regla de distancia gana Lento (más coma). Con la de tiempo ganaba Rápido.
 */
function empateTiempoVsComa() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('empate-t', 'club', 'team', 'active', 2, '[1,2]', '[2]', 10, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const m1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;

  const rap = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'Rapido').lastInsertRowid;
  const len = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, 'Lento').lastInsertRowid;

  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,1,?,0,0.10)').run(m1, rap);
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,2,?,0,0.90)').run(m1, len);

  let n = 0;
  const mk = (teamId, ms) => Lap.create({
    race_id: raceId, manga_id: m1, team_id: teamId, driver_id: null,
    lane: 1, lap_number: ++n, lap_time_ms: ms, elapsed_ms: n * ms,
  });
  mk(rap, 9000); mk(rap, 9000);   // total 18000
  mk(len, 9500); mk(len, 9500);   // total 19000

  Manga.updateStatus(m1, 'finished');
  return { raceId };
}

test('a igualdad de vueltas gana MÁS distancia (más coma), aunque tarde más', () => {
  const { raceId } = empateTiempoVsComa();
  const res = Lap.aggregateByRace(raceId).filter(r => r.entity_id != null);

  assert.equal(res[0].total_laps, res[1].total_laps, 'empate a vueltas');
  assert.equal(res[0].entity_name, 'Lento', 'gana quien más distancia (coma 0.90 > 0.10)');
  // …pese a tener MÁS tiempo total: con la regla de tiempo habría ganado Rápido.
  assert.ok(res[0].total_time_ms > res[1].total_time_ms, 'y gana aun tardando más');
});

test('proyección y resultados coinciden con el desempate por distancia', () => {
  const { raceId } = empateTiempoVsComa();
  TimingService.invalidateStandingsCaches();
  const proj = TimingService.buildRaceProjection(raceId);
  const res  = Lap.aggregateByRace(raceId).filter(r => r.entity_id != null);

  assert.deepEqual(proj.map(p => p.name), res.map(r => r.entity_name),
    'directo/Le Mans y resultados no pueden salir en orden opuesto');
  assert.equal(proj[0].name, 'Lento', 'la proyección también pone delante al de más distancia');
});

test('aggregateByRace y aggregateByRaceSplit dan el MISMO orden con la regla nueva', () => {
  const { raceId } = empateTiempoVsComa();
  const full  = Lap.aggregateByRace(raceId);
  const prior = Lap._aggRaw(raceId, { excludeManga: -1 });   // ninguna manga previa
  const split = Lap.aggregateByRaceSplit(raceId, -1, prior);
  assert.deepEqual(split.map(r => r.entity_name), full.map(r => r.entity_name),
    'los dos caminos del agregado deben ordenar idéntico');
});
