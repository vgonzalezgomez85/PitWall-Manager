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
// Tras la pole, el organizador puede partir el campo en varias tandas de tamaño
// libre; en cada una los carriles van por orden de pole con la misma plantilla
// (laneSeq del circuito). El flujo clásico de UNA tanda no debe cambiar.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const db            = require('../src/config/database');
const Race          = require('../src/models/Race');
const PoleSession   = require('../src/models/PoleSession');
const PoleController = require('../src/controllers/PoleController');

// Crea una carrera individual con pole y N clasificados con tiempo (orden a..).
function escenario(nEntries, laneSeq = [1, 3, 5, 6, 4, 2]) {
  const raceId = Race.create({
    name: 'multi', type: 'club', format: 'individual',
    lanes_count: laneSeq.filter(l => l > 0).length,
    lane_sequence: laneSeq, manga_duration_minutes: 6,
    has_pole: 1, min_lap_ms: 3000,
  });
  const sessionId = PoleSession.create(raceId);
  const nombres = Array.from({ length: nEntries }, (_, i) => 'p' + String(i + 1).padStart(2, '0'));
  nombres.forEach((n, i) => {
    const eid = PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: n, membersJson: null });
    // Tiempos crecientes → el orden de pole es p01, p02, … (getEntriesSorted por tiempo).
    PoleSession.updateEntryTime(eid, 11000 + i * 100);
  });
  return { raceId, sessionId, nombres };
}

// req/res de pega para el handler.
function reqres(raceId, body) {
  let redirected = null;
  const req = { params: { id: String(raceId) }, body, t: (k) => k };
  const res = {
    redirect: (url) => { redirected = url; },
    status: () => res,
    render: () => {},
    json: () => {},
  };
  return { req, res, get redirect() { return redirected; } };
}

function tandasDe(raceId) {
  return db.prepare('SELECT id, number FROM tandas WHERE race_id = ? ORDER BY number').all(raceId);
}
function mangasDe(tandaId) {
  return db.prepare('SELECT id, number FROM mangas WHERE tanda_id = ? ORDER BY number').all(tandaId);
}
function pilotosDe(tandaId) {
  return db.prepare('SELECT name FROM drivers WHERE tanda_id = ? ORDER BY id').all(tandaId).map(d => d.name);
}

test('multi-tanda: reparte los clasificados en tandas de distinto tamaño', () => {
  const { raceId } = escenario(20);
  // 3 tandas 7/7/6 asignadas a mano (contiguo por pole).
  const tanda_of = {};
  const grupos = [7, 7, 6];
  let idx = 0;
  grupos.forEach((size, g) => { for (let k = 0; k < size; k++) tanda_of['p' + String(++idx).padStart(2, '0')] = g + 1; });

  const rr = reqres(raceId, { num_tandas: '3', tanda_of });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  assert.equal(tandas.length, 3, 'se crean 3 tandas');
  assert.deepEqual(tandas.map(t => pilotosDe(t.id).length), [7, 7, 6], 'tamaños 7/7/6 respetados');

  // La tanda 1 lleva a los 7 mejores de pole, en orden.
  assert.deepEqual(pilotosDe(tandas[0].id), ['p01','p02','p03','p04','p05','p06','p07']);
  assert.deepEqual(pilotosDe(tandas[2].id), ['p15','p16','p17','p18','p19','p20']);
});

test('multi-tanda: cada tanda genera sus mangas con la rotación del circuito', () => {
  const { raceId } = escenario(20);
  const tanda_of = {};
  [7, 7, 6].forEach((size, g) => { /* asigna contiguo */ });
  let idx = 0;
  [7, 7, 6].forEach((size, g) => { for (let k = 0; k < size; k++) tanda_of['p' + String(++idx).padStart(2, '0')] = g + 1; });

  const rr = reqres(raceId, { num_tandas: '3', tanda_of });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  // 6 carriles activos: una tanda de 7 → 7 pasos de rotación (7 mangas, 1 descanso/ manga);
  // una de 6 → 6 mangas. Comprobamos que hay mangas y que un carril de la manga 1
  // de la tanda 1 corresponde al poleman de esa tanda.
  const t1 = tandas[0];
  const mangasT1 = mangasDe(t1.id);
  assert.equal(mangasT1.length, 7, 'tanda de 7 pilotos → 7 mangas de rotación');
  assert.equal(mangasDe(tandas[2].id).length, 6, 'tanda de 6 pilotos → 6 mangas');

  // El poleman de la tanda 1 (p01) arranca en el primer carril de la secuencia (1).
  const m1 = mangasT1[0];
  const fila = db.prepare(`
    SELECT ml.lane FROM manga_lanes ml
    JOIN drivers d ON d.id = ml.driver_id
    WHERE ml.manga_id = ? AND d.name = 'p01'`).get(m1.id);
  assert.equal(fila.lane, 1, 'p01 (pole de su tanda) sale en laneSeq[0] = 1');
});

test('un sin asignar no se pierde: cae en la última tanda', () => {
  const { raceId } = escenario(6);
  // Solo asignamos 5; p06 queda fuera del mapa.
  const tanda_of = { p01: 1, p02: 1, p03: 1, p04: 2, p05: 2 };
  const rr = reqres(raceId, { num_tandas: '2', tanda_of });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  assert.deepEqual(pilotosDe(tandas[1].id).sort(), ['p04', 'p05', 'p06'], 'p06 sin asignar → última tanda');
});

test('modo clásico (1 tanda) intacto: order[] crea una sola tanda', () => {
  const { raceId } = escenario(6);
  const rr = reqres(raceId, { order: ['p01','p02','p03','p04','p05','p06'] });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  assert.equal(tandas.length, 1, 'una sola tanda');
  assert.equal(pilotosDe(tandas[0].id).length, 6, 'con los 6 pilotos');
});

test('num_tandas = 1 se comporta como el modo clásico aunque venga tanda_of', () => {
  const { raceId } = escenario(6);
  const rr = reqres(raceId, { num_tandas: '1', order: ['p01','p02','p03','p04','p05','p06'], tanda_of: { p01: 1 } });
  PoleController.assignLanes(rr.req, rr.res);
  assert.equal(tandasDe(raceId).length, 1, 'no crea multi con num_tandas=1');
});
