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
// Crear tandas SIN llenar todos los carriles. Dos modos:
//   'fixed'  → sobran los carriles de mayor número (nadie corre por ellos).
//   'rotate' → el hueco rota manga a manga; todos pasan por todos los carriles.
// Un carril libre NUNCA genera fila en manga_lanes → ni vueltas ni clasificación
// fantasma (entidad NULL).
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db              = require('../src/config/database');
const Race            = require('../src/models/Race');
const Tanda           = require('../src/models/Tanda');
const Manga           = require('../src/models/Manga');
const Driver          = require('../src/models/Driver');
const TandaController = require('../src/controllers/TandaController');

// entidades pilotos e1..eN
function drivers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'driver', name: 'e' + (i + 1) }));
}

// ── buildSchedule: modo 'fixed' (histórico) ────────────────────────────────────
test('fixed: menos pilotos que carriles → solo los N primeros, sin huecos', () => {
  const seq = [1, 2, 3, 4, 5, 6, 7, 8];
  const sched = Manga.buildSchedule(seq, drivers(6), 1, 1, 'fixed');

  // Ciclo = 6 mangas (N entidades), no 8.
  assert.equal(sched.length, 6);
  // Cada manga tiene exactamente 6 slots reales, ninguno vacío.
  for (const manga of sched) {
    assert.equal(manga.length, 6);
    assert.ok(manga.every(s => !s.isEmpty));
    // Solo carriles 1..6 aparecen jamás.
    assert.ok(manga.every(s => s.lane >= 1 && s.lane <= 6));
  }
});

// ── buildSchedule: modo 'rotate' ───────────────────────────────────────────────
test('rotate: menos pilotos que carriles → ciclo completo y hueco que rota', () => {
  const seq = [1, 2, 3, 4, 5, 6, 7, 8];
  const sched = Manga.buildSchedule(seq, drivers(6), 1, 1, 'rotate');

  // Ciclo = 8 mangas (una por carril activo).
  assert.equal(sched.length, 8);

  for (const manga of sched) {
    // 8 slots: 6 reales + 2 huecos vacíos.
    assert.equal(manga.length, 8);
    assert.equal(manga.filter(s => s.isEmpty).length, 2);
    assert.equal(manga.filter(s => !s.isEmpty).length, 6);
    // Los huecos tienen entidad nula y NO son descanso (caen en carril real).
    for (const empty of manga.filter(s => s.isEmpty)) {
      assert.equal(empty.entity, null);
      assert.equal(empty.isRest, false);
      assert.ok(empty.lane >= 1 && empty.lane <= 8);
    }
  }

  // El hueco rota: el conjunto de carriles libres cambia entre mangas.
  const freeLanesM1 = new Set(sched[0].filter(s => s.isEmpty).map(s => s.lane));
  const freeLanesM2 = new Set(sched[1].filter(s => s.isEmpty).map(s => s.lane));
  assert.notDeepEqual([...freeLanesM1].sort(), [...freeLanesM2].sort());

  // Cada piloto REAL pasa por los 8 carriles a lo largo de las 8 mangas.
  const lanesByDriver = {};
  for (const manga of sched) {
    for (const s of manga) {
      if (s.isEmpty) continue;
      (lanesByDriver[s.entity.id] ||= new Set()).add(s.lane);
    }
  }
  for (const id of Object.keys(lanesByDriver)) {
    assert.equal(lanesByDriver[id].size, 8, `piloto ${id} debería pasar por 8 carriles`);
  }
});

test('rotate: con el cupo lleno se comporta igual que fixed', () => {
  const seq = [1, 2, 3, 4, 5, 6];
  const a = Manga.buildSchedule(seq, drivers(6), 1, 1, 'rotate');
  const b = Manga.buildSchedule(seq, drivers(6), 1, 1, 'fixed');
  assert.deepEqual(a, b);
  assert.ok(a.every(m => m.every(s => !s.isEmpty)));
});

test('rotate: un solo piloto, 8 carriles → 8 mangas y corre en todos', () => {
  const sched = Manga.buildSchedule([1, 2, 3, 4, 5, 6, 7, 8], drivers(1), 1, 1, 'rotate');
  assert.equal(sched.length, 8);
  const lanes = new Set(sched.map(m => m.find(s => !s.isEmpty).lane));
  assert.equal(lanes.size, 8);
});

// ── persistSchedule: los huecos NO crean fila ─────────────────────────────────
test('persistSchedule: un carril libre no genera fila en manga_lanes', () => {
  const raceId = Race.create({
    name: 'vacios', type: 'club', format: 'individual',
    lanes_count: 8, lane_sequence: [1, 2, 3, 4, 5, 6, 7, 8], manga_duration_minutes: 5,
  });
  const tandaId = Tanda.create(raceId, 'rotate');
  // Pilotos reales (la FK de manga_lanes.driver_id exige que existan).
  const ents = Array.from({ length: 6 }, (_, i) => {
    const id = Driver.create({ race_id: raceId, tanda_id: tandaId, team_id: null, name: 'e' + (i + 1), lane: i + 1, car_number: i + 1 });
    return { id, type: 'driver', name: 'e' + (i + 1) };
  });
  const sched = Manga.buildSchedule(Race.getLaneSequence(Race.findById(raceId)), ents, 1, 1, 'rotate');
  Manga.persistSchedule(tandaId, raceId, sched);

  const mangas = Manga.findByTanda(tandaId);
  assert.equal(mangas.length, 8);

  for (const m of mangas) {
    const lanes = Manga.getLanes(m.id);
    // Solo 6 filas por manga (los 2 huecos no se guardan).
    assert.equal(lanes.length, 6);
    // Ninguna fila con entidad nula (ni team_id ni driver_id): sin fantasmas.
    assert.ok(lanes.every(l => l.team_id != null || l.driver_id != null));
  }

  // No hay NINGUNA fila con is_rest=0 y entidad nula en toda la carrera.
  const fantasmas = db.prepare(`
    SELECT COUNT(*) AS n FROM manga_lanes ml
    JOIN mangas m ON m.id = ml.manga_id
    WHERE m.race_id = ? AND ml.is_rest = 0 AND ml.team_id IS NULL AND ml.driver_id IS NULL
  `).get(raceId).n;
  assert.equal(fantasmas, 0);

  // scheduledCountByRace: 6 entidades, cada una con 8 mangas; sin entidad NULL.
  const counts = Manga.scheduledCountByRace(raceId);
  assert.equal(counts.length, 6);
  assert.ok(counts.every(c => c.entity_id != null && c.total_mangas === 8));
});

// ── Flujo completo por el controlador (formato individual) ─────────────────────
function reqres(raceId, body) {
  let redirected = null, rendered = null;
  const req = { params: { id: String(raceId) }, body, t: (k) => k };
  const res = {
    redirect: (url) => { redirected = url; },
    status: () => res,
    render: (view, data) => { rendered = { view, data }; },
    json: () => {},
  };
  return { req, res, get redirect() { return redirected; }, get rendered() { return rendered; } };
}

test('controller.create: tanda individual con carriles vacíos (rotate)', () => {
  const raceId = Race.create({
    name: 'ctrl-rotate', type: 'club', format: 'individual',
    lanes_count: 8, lane_sequence: [1, 2, 3, 4, 5, 6, 7, 8], manga_duration_minutes: 5,
  });
  const rr = reqres(raceId, { drivers: ['a', 'b', 'c', 'd', 'e', 'f'], empty_lane_mode: 'rotate' });
  TandaController.create(rr.req, rr.res);

  assert.equal(rr.redirect, `/races/${raceId}`);
  const tanda = Tanda.findByRace(raceId)[0];
  assert.equal(tanda.empty_lane_mode, 'rotate');
  assert.equal(tanda.driver_count, 6);
  assert.equal(tanda.manga_count, 8);
});

test('controller.create: tanda individual con carriles vacíos (fixed, por defecto)', () => {
  const raceId = Race.create({
    name: 'ctrl-fixed', type: 'club', format: 'individual',
    lanes_count: 8, lane_sequence: [1, 2, 3, 4, 5, 6, 7, 8], manga_duration_minutes: 5,
  });
  // sin empty_lane_mode en el body → 'fixed'
  const rr = reqres(raceId, { drivers: ['a', 'b', 'c', 'd', 'e', 'f'] });
  TandaController.create(rr.req, rr.res);

  const tanda = Tanda.findByRace(raceId)[0];
  assert.equal(tanda.empty_lane_mode, 'fixed');
  assert.equal(tanda.manga_count, 6); // ciclo colapsado
});

test('controller.create: sin ningún participante → error, no crea la tanda', () => {
  const raceId = Race.create({
    name: 'ctrl-vacio', type: 'club', format: 'individual',
    lanes_count: 6, lane_sequence: [1, 2, 3, 4, 5, 6], manga_duration_minutes: 5,
  });
  const rr = reqres(raceId, { drivers: ['', '  ', ''] });
  TandaController.create(rr.req, rr.res);

  assert.equal(rr.redirect, null);
  assert.ok(rr.rendered.data.errors.includes('no_participants'));
  assert.equal(Tanda.findByRace(raceId).length, 0);
});
