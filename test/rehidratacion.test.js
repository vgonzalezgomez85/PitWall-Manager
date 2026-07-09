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
// Recuperación de una manga que se quedó a medias porque el proceso murió.
//
// Lo que se prueba aquí no es que la recuperación funcione —eso es lo fácil—
// sino que NO se dispare cuando no debe. Una manga puede llevar días marcada
// 'active' en la BD: resucitarla al arrancar y empezar a escribirle vueltas
// sería mucho peor que dejarla muerta.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga         = require('../src/models/Manga');
const MangaCircuit  = require('../src/models/MangaCircuit');
const DriverShift   = require('../src/models/DriverShift');
const Lap           = require('../src/models/Lap');
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
  TimingService.session = null;
  TimingService._activeShiftsByLane = {};
}

after(() => { apagarTimers(); limpiarBdTemporal(); });

beforeEach(() => {
  apagarTimers();
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

/** Carrera de campeonato, 2 carriles en 2 circuitos. */
function escenario() {
  const perfiles = ['Ana', 'Caro'].map(n => ({ nombre: n, id: crearPerfil(n) }));
  perfiles.forEach((p, i) => crearEquipoCatalogo(`E${i + 1}`, [p]));
  const { raceId, mangaId, teams } = crearCarreraConManga(
    perfiles.map((p, i) => ({ nombre: `E${i + 1}`, pilotos: [p] })),
    { circuitsConfig: [1, 1] },
  );
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return { raceId, mangaId, race, manga, teams };
}

function darGo(e, durationMs = 60 * MIN) {
  const lanes   = Manga.getLanes(e.mangaId);
  const teams   = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id);
  TimingService.startManga(e.manga, e.race, lanes, teams, drivers, durationMs);
}

/** Todo lo necesario para rehidratar, tal como se lo pasa SessionRecovery. */
function paqueteRecuperacion(e, outageMs = 0) {
  return {
    manga: db.prepare('SELECT * FROM mangas WHERE id = ?').get(e.mangaId),
    race:  db.prepare('SELECT * FROM races  WHERE id = ?').get(e.raceId),
    lanes: Manga.getLanes(e.mangaId),
    teams: db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id),
    drivers: db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id),
    circuits: MangaCircuit.findByManga(e.mangaId),
    outageMs,
  };
}

/** El proceso muere: la memoria se va, la BD se queda. */
function morir() { apagarTimers(); }

// ── El estado de los circuitos llega a disco ───────────────────────────────

test('arrancar una manga persiste el estado de sus circuitos', () => {
  const e = escenario();
  darGo(e);
  const filas = MangaCircuit.findByManga(e.mangaId);
  assert.equal(filas.length, 2, 'un registro por circuito');
  assert.equal(filas[0].status, 'running');
  assert.equal(filas[1].status, 'pending', 'el GO escalonado: la caja 2 aún no arrancó');
  assert.ok(filas[0].startTime > 0, 'con su ancla de tiempo');
});

test('pausar y reanudar actualizan el estado en disco', () => {
  const e = escenario();
  darGo(e);
  TimingService.pauseCircuit(0);
  assert.equal(MangaCircuit.findByManga(e.mangaId)[0].status, 'paused');
  TimingService.resumeCircuit(0);
  assert.equal(MangaCircuit.findByManga(e.mangaId)[0].status, 'running');
});

test('terminar un circuito guarda su fin real', () => {
  const e = escenario();
  darGo(e);
  TimingService.finishCircuit(0);
  const f = MangaCircuit.findByManga(e.mangaId)[0];
  assert.equal(f.status, 'finished');
  assert.ok(f.endTime > 0, 'su endTime, que es lo que congela su reloj');
});

// ── La recuperación misma ──────────────────────────────────────────────────

test('recuperar una manga restaura el reloj de cada circuito', () => {
  const e = escenario();
  darGo(e);
  // 10 minutos de carrera.
  TimingService.session.circuits[0].startTime -= 10 * MIN;
  TimingService._persistCircuits();
  morir();

  TimingService.rehydrateManga(paqueteRecuperacion(e, 30000));
  assert.ok(TimingService.session, 'hay sesión de nuevo');
  assert.equal(TimingService.activeMangaId, e.mangaId);
  const transcurrido = TimingService._circuitElapsedMs(0);
  assert.ok(Math.abs(transcurrido - 10 * MIN) < 2000,
    `el circuito lleva ${(transcurrido / 60000).toFixed(1)} min, esperaba ~10`);
});

test('recuperar NO sella started_at otra vez (no es un GO)', () => {
  const e = escenario();
  darGo(e);
  const antes = db.prepare('SELECT started_at FROM mangas WHERE id = ?').get(e.mangaId).started_at;
  morir();

  TimingService.rehydrateManga(paqueteRecuperacion(e));
  const despues = db.prepare('SELECT started_at FROM mangas WHERE id = ?').get(e.mangaId).started_at;
  assert.equal(despues, antes, 'la manga ya había empezado: su hora de salida no se toca');
});

test('recuperar restaura vueltas, media y mejor vuelta desde la BD', () => {
  const e = escenario();
  darGo(e);
  const c0 = TimingService.session.circuits[0];
  // Tres vueltas del carril 1, ya en disco.
  [9000, 8500, 9500].forEach((ms, i) => Lap.create({
    race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: i + 1, lap_time_ms: ms, elapsed_ms: (i + 1) * 9000,
    is_warmup: i === 0 ? 1 : 0,
  }));
  TimingService._persistCircuits();
  morir();

  TimingService.rehydrateManga(paqueteRecuperacion(e));
  const ld = TimingService.session.laneMap[1];
  assert.equal(ld.lapCount, 3, 'las tres vueltas');
  assert.equal(ld.bestLapMs, 8500, 'la mejor, sin contar la warmup');
  assert.equal(ld.avgLapCount, 2, 'la warmup no entra en la media');
  assert.equal(ld.lapAvgMs, 9000, '(8500 + 9500) / 2');
  assert.ok(ld.lastCrossing > 0, 'y el último cruce, en reloj de pared');
});

test('un circuito PAUSADO sigue pausado tras recuperar', () => {
  const e = escenario();
  darGo(e);
  TimingService.pauseCircuit(0);
  const congelado = TimingService._circuitElapsedMs(0);
  morir();

  TimingService.rehydrateManga(paqueteRecuperacion(e));
  assert.equal(TimingService.session.circuits[0].status, 'paused');
  assert.ok(Math.abs(TimingService._circuitElapsedMs(0) - congelado) < 1000,
    'y su reloj sigue congelado donde estaba');
});

test('un circuito ya TERMINADO no revive', () => {
  const e = escenario();
  darGo(e);
  TimingService.finishCircuit(0);
  const finalizado = TimingService._circuitElapsedMs(0);
  morir();

  TimingService.rehydrateManga(paqueteRecuperacion(e));
  assert.equal(TimingService.session.circuits[0].status, 'finished');
  assert.ok(Math.abs(TimingService._circuitElapsedMs(0) - finalizado) < 1000);
});

// ── Turnos de piloto: la caída se le cuenta a quien conducía ───────────────

test('al recuperar, el piloto que conducía se lleva el tiempo de la caída', () => {
  const e = escenario();
  const [tA] = e.teams;
  DriverShift.openShift({ mangaId: e.mangaId, raceId: e.raceId, lane: tA.lane,
    teamId: tA.id, driverId: tA.drivers[0].id, driverName: 'Ana', preArmed: true });
  darGo(e);

  // Ana lleva 10 min conduciendo; se persiste su turno con el ancla.
  TimingService.session.circuits[0].startTime -= 10 * MIN;
  TimingService._persistAllDriverShifts();
  TimingService._persistCircuits();

  const guardado = db.prepare('SELECT driving_ms, elapsed_at_ms FROM driver_shifts WHERE manga_id = ?').get(e.mangaId);
  assert.ok(Math.abs(guardado.driving_ms - 10 * MIN) < 2000);
  assert.ok(guardado.elapsed_at_ms != null, 'se guarda el transcurrido del circuito');

  // El proceso muere. Cinco minutos de caída: el coche sigue rodando.
  morir();
  const filas = MangaCircuit.findByManga(e.mangaId);
  db.prepare('UPDATE manga_circuits SET start_time_ms = start_time_ms - ? WHERE circuit_index = 0')
    .run(5 * MIN);

  TimingService.rehydrateManga(paqueteRecuperacion(e, 5 * MIN));
  const vivo = TimingService.getActiveShifts()[tA.lane];
  assert.ok(vivo, 'el turno sigue abierto');
  assert.ok(Math.abs(vivo.drivingMs - 15 * MIN) < 3000,
    `el piloto lleva ${(vivo.drivingMs / 60000).toFixed(1)} min: 10 antes + 5 de caída`);
});

test('un pre-arme que nunca rodó no se convierte en turno al recuperar', () => {
  const e = escenario();
  const [, tB] = e.teams;
  darGo(e);
  DriverShift.openShift({ mangaId: e.mangaId, raceId: e.raceId, lane: tB.lane,
    teamId: tB.id, driverId: tB.drivers[0].id, driverName: 'Caro', preArmed: true });
  TimingService._persistCircuits();
  morir();

  TimingService.rehydrateManga(paqueteRecuperacion(e));
  assert.equal(TimingService.getActiveShifts()[tB.lane], undefined,
    'seguía pre-armado: no estaba conduciendo');
});

// ── La guarda: qué NO se recupera ──────────────────────────────────────────

const SessionRecovery = require('../src/services/SessionRecovery');

test('una manga activa SIN estado de circuitos no se puede recuperar', () => {
  const e = escenario();
  Manga.updateStatus(e.mangaId, 'active');
  MangaCircuit.deleteByManga(e.mangaId);        // manga anterior a esta funcionalidad

  const armado = SessionRecovery.arm();
  assert.equal(armado, null, 'sin ancla no hay nada que restaurar');
  assert.equal(SessionRecovery.ultimoResultado.estado, 'sin-estado');
  SessionRecovery.cancel();
});

test('una manga cuyos circuitos ya habían terminado no se recupera', () => {
  const e = escenario();
  darGo(e);
  TimingService.finishCircuit(0);
  TimingService.finishCircuit(1);
  Manga.updateStatus(e.mangaId, 'active');       // quedó 'active' por el fallo
  morir();

  const armado = SessionRecovery.arm();
  assert.equal(armado, null);
  assert.equal(SessionRecovery.ultimoResultado.estado, 'circuitos-terminados');
  SessionRecovery.cancel();
});

test('con circuitos vivos, la recuperación queda ESPERANDO la señal de la caja', () => {
  const e = escenario();
  darGo(e);
  TimingService._persistCircuits();
  morir();
  Manga.updateStatus(e.mangaId, 'active');

  const armado = SessionRecovery.arm();
  assert.ok(armado, 'hay una manga recuperable');
  assert.equal(SessionRecovery.ultimoResultado.estado, 'esperando');
  assert.ok(SessionRecovery.esperando, 'pero NO se recupera hasta que la caja confirme');
  assert.equal(TimingService.session, null, 'todavía no hay sesión');
  SessionRecovery.cancel();
});

test('la señal de la caja dispara la recuperación', () => {
  const e = escenario();
  darGo(e);
  TimingService._persistCircuits();
  morir();
  Manga.updateStatus(e.mangaId, 'active');

  SessionRecovery.arm();
  assert.equal(TimingService.session, null);

  // Llega un latido: la caja sigue corriendo.
  const SerialService = require('../src/services/SerialService');
  SerialService.emit('heartbeat', { circuit: 0, minute: 3 });

  assert.ok(TimingService.session, 'la manga se recupera');
  assert.equal(TimingService.activeMangaId, e.mangaId);
  assert.equal(SessionRecovery.ultimoResultado.estado, 'recuperada');
  assert.equal(SessionRecovery.ultimoResultado.fuente, 'latido');
});

// ── Las vueltas repuestas se pueden encontrar y corregir a mano ─────────────
//
// Reponer una vuelta que la caja contó es lo correcto —el equipo no la pierde—
// pero su tiempo es la media del carril, no un cruce real. Si un coche se paró
// en pista durante el corte, se repondrán más vueltas de las que dio. Por eso
// van marcadas: el operador tiene que poder localizarlas, corregirlas o borrarlas.

test('las vueltas repuestas quedan marcadas como estimadas', () => {
  const e = escenario();
  const id = Lap.create({
    race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 9000, elapsed_ms: 9000, is_estimated: 1,
  });
  const fila = db.prepare('SELECT is_estimated FROM laps WHERE id = ?').get(id);
  assert.equal(fila.is_estimated, 1);
});

test('una vuelta normal NO queda marcada', () => {
  const e = escenario();
  const id = Lap.create({
    race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 9000, elapsed_ms: 9000,
  });
  assert.equal(db.prepare('SELECT is_estimated FROM laps WHERE id = ?').get(id).is_estimated, 0);
});

test('la pantalla de correcciones ve la marca', () => {
  const e = escenario();
  Lap.create({ race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 9000, elapsed_ms: 9000 });
  Lap.create({ race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: 2, lap_time_ms: 9500, elapsed_ms: 18500, is_estimated: 1 });

  const laps = Lap.findByMangaAll(e.mangaId);
  assert.equal(laps.filter(l => l.is_estimated).length, 1, 'el corrector puede distinguirlas');
});

test('borrar una vuelta repuesta la quita, como cualquier otra', () => {
  const e = escenario();
  const id = Lap.create({ race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 9000, elapsed_ms: 9000, is_estimated: 1 });
  Lap.deleteLap(id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM laps WHERE id = ?').get(id).c, 0);
});

test('corregir el tiempo a mano deja de considerarla una estimación', () => {
  const e = escenario();
  const id = Lap.create({ race_id: e.raceId, manga_id: e.mangaId, team_id: e.teams[0].id, driver_id: null,
    lane: 1, lap_number: 1, lap_time_ms: 9000, elapsed_ms: 9000, is_estimated: 1 });

  Lap.updateTime(id, 8750);
  const fila = db.prepare('SELECT lap_time_ms, is_estimated FROM laps WHERE id = ?').get(id);
  assert.equal(fila.lap_time_ms, 8750);
  assert.equal(fila.is_estimated, 0,
    'el operador ha puesto el tiempo real: ya no es una estimación, y el informe no debe contarla como tal');
});

test('un cruce repuesto por el enlace caído llega marcado hasta la BD', () => {
  // El relleno de SerialService emite el cruce con `missed: true`. Ese dato se
  // perdía en el handler (`({lane, timestamp, lapTimeMs})`), así que las vueltas
  // repuestas tras un tirón de cable entraban SIN marcar — inútiles para
  // revisarlas en el corrector. Comprobado en el banco: 85 vueltas repuestas,
  // 0 marcadas.
  const e = escenario();
  darGo(e);
  const SerialService = require('../src/services/SerialService');
  const ahora = Date.now();

  // Un cruce normal y otro repuesto, en el mismo carril.
  SerialService.emit('lane_crossing', { lane: 1, timestamp: ahora, lapTimeMs: 9000 });
  SerialService.emit('lane_crossing', { lane: 1, timestamp: ahora + 9000, lapTimeMs: 9500 });
  SerialService.emit('lane_crossing', { lane: 1, timestamp: ahora + 19000, lapTimeMs: 9800, missed: true });

  const laps = db.prepare('SELECT lap_time_ms, is_estimated FROM laps WHERE manga_id = ? AND lane = 1 ORDER BY id').all(e.mangaId);
  assert.ok(laps.length >= 2, 'se registraron las vueltas');
  const repuesta = laps[laps.length - 1];
  assert.equal(repuesta.is_estimated, 1, 'la repuesta queda marcada');
  assert.ok(laps.slice(0, -1).every(l => l.is_estimated === 0), 'las reales, no');
});

test('arrancar una manga sobre otra no duplica el oyente de cruces', () => {
  // `_lapHandler` es un closure nuevo en cada `startManga`/`rehydrateManga`. Si se
  // reasigna sin soltar el anterior, el viejo sigue colgado de SerialService y
  // CADA cruce se escribe una vez por oyente: dos mangas encadenadas sin stop de
  // por medio duplicarían todas las vueltas de la carrera.
  const e = escenario();
  darGo(e);
  darGo(e);                       // segunda vez, sin stopManga entre medias
  const SerialService = require('../src/services/SerialService');

  assert.equal(SerialService.listenerCount('lane_crossing'), 1, 'un solo oyente');

  const ahora = Date.now();
  SerialService.emit('lane_crossing', { lane: 1, timestamp: ahora, lapTimeMs: 9000 });
  SerialService.emit('lane_crossing', { lane: 1, timestamp: ahora + 9000, lapTimeMs: 9500 });

  // El DS-300 trae el tiempo de vuelta en la propia trama, así que ya el primer
  // cruce registra vuelta: 2 cruces → 2 vueltas. Con el oyente duplicado serían 4.
  const n = db.prepare('SELECT COUNT(*) c FROM laps WHERE manga_id = ? AND lane = 1').get(e.mangaId).c;
  assert.equal(n, 2, 'cada cruce escribe UNA vuelta');
});
