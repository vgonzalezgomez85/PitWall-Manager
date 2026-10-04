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
// Exportar / importar UNA carrera completa (.pwrace) entre instalaciones.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db          = require('../src/config/database');
const RaceArchive = require('../src/services/RaceArchive');

function carreraCompleta({ status = 'finished', mangaStatus = 'finished', circuitName = 'Pista Club Rival' } = {}) {
  const circuitId = db.prepare("INSERT INTO circuits (name, lanes_count, min_lap_ms) VALUES (?, 4, 8000)").run(circuitName).lastInsertRowid;
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, lanes_count, manga_duration_minutes, status, circuit_id, race_key, finished_at)
    VALUES ('Resistencia Rival', 'championship', 'team', 4, 10, ?, ?, ?, '2026-09-20 18:00:00')
  `).run(status, circuitId, require('crypto').randomUUID()).lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number, status) VALUES (?, 1, ?)').run(raceId, status).lastInsertRowid;
  const teamA = db.prepare("INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, 'Equipo A', 1)").run(raceId, tandaId).lastInsertRowid;
  const teamB = db.prepare("INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, 'Equipo B', 2)").run(raceId, tandaId).lastInsertRowid;
  const drvA  = db.prepare("INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, 'Ana')").run(raceId, tandaId, teamA).lastInsertRowid;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number, status, actual_duration_ms) VALUES (?, ?, 1, ?, 600000)')
    .run(tandaId, raceId, mangaStatus).lastInsertRowid;
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, driver_id) VALUES (?, 1, ?, ?)').run(mangaId, teamA, drvA);
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id) VALUES (?, 2, ?)').run(mangaId, teamB);
  const insLap = db.prepare(`INSERT INTO laps (race_id, manga_id, driver_id, team_id, lane, lap_number, lap_time_ms, elapsed_ms, is_ghost, source_lap_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const real = insLap.run(raceId, mangaId, drvA, teamA, 1, 1, 9500, 9500, 0, null).lastInsertRowid;
  insLap.run(raceId, mangaId, drvA, teamA, 1, 2, 9400, 18900, 0, null);
  insLap.run(raceId, mangaId, null, teamB, 2, 1, 9800, 9800, 0, null);
  insLap.run(raceId, mangaId, null, teamB, 2, 2, 1200, 11000, 1, real);
  db.prepare("INSERT INTO driver_shifts (manga_id, race_id, lane, team_id, driver_id, driver_name, driving_ms) VALUES (?, ?, 1, ?, ?, 'Ana', 600000)")
    .run(mangaId, raceId, teamA, drvA);
  db.prepare('INSERT INTO tire_changes (race_id, team_id, manga_id, manga_number, created_at_ms) VALUES (?, ?, ?, 1, 1)').run(raceId, teamB, mangaId);
  db.prepare("INSERT INTO race_events (race_id, manga_id, manga_number, type, created_at_ms) VALUES (?, ?, 1, 'go', 1)").run(raceId, mangaId);
  db.prepare("INSERT INTO lap_tracking (race_id, team_name, tracked_name, position) VALUES (?, 'Equipo A', 'Equipo B', 1)").run(raceId);
  db.prepare("INSERT INTO verifications (race_id, manga_numero, equipo_nombre, fotos_json) VALUES (?, 1, 'Equipo A', '[{\"nombre\":\"f\"}]')").run(raceId);
  const poleId = db.prepare("INSERT INTO pole_sessions (race_id, status) VALUES (?, 'finished')").run(raceId).lastInsertRowid;
  db.prepare("INSERT INTO pole_entries (pole_session_id, entity_type, entity_name, lap_time_ms) VALUES (?, 'team', 'Equipo A', 9300)").run(poleId);
  db.prepare("INSERT OR IGNORE INTO categories (name) VALUES ('GT Rival')").run();
  const catId = db.prepare("SELECT id FROM categories WHERE name = 'GT Rival'").get().id;
  db.prepare('INSERT INTO race_categories (race_id, category_id) VALUES (?, ?)').run(raceId, catId);
  return { raceId, circuitId, catId };
}

function borrarCarrera(raceId) {
  db.prepare('DELETE FROM pole_entries WHERE pole_session_id IN (SELECT id FROM pole_sessions WHERE race_id = ?)').run(raceId);
  db.prepare('DELETE FROM pole_sessions WHERE race_id = ?').run(raceId);
  db.prepare('DELETE FROM races WHERE id = ?').run(raceId);
}

const count = (sql, ...p) => db.prepare(sql).get(...p).n;

test('ida y vuelta: la carrera importada es idéntica, con ids nuevos y bien enlazados', () => {
  const { raceId } = carreraCompleta();
  const { buffer } = RaceArchive.exportRaceFile(raceId);
  borrarCarrera(raceId);

  const res = RaceArchive.importRace(RaceArchive.parseFile(buffer));
  const id = res.raceId;
  assert.equal(res.laps, 4);
  assert.equal(res.circuitCreated, false, 'el circuito ya existía por nombre');

  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(id);
  assert.equal(race.name, 'Resistencia Rival');
  assert.equal(race.status, 'finished');

  assert.equal(count('SELECT COUNT(*) n FROM teams WHERE race_id = ?', id), 2);
  assert.equal(count('SELECT COUNT(*) n FROM drivers WHERE race_id = ?', id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM laps WHERE race_id = ?', id), 4);
  assert.equal(count('SELECT COUNT(*) n FROM driver_shifts WHERE race_id = ?', id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM tire_changes WHERE race_id = ?', id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM race_events WHERE race_id = ?', id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM lap_tracking WHERE race_id = ?', id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM verifications WHERE race_id = ?', id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM pole_entries pe JOIN pole_sessions ps ON ps.id = pe.pole_session_id WHERE ps.race_id = ?', id), 1);
  assert.equal(count("SELECT COUNT(*) n FROM race_categories rc JOIN categories c ON c.id = rc.category_id WHERE rc.race_id = ? AND c.name = 'GT Rival'", id), 1);

  // Todas las referencias apuntan a filas de ESTA carrera.
  assert.equal(count(`SELECT COUNT(*) n FROM laps l JOIN mangas m ON m.id = l.manga_id
                      JOIN teams t ON t.id = l.team_id WHERE l.race_id = ? AND m.race_id = ? AND t.race_id = ?`, id, id, id), 4);
  assert.equal(count(`SELECT COUNT(*) n FROM manga_lanes ml JOIN mangas m ON m.id = ml.manga_id
                      JOIN teams t ON t.id = ml.team_id WHERE m.race_id = ? AND t.race_id = ?`, id, id), 2);
  const ghost = db.prepare('SELECT l.*, s.lap_time_ms AS src_ms, s.race_id AS src_race FROM laps l JOIN laps s ON s.id = l.source_lap_id WHERE l.race_id = ? AND l.is_ghost = 1').get(id);
  assert.equal(ghost.src_ms, 9500, 'la vuelta fantasma sigue apuntando a su vuelta real');
  assert.equal(ghost.src_race, id);
  const ana = db.prepare("SELECT d.team_id, t.name FROM drivers d JOIN teams t ON t.id = d.team_id WHERE d.race_id = ? AND d.name = 'Ana'").get(id);
  assert.equal(ana.name, 'Equipo A');
});

test('importar dos veces la misma carrera se rechaza', () => {
  const { raceId } = carreraCompleta({ circuitName: 'Pista Dup' });
  const archive = RaceArchive.exportRace(raceId);
  assert.throws(() => RaceArchive.importRace(archive), e => e.code === 'exists' && e.existingId === raceId);
});

test('el circuito que no existe en este PC se crea', () => {
  const { raceId, circuitId } = carreraCompleta({ circuitName: 'Pista Solo Fuera' });
  const archive = RaceArchive.exportRace(raceId);
  borrarCarrera(raceId);
  db.prepare('DELETE FROM circuits WHERE id = ?').run(circuitId);

  const res = RaceArchive.importRace(archive);
  assert.equal(res.circuitCreated, true);
  const c = db.prepare('SELECT c.name, c.min_lap_ms FROM races r JOIN circuits c ON c.id = r.circuit_id WHERE r.id = ?').get(res.raceId);
  assert.deepEqual({ ...c }, { name: 'Pista Solo Fuera', min_lap_ms: 8000 });
});

test('no se exporta una carrera con una manga sin cerrar', () => {
  const { raceId } = carreraCompleta({ status: 'active', mangaStatus: 'active', circuitName: 'Pista Abierta' });
  assert.throws(() => RaceArchive.exportRace(raceId), e => e.code === 'open_manga');
});

test('una carrera activa entra como pendiente para no quedarse con el GO', () => {
  const { raceId } = carreraCompleta({ status: 'active', circuitName: 'Pista Activa' });
  const archive = RaceArchive.exportRace(raceId);
  borrarCarrera(raceId);
  const { raceId: id } = RaceArchive.importRace(archive);
  assert.equal(db.prepare('SELECT status FROM races WHERE id = ?').get(id).status, 'pending');
});

test('columnas desconocidas se ignoran y un archivo de versión futura se rechaza', () => {
  const { raceId } = carreraCompleta({ circuitName: 'Pista Futura' });
  const archive = RaceArchive.exportRace(raceId);
  borrarCarrera(raceId);
  archive.race.columna_del_futuro = 'x';
  archive.tables.laps.forEach(l => { l.otra_columna = 1; });
  assert.ok(RaceArchive.importRace(archive).raceId);

  const nuevo = Buffer.from(JSON.stringify({ ...archive, version: RaceArchive.VERSION + 1 }));
  assert.throws(() => RaceArchive.parseFile(nuevo), e => e.code === 'newer_version');
  assert.throws(() => RaceArchive.parseFile(Buffer.from('no soy json')), e => e.code === 'bad_file');
  assert.throws(() => RaceArchive.parseFile(Buffer.from('{"format":"otro"}')), e => e.code === 'bad_file');
});
