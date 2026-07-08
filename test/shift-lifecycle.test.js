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
// Ciclo de vida completo del control de turnos, contra el TimingService real y
// la BD real. Es la especificación de la 24h de Llinars, ejecutable:
//
//   1. Manga sin empezar: los pilotos escanean su QR → quedan PRE-ARMADOS.
//      No se cuenta tiempo hasta el GO del DS.
//   2. Manga corriendo: cambio de piloto en caliente → el saliente se cierra
//      con su tiempo exacto, el entrante empieza a contar.
//   3. Pausa: se paran TODOS los contadores. Al reanudar, siguen donde estaban.
//   4. Stop forzado: se descarta el tiempo DE ESA MANGA (no el ya registrado en
//      mangas anteriores), se conserva quién está en cada carril, y se vuelve a
//      contar con el nuevo GO.
//   5. Fin de manga: se paran todos los contadores y se cierran los turnos.
//
// El tiempo no se espera: se rebobina el ancla del circuito, que es justo lo
// que el reloj de pared le habría hecho.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const DriverShift   = require('../src/models/DriverShift');
const Manga         = require('../src/models/Manga');
const TimingService = require('../src/services/TimingService');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

after(() => { try { TimingService.stopManga(false); } catch {} limpiarBdTemporal(); });

const MIN = 60000;

beforeEach(() => {
  try { TimingService.stopManga(false); } catch {}
  TimingService.session = null;
  TimingService._activeShiftsByLane = {};
  for (const t of ['driver_shifts', 'manga_lanes', 'drivers', 'teams', 'mangas', 'tandas', 'races',
                   'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

/** Dos equipos, un carril cada uno, dos pilotos por equipo. */
function escenario({ circuitsConfig = [2] } = {}) {
  const mk = (nombres, equipo) => {
    const perfiles = nombres.map(n => ({ nombre: n, id: crearPerfil(n) }));
    crearEquipoCatalogo(equipo, perfiles);
    return { nombre: equipo, pilotos: perfiles };
  };
  const eqA = mk(['Ana', 'Bea'],   'Equipo A');
  const eqB = mk(['Caro', 'Dani'], 'Equipo B');

  const { raceId, tandaId, mangaId, teams } = crearCarreraConManga([eqA, eqB], { circuitsConfig });
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return { raceId, tandaId, mangaId, race, manga, teams };
}

/** Arranca la manga como haría el GO del DS. */
function darGo({ manga, race, mangaId }, durationMs = 60 * MIN) {
  const lanes   = Manga.getLanes(mangaId);
  const teams   = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(manga.tanda_id);
  TimingService.startManga(manga, race, lanes, teams, drivers, durationMs);
}

/** Rebobina el ancla del circuito: equivale a que hayan pasado `ms` de reloj. */
function avanzar(ci, ms) {
  TimingService.session.circuits[ci].startTime -= ms;
}

/**
 * Igual, pero con el circuito PAUSADO. Hay que rebobinar startTime y pauseStart
 * a la vez: el elapsed (pauseStart − startTime) debe quedarse quieto —eso es lo
 * que significa estar en pausa— mientras el reloj de pared sí avanza, que es lo
 * que resumeCircuit mide para desplazar el ancla.
 */
function avanzarEnPausa(ci, ms) {
  const c = TimingService.session.circuits[ci];
  c.startTime  -= ms;
  c.pauseStart -= ms;
}

const turnos    = (mangaId) => db.prepare('SELECT * FROM driver_shifts WHERE manga_id = ? ORDER BY id').all(mangaId);
const abiertoEn = (mangaId, lane) => turnos(mangaId).find(s => s.lane === lane && s.ended_at_ms == null);
const casiIgual = (real, esp, tol = 300) =>
  assert.ok(Math.abs(real - esp) <= tol, `esperaba ~${esp} ms, obtuve ${real} ms (Δ ${real - esp})`);

// ── 1. Pre-arme: se registra, pero no cuenta hasta el GO ───────────────────

test('los QR escaneados antes del GO quedan pre-armados y no cuentan tiempo', () => {
  const esc = escenario();
  const [tA, tB] = esc.teams;

  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tA.lane,
    teamId: tA.id, driverId: tA.drivers[0].id, driverName: 'Ana', preArmed: true });
  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tB.lane,
    teamId: tB.id, driverId: tB.drivers[0].id, driverName: 'Caro', preArmed: true });

  const antes = turnos(esc.mangaId);
  assert.equal(antes.length, 2);
  assert.ok(antes.every(s => s.pre_armed === 1 && s.started_at_ms == null && s.driving_ms === 0),
    'antes del GO nadie cuenta tiempo');

  darGo(esc);

  const despues = turnos(esc.mangaId);
  assert.ok(despues.every(s => s.pre_armed === 0 && s.started_at_ms != null),
    'el GO activa los pre-armes');
  assert.equal(Object.keys(TimingService.getActiveShifts()).length, 2);
});

// ── 2. Cambio de piloto en caliente ────────────────────────────────────────

test('el cambio en caliente cierra al saliente con su tiempo y arranca al entrante', () => {
  const esc = escenario();
  const [tA] = esc.teams;
  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tA.lane,
    teamId: tA.id, driverId: tA.drivers[0].id, driverName: 'Ana', preArmed: true });
  darGo(esc);

  avanzar(0, 10 * MIN);   // Ana lleva 10 minutos

  TimingService.swapDriverOnLane({ lane: tA.lane, raceId: esc.raceId, mangaId: esc.mangaId,
    teamId: tA.id, driverId: tA.drivers[1].id, driverName: 'Bea' });

  const [ana, bea] = turnos(esc.mangaId).filter(s => s.lane === tA.lane);
  assert.equal(ana.driver_name, 'Ana');
  assert.ok(ana.ended_at_ms != null, 'Ana queda cerrada');
  casiIgual(ana.driving_ms, 10 * MIN);
  assert.equal(bea.driver_name, 'Bea');
  assert.equal(bea.ended_at_ms, null, 'Bea queda abierta');

  avanzar(0, 5 * MIN);    // otros 5 minutos, ya con Bea
  const activos = TimingService.getActiveShifts();
  casiIgual(activos[tA.lane].drivingMs, 5 * MIN);
  casiIgual(DriverShift.totalDrivingMsByDriverInRace(esc.raceId, tA.drivers[0].id) , 10 * MIN);
});

// ── 3. Pausa y reanudación ─────────────────────────────────────────────────

test('la pausa congela TODOS los contadores y la reanudación no cobra la pausa', () => {
  const esc = escenario();
  const [tA, tB] = esc.teams;
  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tA.lane,
    teamId: tA.id, driverId: tA.drivers[0].id, driverName: 'Ana', preArmed: true });
  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tB.lane,
    teamId: tB.id, driverId: tB.drivers[0].id, driverName: 'Caro', preArmed: true });
  darGo(esc);

  avanzar(0, 10 * MIN);
  TimingService.pauseManga();

  const enPausa = TimingService.getActiveShifts();
  casiIgual(enPausa[tA.lane].drivingMs, 10 * MIN);
  casiIgual(enPausa[tB.lane].drivingMs, 10 * MIN);

  // La pausa dura 7 minutos de reloj de pared.
  avanzarEnPausa(0, 7 * MIN);
  const trasEsperar = TimingService.getActiveShifts();
  casiIgual(trasEsperar[tA.lane].drivingMs, 10 * MIN, 300);   // sigue congelado

  TimingService.resumeManga();
  const trasResume = TimingService.getActiveShifts();
  casiIgual(trasResume[tA.lane].drivingMs, 10 * MIN, 500);    // la pausa no se cobra

  avanzar(0, 3 * MIN);
  casiIgual(TimingService.getActiveShifts()[tA.lane].drivingMs, 13 * MIN, 500);
});

// ── 4. Stop forzado ────────────────────────────────────────────────────────

test('el stop forzado descarta el tiempo de ESTA manga, conserva pilotos y espera al nuevo GO', () => {
  const esc = escenario();
  const [tA] = esc.teams;

  // Manga anterior YA registrada: 20 min de Ana. No se puede tocar.
  const tandaPrev = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 0)')
    .run(esc.tandaId, esc.raceId).lastInsertRowid;
  db.prepare(`INSERT INTO driver_shifts (manga_id, race_id, lane, team_id, driver_id, driver_name,
              started_at_ms, ended_at_ms, driving_ms, pre_armed) VALUES (?,?,?,?,?,?,1,2,?,0)`)
    .run(tandaPrev, esc.raceId, tA.lane, tA.id, tA.drivers[0].id, 'Ana', 20 * MIN);

  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tA.lane,
    teamId: tA.id, driverId: tA.drivers[0].id, driverName: 'Ana', preArmed: true });
  darGo(esc);
  avanzar(0, 12 * MIN);
  TimingService._persistAllDriverShifts();
  casiIgual(abiertoEn(esc.mangaId, tA.lane).driving_ms, 12 * MIN);

  TimingService.cancelManga();   // ← STOP FORZADO

  const tras = turnos(esc.mangaId);
  assert.equal(tras.length, 1, 'queda un turno por carril');
  assert.equal(tras[0].driver_name, 'Ana', 'no hay que volver a escanear el QR');
  assert.equal(tras[0].driving_ms, 0, 'el tiempo de esta manga se descarta');
  assert.equal(tras[0].pre_armed, 1, 'vuelve a estar pre-armado, esperando el GO');
  assert.equal(tras[0].started_at_ms, null);

  // El total del piloto conserva la manga anterior: 20 min, ni uno menos.
  assert.equal(DriverShift.totalDrivingMsByDriverInRace(esc.raceId, tA.drivers[0].id), 20 * MIN);

  // Nuevo GO: vuelve a contar desde cero en esta manga.
  const manga2 = db.prepare('SELECT * FROM mangas WHERE id = ?').get(esc.mangaId);
  darGo({ ...esc, manga: manga2 });
  avanzar(0, 4 * MIN);
  casiIgual(TimingService.getActiveShifts()[tA.lane].drivingMs, 4 * MIN);
  assert.equal(DriverShift.totalDrivingMsByDriverInRace(esc.raceId, tA.drivers[0].id), 20 * MIN,
    'el total en BD no cambia hasta que se persista el turno vivo');
});

// ── 5. Fin de manga ────────────────────────────────────────────────────────

test('el fin de manga para todos los contadores y cierra los turnos', () => {
  const esc = escenario();
  const [tA, tB] = esc.teams;
  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tA.lane,
    teamId: tA.id, driverId: tA.drivers[0].id, driverName: 'Ana', preArmed: true });
  DriverShift.openShift({ mangaId: esc.mangaId, raceId: esc.raceId, lane: tB.lane,
    teamId: tB.id, driverId: tB.drivers[0].id, driverName: 'Caro', preArmed: true });
  darGo(esc);
  avanzar(0, 25 * MIN);

  TimingService.stopManga(true);

  const tras = turnos(esc.mangaId);
  assert.equal(tras.length, 2);
  assert.ok(tras.every(s => s.ended_at_ms != null), 'todos los turnos quedan cerrados');
  tras.forEach(s => casiIgual(s.driving_ms, 25 * MIN));
  assert.deepEqual(TimingService.getActiveShifts(), {}, 'no queda ningún contador vivo');
});

// ── GO escalonado y fin escalonado, con 3 cajas (el montaje de Llinars) ────

test('con 3 cajas, cada circuito cuenta desde SU propio GO', () => {
  // 3 circuitos de 1 carril: la caja 1 arranca, las otras aún no.
  const perfiles = ['P1', 'P2', 'P3'].map(n => ({ nombre: n, id: crearPerfil(n) }));
  perfiles.forEach((p, i) => crearEquipoCatalogo(`E${i + 1}`, [p]));
  const equipos = perfiles.map((p, i) => ({ nombre: `E${i + 1}`, pilotos: [p] }));
  const { raceId, mangaId, teams } = crearCarreraConManga(equipos, { circuitsConfig: [1, 1, 1] });
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);

  teams.forEach((t, i) => DriverShift.openShift({ mangaId, raceId, lane: t.lane,
    teamId: t.id, driverId: t.drivers[0].id, driverName: perfiles[i].nombre, preArmed: true }));

  darGo({ manga, race, mangaId });      // solo arranca el circuito 0
  avanzar(0, 10 * MIN);

  let act = TimingService.getActiveShifts();
  casiIgual(act[1].drivingMs, 10 * MIN);
  assert.equal(act[2].drivingMs, 0, 'la caja 2 no ha recibido su GO');
  assert.equal(act[3].drivingMs, 0, 'la caja 3 tampoco');

  TimingService.startCircuit(1);        // GO de la caja 2, diez minutos más tarde
  avanzar(1, 4 * MIN);
  act = TimingService.getActiveShifts();
  casiIgual(act[1].drivingMs, 10 * MIN);
  casiIgual(act[2].drivingMs, 4 * MIN, 500);

  // La caja 1 termina antes: su piloto deja de sumar; el de la 2 sigue.
  TimingService.finishCircuit(0);
  const cerrado = turnos(mangaId).find(s => s.lane === 1);
  assert.ok(cerrado.ended_at_ms != null, 'el turno del circuito que acabó se cierra ahí mismo');
  casiIgual(cerrado.driving_ms, 10 * MIN);

  avanzar(1, 6 * MIN);
  act = TimingService.getActiveShifts();
  assert.equal(act[1], undefined, 'el carril del circuito finalizado ya no tiene contador vivo');
  casiIgual(act[2].drivingMs, 10 * MIN, 500);
});
