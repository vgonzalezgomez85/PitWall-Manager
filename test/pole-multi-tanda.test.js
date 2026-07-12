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

const LANESEQ = [1, 3, 5, 6, 4, 2];   // = escenario()

// slot[nombre] = "tanda:carril". Reparte cada grupo en los carriles del circuito
// (orden laneSeq) y manda al descanso (carril 0) lo que sobre de 6.
function slotsFromGroups(groups) {
  const slot = {};
  groups.forEach((names, gi) => {
    names.forEach((name, i) => {
      const lane = i < LANESEQ.length ? LANESEQ[i] : 0;
      slot[name] = (gi + 1) + ':' + lane;
    });
  });
  return slot;
}
function grupoContiguo(sizes) {
  const out = []; let idx = 0;
  sizes.forEach(size => { out.push(Array.from({ length: size }, () => 'p' + String(++idx).padStart(2, '0'))); });
  return out;
}

test('multi-tanda: reparte los clasificados en tandas de distinto tamaño', () => {
  const { raceId } = escenario(20);
  const grupos = grupoContiguo([7, 7, 6]);
  const rr = reqres(raceId, { num_tandas: '3', slot: slotsFromGroups(grupos) });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  assert.equal(tandas.length, 3, 'se crean 3 tandas');
  assert.deepEqual(tandas.map(t => pilotosDe(t.id).length), [7, 7, 6], 'tamaños 7/7/6 respetados');
  assert.deepEqual(pilotosDe(tandas[0].id), ['p01','p02','p03','p04','p05','p06','p07']);
  assert.deepEqual(pilotosDe(tandas[2].id), ['p15','p16','p17','p18','p19','p20']);
});

test('multi-tanda: cada tanda genera sus mangas con la rotación del circuito', () => {
  const { raceId } = escenario(20);
  const rr = reqres(raceId, { num_tandas: '3', slot: slotsFromGroups(grupoContiguo([7, 7, 6])) });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  const mangasT1 = mangasDe(tandas[0].id);
  assert.equal(mangasT1.length, 7, 'tanda de 7 pilotos → 7 mangas de rotación');
  assert.equal(mangasDe(tandas[2].id).length, 6, 'tanda de 6 pilotos → 6 mangas');

  // p01 se colocó en el carril 1 → arranca ahí en la manga 1.
  const fila = db.prepare(`
    SELECT ml.lane FROM manga_lanes ml
    JOIN drivers d ON d.id = ml.driver_id
    WHERE ml.manga_id = ? AND d.name = 'p01'`).get(mangasT1[0].id);
  assert.equal(fila.lane, 1, 'p01 sale en el carril donde lo colocaron (1)');
});

test('el carril lo decide la COLOCACIÓN, no el orden de pole', () => {
  const { raceId } = escenario(6);
  // p01 (pole) al carril 6, p02 al 1. En la manga 1 deben salir justo ahí.
  const slot = { p01: '1:6', p02: '1:1', p03: '1:3', p04: '1:5', p05: '1:4', p06: '1:2' };
  const rr = reqres(raceId, { num_tandas: '2', slot });   // solo tanda 1 tiene gente
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  const m1 = mangasDe(tandas[0].id)[0];
  const laneDe = (name) => db.prepare(`
    SELECT ml.lane FROM manga_lanes ml JOIN drivers d ON d.id = ml.driver_id
    WHERE ml.manga_id = ? AND d.name = ?`).get(m1.id, name)?.lane;
  assert.equal(laneDe('p01'), 6, 'p01 arranca en el carril 6 donde lo pusieron');
  assert.equal(laneDe('p02'), 1, 'p02 en el 1');
});

test('un piloto colocado en descanso (carril 0) sale en descanso en la manga 1', () => {
  const { raceId } = escenario(7);
  // 6 en carriles, p07 en descanso.
  const slot = slotsFromGroups([['p01','p02','p03','p04','p05','p06','p07']]);
  assert.equal(slot.p07, '1:0', 'p07 va al descanso');
  const rr = reqres(raceId, { num_tandas: '2', slot });
  PoleController.assignLanes(rr.req, rr.res);

  const t1 = tandasDe(raceId)[0];
  const m1 = mangasDe(t1.id)[0];
  const r = db.prepare(`
    SELECT ml.is_rest, ml.lane FROM manga_lanes ml JOIN drivers d ON d.id = ml.driver_id
    WHERE ml.manga_id = ? AND d.name = 'p07'`).get(m1.id);
  assert.equal(r.is_rest, 1, 'p07 descansa en la manga 1');
  assert.equal(r.lane, 0, 'y su carril es 0');
});

test('los no colocados simplemente no entran (la vista exige colocarlos todos)', () => {
  const { raceId } = escenario(6);
  // Solo 5 colocados; p06 no está en slot.
  const slot = { p01: '1:1', p02: '1:3', p03: '1:5', p04: '2:1', p05: '2:3' };
  const rr = reqres(raceId, { num_tandas: '2', slot });
  PoleController.assignLanes(rr.req, rr.res);

  const todos = tandasDe(raceId).flatMap(t => pilotosDe(t.id));
  assert.ok(!todos.includes('p06'), 'p06 no colocado → no aparece en ninguna tanda');
  assert.equal(todos.length, 5, 'solo los 5 colocados');
});

test('una sola tanda (N=1) con slot: coloca por carril explícito', () => {
  const { raceId } = escenario(6);
  // Mezclado a propósito: p01 al carril 5, p02 al 1, etc.
  const slot = { p01: '1:5', p02: '1:1', p03: '1:3', p04: '1:6', p05: '1:4', p06: '1:2' };
  const rr = reqres(raceId, { num_tandas: '1', slot });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  assert.equal(tandas.length, 1, 'una sola tanda');
  const m1 = mangasDe(tandas[0].id)[0];
  const laneDe = (name) => db.prepare(`
    SELECT ml.lane FROM manga_lanes ml JOIN drivers d ON d.id = ml.driver_id
    WHERE ml.manga_id = ? AND d.name = ?`).get(m1.id, name)?.lane;
  assert.equal(laneDe('p01'), 5, 'p01 arranca en el carril 5 donde lo pusieron');
  assert.equal(laneDe('p02'), 1, 'p02 en el 1');
});

test('modo clásico (order[] sin slot) sigue funcionando como respaldo', () => {
  const { raceId } = escenario(6);
  const rr = reqres(raceId, { order: ['p01','p02','p03','p04','p05','p06'] });
  PoleController.assignLanes(rr.req, rr.res);

  const tandas = tandasDe(raceId);
  assert.equal(tandas.length, 1, 'una sola tanda');
  assert.equal(pilotosDe(tandas[0].id).length, 6, 'con los 6 pilotos');
});
