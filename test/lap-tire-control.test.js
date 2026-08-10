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
// El widget de estrategia de neumáticos del cliente Lap usaba un nº de juegos
// puramente local (por defecto 4), sin relación con `tire_pairs_per_team` de
// la carrera ni con las entregas reales registradas por la organización — así
// que un equipo con dotación 12 podía ver "3 restantes" sin sentido. Ahora
// `LapController._buildTireControl` manda el dato real cuando la carrera lleva
// control (allowance > 0); si no lo lleva, el cliente sigue con su
// configuración manual de respaldo (eso NO lo prueba este fichero, es 100%
// cliente).
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db             = require('../src/config/database');
const Race           = require('../src/models/Race');
const TireChange     = require('../src/models/TireChange');
const LapController  = require('../src/controllers/LapController');

function nuevaCarrera(tirePairs) {
  return Race.create({
    name: 'Resis', type: 'championship', format: 'team',
    lanes_count: 6, lane_sequence: [1,2,3,4,5,6], manga_duration_minutes: 5,
    tire_pairs_per_team: tirePairs,
  });
}
function nuevoEquipo(raceId, name) {
  return db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, NULL, ?, 0, ?)')
    .run(raceId, name, '#abc').lastInsertRowid;
}

test('sin control de neumáticos (allowance=0) → tireControl es null', () => {
  const raceId = nuevaCarrera(0);
  const teamId = nuevoEquipo(raceId, 'Equipo A');
  const race = Race.findById(raceId);
  const team = { id: teamId, name: 'Equipo A' };
  assert.equal(LapController._buildTireControl(race, team), null);
});

test('con control (allowance=12) y CERO entregas → allowance=12, used=0, available=12', () => {
  const raceId = nuevaCarrera(12);
  const teamId = nuevoEquipo(raceId, 'Equipo A');
  const race = Race.findById(raceId);
  const team = { id: teamId, name: 'Equipo A' };
  const tc = LapController._buildTireControl(race, team);
  assert.deepEqual(tc, { allowance: 12, used: 0, available: 12 });
});

test('tras entregar el juego inicial (used=1) → available=11', () => {
  const raceId = nuevaCarrera(12);
  const teamId = nuevoEquipo(raceId, 'Equipo A');
  TireChange.add({ raceId, teamId, createdAtMs: Date.now() });   // juego inicial
  const race = Race.findById(raceId);
  const team = { id: teamId, name: 'Equipo A' };
  const tc = LapController._buildTireControl(race, team);
  assert.deepEqual(tc, { allowance: 12, used: 1, available: 11 });
});

test('_buildTeamSnapshot incluye tireControl con el dato real (no el local por defecto)', () => {
  const raceId = nuevaCarrera(12);
  const teamId = nuevoEquipo(raceId, 'Equipo A');
  TireChange.add({ raceId, teamId, createdAtMs: Date.now() });
  const race = Race.findById(raceId);
  const team = { id: teamId, name: 'Equipo A', color: '#abc', race_id: raceId };
  const snap = LapController._buildTeamSnapshot(race, team);
  assert.deepEqual(snap.tireControl, { allowance: 12, used: 1, available: 11 });
});

test('emparejamiento por equipo CANÓNICO (menor id por nombre, como el resto de tiras)', () => {
  const raceId = nuevaCarrera(4);
  const idMaestro = nuevoEquipo(raceId, 'Equipo A');   // fila maestra, menor id
  const idTanda    = nuevoEquipo(raceId, 'Equipo A');  // 2ª fila, misma carrera (otra tanda)
  TireChange.add({ raceId, teamId: idMaestro, createdAtMs: Date.now() });

  const race = Race.findById(raceId);
  const tc = LapController._buildTireControl(race, { id: idTanda, name: 'Equipo A' });
  assert.deepEqual(tc, { allowance: 4, used: 1, available: 3 }, 'debe ver el mismo cómputo aunque su propia fila no sea la canónica');
});
