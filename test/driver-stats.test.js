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
// Pilotos dentro de cada equipo: a quién va cada vuelta y que las vueltas de los
// pilotos sumen exactamente las del equipo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDriverStats, makeDriverResolver, sqliteUtcMs } = require('../src/lib/driverStats');

const GO = Date.UTC(2026, 9, 15, 20, 0, 0);
const lap = (o) => ({ manga_id: 1, lane: 3, team_id: 7, lap_number: 2, lap_time_ms: 15000,
  ts_ms: GO + 60000, is_exit: 0, is_pit_stop: 0, is_warmup: 0, is_estimated: 0, ...o });
const shift = (o) => ({ manga_id: 1, lane: 3, team_id: 7, driver_name: 'ANA', started_at_ms: GO, driving_ms: 1500000, ...o });

test('la hora de SQLite se lee como UTC, no como hora local', () => {
  assert.equal(sqliteUtcMs('2026-10-15 20:00:00'), GO);
  assert.equal(sqliteUtcMs(null), null);
});

test('relevo a mitad de manga: cada vuelta va a quien había fichado al cruzar', () => {
  const resolve = makeDriverResolver([
    shift({ driver_name: 'ANA', started_at_ms: GO }),
    shift({ driver_name: 'BRUNO', started_at_ms: GO + 600000 }),
  ]);
  assert.equal(resolve(lap({ ts_ms: GO + 599000 })), 'ANA');
  assert.equal(resolve(lap({ ts_ms: GO + 600000 })), 'BRUNO');
  // La vuelta se guarda al segundo (10:00 truncado): ese segundo ya es del nuevo piloto.
  assert.equal(resolve(lap({ ts_ms: GO + 599001 })), 'BRUNO');
});

test('el carril del turno no cuenta: manda el equipo (en la 24 h real salía desplazado)', () => {
  const resolve = makeDriverResolver([shift({ lane: 18 })]);
  assert.equal(resolve(lap({ lane: 20 })), 'ANA');
  assert.equal(resolve(lap({ team_id: 8 })), null);
});

test('vueltas antes del primer fichaje (fichaje tardío) quedan sin fichar', () => {
  const resolve = makeDriverResolver([shift({ started_at_ms: GO + 180000 })]);
  assert.equal(resolve(lap({ ts_ms: GO + 60000 })), null);
  assert.equal(resolve(lap({ ts_ms: GO + 200000 })), 'ANA');
  assert.equal(resolve(lap({ ts_ms: null })), 'ANA');
});

test('una vuelta con piloto propio (reconstrucción) no necesita turnos', () => {
  assert.equal(makeDriverResolver([])(lap({ driver_name: 'CARLA' })), 'CARLA');
});

test('las vueltas de los pilotos suman las del equipo, sin fichar incluido', () => {
  const laps = [
    lap({ lap_number: 1, is_warmup: 1, lap_time_ms: 3000, ts_ms: GO + 3000 }),
    lap({ lap_number: 2, lap_time_ms: 14800 }),
    lap({ lap_number: 3, lap_time_ms: 25000, is_exit: 1 }),
    lap({ lap_number: 4, lap_time_ms: 15200, ts_ms: GO + 700000 }),
    lap({ manga_id: 2, lap_number: 1, lap_time_ms: 15500 }),   // manga sin fichaje
  ];
  const shifts = [
    shift({ driver_name: 'ANA', driving_ms: 600000 }),
    shift({ driver_name: 'BRUNO', started_at_ms: GO + 600000, driving_ms: 900000 }),
  ];
  const { teams, mangasWithShifts, mangasRaced } = buildDriverStats({ laps, shifts });
  const t = teams.get(7);
  const ana = t.drivers.find(d => d.name === 'ANA');
  const bruno = t.drivers.find(d => d.name === 'BRUNO');
  assert.equal(ana.laps + bruno.laps + t.unassigned.laps, laps.length);
  assert.equal(ana.laps, 3);
  assert.equal(ana.exits, 1);
  assert.equal(ana.bestMs, 14800, 'ni el cruce de salida ni la salida son mejor vuelta');
  assert.equal(ana.avgMs, (14800 + 25000) / 2, 'la media no cuenta el cruce de salida, sí la salida');
  assert.equal(bruno.laps, 1);
  assert.equal(bruno.drivingMs, 900000);
  assert.equal(Math.round(bruno.lapsPerHour), 4);
  assert.equal(t.unassigned.laps, 1);
  assert.deepEqual([mangasWithShifts, mangasRaced], [1, 2]);
  assert.deepEqual(t.drivers.map(d => d.name), ['BRUNO', 'ANA'], 'primero quien más condujo');
});

test('un piloto con tiempo pero sin vueltas sale igual; sin fichar solo si tiene vueltas', () => {
  const { teams } = buildDriverStats({ laps: [], shifts: [shift({ driver_name: 'DANI' })] });
  assert.equal(teams.get(7).drivers[0].name, 'DANI');
  assert.equal(teams.get(7).unassigned, null);
});
