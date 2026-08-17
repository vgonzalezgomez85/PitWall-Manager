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
// "Saltar" en pole: el piloto/equipo que no está en pista pasa al FINAL de la
// cola (1er salto) y tiene otra oportunidad cuando le vuelve a tocar. Si
// SIGUE sin presentarse (2º salto seguido, sin haber corrido entre medias),
// se marca AUSENTE de verdad (0.00 + is_noshow) y no vuelve a la cola.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { usarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const Race            = require('../src/models/Race');
const PoleSession     = require('../src/models/PoleSession');
const PoleController  = require('../src/controllers/PoleController');

function escenario(nombres) {
  const raceId = Race.create({
    name: 'skip-test', type: 'club', format: 'individual',
    lanes_count: 6, lane_sequence: [1, 2, 3, 4, 5, 6],
    manga_duration_minutes: 5, has_pole: 1,
  });
  const sessionId = PoleSession.create(raceId);
  const ids = nombres.map(n =>
    PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: n, membersJson: null }));
  PoleSession.startPole(sessionId, 1, ids);   // orden explícito = orden de nombres
  return { raceId, sessionId, ids };
}

function reqres(raceId) {
  let redirected = null;
  const req = { params: { id: String(raceId) }, body: {}, t: (k) => k };
  const res = {
    redirect: (url) => { redirected = url; },
    status: () => res,
    render: () => {},
    json: () => {},
  };
  return { req, res, get redirect() { return redirected; } };
}

test('1er salto: manda al final de la cola, current_idx no avanza (el siguiente ocupa su sitio)', () => {
  const { raceId, sessionId } = escenario(['A', 'B', 'C']);

  const rr = reqres(raceId);
  PoleController.skipParticipant(rr.req, rr.res);

  assert.equal(rr.redirect, `/races/${raceId}/pole/timing`);

  const session = PoleSession.findByRace(raceId);
  assert.equal(session.current_idx, 0, 'current_idx no se toca en el 1er salto');

  const ordered = PoleSession.getEntriesOrdered(sessionId).map(e => e.entity_name);
  assert.deepEqual(ordered, ['B', 'C', 'A'], 'A pasa al final; B ocupa el hueco');

  const a = PoleSession.getEntriesOrdered(sessionId).find(e => e.entity_name === 'A');
  assert.equal(a.skip_count, 1);
  assert.equal(a.is_noshow, 0);
  assert.equal(a.lap_time_ms, null, 'sin tiempo todavía: solo ha sido saltado una vez');
});

test('2º salto seguido para el mismo participante: se marca AUSENTE (0.00) y se avanza', () => {
  const { raceId, sessionId } = escenario(['A', 'B']);

  // 1er salto de A → cola queda [B, A], current_idx sigue en 0 (B es el actual)
  const first = reqres(raceId);
  PoleController.skipParticipant(first.req, first.res);
  let session = PoleSession.findByRace(raceId);
  assert.equal(session.current_idx, 0);
  assert.deepEqual(PoleSession.getEntriesOrdered(sessionId).map(e => e.entity_name), ['B', 'A']);

  // B corre normalmente y saca un tiempo → avanza a A (índice 1)
  const bEntry = PoleSession.getEntriesOrdered(sessionId)[0];
  PoleSession.submitTime(sessionId, bEntry.id, 12345);
  session = PoleSession.findByRace(raceId);
  assert.equal(session.current_idx, 1);
  assert.equal(PoleSession.getEntriesOrdered(sessionId)[1].entity_name, 'A');

  // A sigue sin presentarse → 2º salto → AUSENTE, sesión terminada (era el último)
  const second = reqres(raceId);
  PoleController.skipParticipant(second.req, second.res);
  assert.equal(second.redirect, `/races/${raceId}/pole/results`);

  session = PoleSession.findByRace(raceId);
  assert.equal(session.status, 'done');

  const aFinal = PoleSession.getEntriesOrdered(sessionId).find(e => e.entity_name === 'A');
  assert.equal(aFinal.skip_count, 2);
  assert.equal(aFinal.is_noshow, 1);
  assert.equal(aFinal.lap_time_ms, 0);
});

test('getEntriesSorted: el 0.00 del ausente va DESPUÉS de todos los tiempos reales, nunca primero', () => {
  const { raceId, sessionId } = escenario(['Rapido', 'Lento', 'Ausente']);
  const [rapido, lento, ausente] = PoleSession.getEntriesOrdered(sessionId);
  PoleSession.updateEntryTime(rapido.id, 9000);
  PoleSession.updateEntryTime(lento.id, 15000);
  PoleSession.markNoShow(ausente.id);

  const sorted = PoleSession.getEntriesSorted(sessionId).map(e => e.entity_name);
  assert.deepEqual(sorted, ['Rapido', 'Lento', 'Ausente']);
});
