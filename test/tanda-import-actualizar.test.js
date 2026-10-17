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
// Reenviar las tandas de Control a una carrera ya importada (payload con
// race_id): las tandas que ya han rodado no se tocan; las pendientes se
// rehacen, las nuevas se crean y las que ya no vienen se borran.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db          = require('../src/config/database');
const Manga       = require('../src/models/Manga');
const TandaImport = require('../src/services/TandaImport');

function equipo(nombre, carril, pilotos = [nombre + ' A', nombre + ' B']) {
  return { nombre, carril_salida: carril, pilotos };
}

function payload(tandas, extra = {}) {
  return {
    schema: TandaImport.SCHEMA,
    prueba: { nombre: 'Resistencia', formato: 'PAREJAS' },
    carriles: 4,
    tandas,
    ...extra,
  };
}

function tandas(raceId) {
  return db.prepare('SELECT * FROM tandas WHERE race_id = ? ORDER BY number').all(raceId);
}

function equiposDe(tandaId) {
  return db.prepare('SELECT name FROM teams WHERE tanda_id = ? ORDER BY name').all(tandaId).map(r => r.name);
}

function pilotosDe(tandaId) {
  return db.prepare('SELECT name FROM drivers WHERE tanda_id = ? ORDER BY name').all(tandaId).map(r => r.name);
}

test('jueves corre la tanda 1; el reenvío del viernes no la toca y rehace el resto', () => {
  const creada = TandaImport.createFromPayload(payload([
    { numero: 1, equipos: [equipo('Rojo', 1), equipo('Azul', 2)] },
    { numero: 2, equipos: [equipo('Verde', 1), equipo('Negro', 2)] },
    { numero: 3, equipos: [equipo('Blanco', 1), equipo('Gris', 2)] },
  ]));
  const raceId = creada.raceId;
  const [t1, t2, t3] = tandas(raceId);
  assert.deepEqual([t1, t2, t3].map(t => t.control_numero), [1, 2, 3]);

  // La tanda 1 se corre: su primera manga arranca y registra una vuelta.
  const m1 = Manga.findByTanda(t1.id)[0];
  Manga.updateStatus(m1.id, 'finished');
  db.prepare('INSERT INTO laps (race_id, manga_id, lane, lap_number, lap_time_ms) VALUES (?, ?, 1, 1, 5000)')
    .run(raceId, m1.id);

  const r = TandaImport.updateFromPayload(raceId, payload([
    // Cambios en la 1 (ya corrida): se ignoran.
    { numero: 1, equipos: [equipo('Rojo', 1), equipo('Amarillo', 2)] },
    // La 2 cambia un piloto y añade un equipo.
    { numero: 2, equipos: [equipo('Verde', 1, ['Ana', 'Luis']), equipo('Negro', 2), equipo('Rosa', 3)] },
    // La 3 desaparece y llega una 4 nueva.
    { numero: 4, equipos: [equipo('Naranja', 1), equipo('Morado', 2)] },
  ]));

  assert.equal(r.actualizada, true);
  assert.deepEqual(r.bloqueadas, [1]);
  assert.deepEqual(r.actualizadas, [2]);
  assert.deepEqual(r.nuevas, [4]);
  assert.deepEqual(r.borradas, [3]);

  const despues = tandas(raceId);
  assert.deepEqual(despues.map(t => [t.number, t.control_numero]), [[1, 1], [2, 2], [3, 4]]);

  // La 1 sigue igual, con sus vueltas.
  assert.deepEqual(equiposDe(t1.id), ['Azul', 'Rojo']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM laps WHERE manga_id = ?').get(m1.id).n, 1);

  // La 2 es la misma fila de tanda, con los nuevos participantes y su rotación.
  assert.equal(despues[1].id, t2.id);
  assert.deepEqual(equiposDe(t2.id), ['Negro', 'Rosa', 'Verde']);
  assert.ok(pilotosDe(t2.id).includes('Ana'));
  assert.equal(Manga.findByTanda(t2.id).length, 3);

  // La 3 ya no existe y no deja equipos huérfanos.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tandas WHERE id = ?').get(t3.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM teams WHERE race_id = ? AND name IN ('Blanco','Gris')").get(raceId).n, 0);
});

test('una tanda creada a mano en Manager no se borra al reenviar', () => {
  const { raceId } = TandaImport.createFromPayload(payload([
    { numero: 1, equipos: [equipo('Rojo', 1), equipo('Azul', 2)] },
  ]));
  const Tanda = require('../src/models/Tanda');
  const manual = Tanda.create(raceId);

  const r = TandaImport.updateFromPayload(raceId, payload([
    { numero: 1, equipos: [equipo('Rojo', 2), equipo('Azul', 1)] },
  ]));
  assert.deepEqual(r.borradas, []);
  assert.ok(tandas(raceId).some(t => t.id === manual));
});

test('carrera inexistente o formato distinto → error legible', () => {
  assert.throws(() => TandaImport.updateFromPayload(999999, payload([
    { numero: 1, equipos: [equipo('Rojo', 1)] },
  ])), e => e.key === 'carrera_no_existe');

  const { raceId } = TandaImport.createFromPayload(payload([
    { numero: 1, equipos: [equipo('Rojo', 1)] },
  ]));
  assert.throws(() => TandaImport.updateFromPayload(raceId, {
    ...payload([{ numero: 1, equipos: [equipo('Rojo', 1)] }]),
    prueba: { nombre: 'Resistencia', formato: 'INDIVIDUAL' },
  }), e => e.key === 'formato_distinto');
});

test('con pole: se reemplazan los participantes mientras la pole no haya empezado', () => {
  const { raceId } = TandaImport.createFromPayload(payload([
    { numero: 1, equipos: [equipo('Rojo', 0), equipo('Azul', 0)] },
  ], { pole: true }));

  const r = TandaImport.updateFromPayload(raceId, payload([
    { numero: 1, equipos: [equipo('Rojo', 0), equipo('Azul', 0), equipo('Verde', 0)] },
  ], { pole: true }));
  assert.equal(r.teams, 3);

  db.prepare("UPDATE pole_sessions SET status = 'running' WHERE race_id = ?").run(raceId);
  assert.throws(() => TandaImport.updateFromPayload(raceId, payload([
    { numero: 1, equipos: [equipo('Rojo', 0)] },
  ], { pole: true })), e => e.key === 'pole_ya_corrida');
});
