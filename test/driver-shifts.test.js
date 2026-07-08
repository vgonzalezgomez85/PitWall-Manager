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
// Contrato del resumen de turnos de piloto (DriverShift). Es la fuente de verdad
// del informe final de la 24h, así que aquí se clavan los casos que hoy fallan:
// el fan-out del JOIN por nombre, los homónimos, el turno con driver_id NULL y
// el pre-arme descartado que se cuela como turno.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const DriverShift = require('../src/models/DriverShift');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

after(limpiarBdTemporal);

beforeEach(() => {
  // Orden inverso a las FK.
  for (const t of ['driver_shifts', 'manga_lanes', 'drivers', 'teams', 'mangas', 'tandas', 'races',
                   'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

const MIN = 60_000;

// Ana corre con "Equipo A". `otrosEquiposCatalogo` la mete además en otros
// equipos del catálogo (temporadas/categorías anteriores) que NO corren aquí.
function escenarioSimple({ otrosEquiposCatalogo = 0 } = {}) {
  const ana = { id: crearPerfil('Ana Ruiz'), nombre: 'Ana Ruiz' };
  crearEquipoCatalogo('Equipo A', [ana]);
  for (let i = 0; i < otrosEquiposCatalogo; i++) crearEquipoCatalogo(`Equipo viejo ${i + 1}`, [ana]);
  const carrera = crearCarreraConManga([{ nombre: 'Equipo A', pilotos: [ana] }]);
  return { ana, ...carrera };
}

/** Abre un turno rodado y lo cierra con `ms` de conducción. */
function turnoCerrado({ mangaId, raceId, team, ms, desde = 1000 }) {
  const id = DriverShift.openShift({
    mangaId, raceId, lane: team.lane, teamId: team.id,
    driverId: team.drivers[0].id, driverName: team.drivers[0].name, startedAtMs: desde,
  });
  DriverShift.closeShift(id, desde + ms, ms);
  return id;
}

test('un turno de 10 min suma 10 min al piloto', () => {
  const { ana, raceId, mangaId, teams } = escenarioSimple();
  turnoCerrado({ mangaId, raceId, team: teams[0], ms: 10 * MIN });

  const [r] = DriverShift.raceSummary(raceId);
  assert.equal(r.profile_id, ana.id);
  assert.equal(r.total_ms, 10 * MIN);
  assert.equal(r.runs_count, 1);
  assert.equal(DriverShift.totalDrivingMsByDriverInRace(raceId, ana.id), 10 * MIN);
});

test('un piloto en DOS equipos del catálogo no duplica su tiempo ni sus turnos', () => {
  const { ana, raceId, mangaId, teams } = escenarioSimple({ otrosEquiposCatalogo: 1 });
  turnoCerrado({ mangaId, raceId, team: teams[0], ms: 10 * MIN });

  const filas = DriverShift.raceSummary(raceId).filter(r => r.profile_id === ana.id);
  assert.equal(filas.length, 1, 'el piloto debe aparecer una sola vez');
  assert.equal(filas[0].total_ms, 10 * MIN, 'el total NO debe multiplicarse por los equipos del catálogo');
  assert.equal(filas[0].runs_count, 1, 'los turnos NO deben multiplicarse');
  assert.equal(DriverShift.totalDrivingMsByDriverInRace(raceId, ana.id), 10 * MIN);
});

test('dos pilotos homónimos no se cruzan el tiempo', () => {
  const ana1 = { id: crearPerfil('Ana Ruiz'), nombre: 'Ana Ruiz' };
  const ana2 = { id: crearPerfil('Ana Ruiz'), nombre: 'Ana Ruiz' };  // otra persona, mismo nombre
  crearEquipoCatalogo('Equipo A', [ana1]);            // el que corre
  crearEquipoCatalogo('Equipo Z', [ana2]);            // otro equipo del catálogo
  const { raceId, mangaId, teams } = crearCarreraConManga([{ nombre: 'Equipo A', pilotos: [ana1] }]);

  turnoCerrado({ mangaId, raceId, team: teams[0], ms: 10 * MIN });

  const filas = DriverShift.raceSummary(raceId);
  assert.equal(filas.length, 1, 'solo debe aparecer la Ana que corrió');
  assert.equal(filas[0].profile_id, ana1.id);
  assert.equal(filas[0].total_ms, 10 * MIN);
  assert.equal(DriverShift.totalDrivingMsByDriverInRace(raceId, ana2.id), 0,
    'el tiempo de una no puede atribuirse a su homónima');
});

test('un pre-arme DESCARTADO no cuenta como turno', () => {
  const { ana, raceId, mangaId, teams } = escenarioSimple();
  const t = teams[0];

  // El staff pre-arma a Ana… y luego cambia de idea (la descarta antes del GO).
  const preArme = DriverShift.openShift({
    mangaId, raceId, lane: 1, teamId: t.id,
    driverId: t.drivers[0].id, driverName: 'Ana Ruiz', preArmed: true,
  });
  DriverShift.closeShift(preArme, 500, 0);          // descartado, nunca arrancó

  // Llega el GO: solo debe activar los pre-armes que sigan ABIERTOS.
  DriverShift.activatePreArmedShifts(mangaId, 1000);

  const fila = DriverShift.raceSummary(raceId).find(r => r.profile_id === ana.id);
  assert.equal(fila.runs_count, 0, 'un pre-arme descartado no es un turno rodado');
  assert.equal(fila.total_ms, 0);
});

test('un turno cuyo piloto se borró (driver_id NULL) no se pierde del total', () => {
  const { ana, raceId, mangaId, teams } = escenarioSimple();
  const t = teams[0];
  const id = turnoCerrado({ mangaId, raceId, team: t, ms: 10 * MIN });

  // ON DELETE SET NULL: el turno sobrevive, pero pierde el driver_id.
  db.prepare('DELETE FROM drivers WHERE id = ?').run(t.drivers[0].id);
  assert.equal(db.prepare('SELECT driver_id FROM driver_shifts WHERE id = ?').get(id).driver_id, null);

  assert.equal(DriverShift.totalDrivingMsByDriverInRace(raceId, ana.id), 10 * MIN,
    'el tiempo ya rodado no puede evaporarse al borrar la ficha del piloto');
});

test('el tiempo manual se contabiliza una sola vez y queda marcado', () => {
  const { ana, raceId, mangaId, teams } = escenarioSimple();
  const t = teams[0];
  DriverShift.addManualTime({
    mangaId, raceId, lane: 1, teamId: t.id,
    driverId: t.drivers[0].id, driverName: 'Ana Ruiz', drivingMs: 5 * MIN, atMs: 900_000,
  });

  const fila = DriverShift.raceSummary(raceId).find(r => r.profile_id === ana.id);
  assert.equal(fila.total_ms, 5 * MIN);
  assert.equal(fila.runs_count, 1);
  assert.equal(fila.manual_count, 1);
});

// ── Stop forzado ────────────────────────────────────────────────────────────
// Se descarta el tiempo de ESA manga, no el total ya registrado en las
// anteriores, y se conserva quién está en cada carril (no hay que reescanear).

test('el stop forzado pone a cero la manga, conserva el piloto y espera al nuevo GO', () => {
  const { ana, raceId, teams } = escenarioSimple();
  const t = teams[0];

  // Manga 1, ya terminada: Ana rodó 20 min. Esto NO se toca.
  const manga1 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES ((SELECT id FROM tandas WHERE race_id=?), ?, 2)')
    .run(raceId, raceId).lastInsertRowid;
  turnoCerrado({ mangaId: manga1, raceId, team: t, ms: 20 * MIN });

  // Manga 2 en curso: Ana lleva 7 min cuando llega el stop forzado.
  const manga2 = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES ((SELECT id FROM tandas WHERE race_id=?), ?, 3)')
    .run(raceId, raceId).lastInsertRowid;
  const abierto = DriverShift.openShift({
    mangaId: manga2, raceId, lane: 1, teamId: t.id,
    driverId: t.drivers[0].id, driverName: 'Ana Ruiz', startedAtMs: 1000,
  });
  DriverShift.updateDrivingMs(abierto, 7 * MIN);

  DriverShift.resetForRestart(manga2);

  const fila = db.prepare('SELECT * FROM driver_shifts WHERE manga_id = ?').get(manga2);
  assert.equal(fila.driving_ms, 0, 'el tiempo de esta manga se descarta');
  assert.equal(fila.started_at_ms, null);
  assert.equal(fila.ended_at_ms, null);
  assert.equal(fila.pre_armed, 1, 'queda pre-armado, esperando el nuevo GO');
  assert.equal(fila.driver_name, 'Ana Ruiz', 'se conserva quién está en el carril');

  assert.equal(DriverShift.totalDrivingMsByDriverInRace(raceId, ana.id), 20 * MIN,
    'el total de las mangas anteriores NO se toca');

  // Con el nuevo GO vuelve a contar desde cero.
  DriverShift.activatePreArmedShifts(manga2, 50_000);
  const tras = db.prepare('SELECT * FROM driver_shifts WHERE manga_id = ?').get(manga2);
  assert.equal(tras.started_at_ms, 50_000);
  assert.equal(tras.pre_armed, 0);
});

test('el stop forzado deja UN piloto por carril: el último fichado', () => {
  const { raceId, mangaId, teams } = escenarioSimple();
  const t = teams[0];
  const bea = { id: crearPerfil('Bea Soler'), nombre: 'Bea Soler' };
  db.prepare('INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES ((SELECT id FROM teams_catalog WHERE name=?), ?, ?, 1)')
    .run('Equipo A', bea.id, bea.nombre);
  const beaDriverId = db.prepare('INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, (SELECT id FROM tandas WHERE race_id=?), ?, ?)')
    .run(raceId, raceId, t.id, bea.nombre).lastInsertRowid;

  // Ana rueda 5 min y en el relevo entra Bea, que lleva 3 min al stop forzado.
  const sAna = DriverShift.openShift({
    mangaId, raceId, lane: 1, teamId: t.id, driverId: t.drivers[0].id,
    driverName: 'Ana Ruiz', startedAtMs: 1000,
  });
  DriverShift.closeShift(sAna, 1000 + 5 * MIN, 5 * MIN);
  const sBea = DriverShift.openShift({
    mangaId, raceId, lane: 1, teamId: t.id, driverId: beaDriverId,
    driverName: 'Bea Soler', startedAtMs: 1000 + 5 * MIN,
  });
  DriverShift.updateDrivingMs(sBea, 3 * MIN);

  DriverShift.resetForRestart(mangaId);

  const filas = db.prepare('SELECT * FROM driver_shifts WHERE manga_id = ?').all(mangaId);
  assert.equal(filas.length, 1, 'un solo turno por carril');
  assert.equal(filas[0].driver_name, 'Bea Soler', 'el que está en el coche ahora');
  assert.equal(filas[0].driving_ms, 0);
  assert.equal(filas[0].pre_armed, 1);
  assert.equal(DriverShift.raceSummary(raceId).reduce((s, r) => s + r.total_ms, 0), 0,
    'el tiempo de la tirada abortada se descarta entero');
});
