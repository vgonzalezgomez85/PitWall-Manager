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
// Reparto de las señales de la caja (GoOwnerService + lib/goOwner.routeBoxEvent):
// la pole y el entreno de competición ya no escuchan a SerialService, cada señal
// va a una sola sesión.
'use strict';

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { routeBoxEvent } = require('../src/lib/goOwner');
const Race               = require('../src/models/Race');
const PoleSession        = require('../src/models/PoleSession');
const SerialService      = require('../src/services/SerialService');
const TimingService      = require('../src/services/TimingService');
const PoleTimingService  = require('../src/services/PoleTimingService');
const CompetitionService = require('../src/services/CompetitionTrainingService');

const conexionesOriginales = SerialService._connections;

after(() => {
  PoleTimingService.abort();
  CompetitionService.stop();
  SerialService._connections = conexionesOriginales;
  limpiarBdTemporal();
});

beforeEach(() => {
  PoleTimingService.abort();
  CompetitionService.stop();
  SerialService._connections = [{ connected: true }];
});

afterEach(() => {
  delete TimingService.activeMangaId;
  delete TimingService.activeRaceId;
});

// ── Regla pura ───────────────────────────────────────────────────────────────

const nadie = { ready: false, active: false };
const espera = { ready: true, active: false };
const enPista = { ready: true, active: true };
const estado = (o = {}) => ({
  mangaRunning: false, mangaLate: false, owner: () => 'training',
  pole: nadie, competition: nadie, training: nadie, ...o,
});
const TODAS = ['race_go', 'race_started', 'race_paused', 'race_resumed', 'race_stopped', 'race_finished', 'lane_crossing'];
const NO_GO = ['race_paused', 'race_resumed', 'race_stopped', 'race_finished', 'lane_crossing'];

test('con una manga en marcha todas las señales son de la manga', () => {
  for (const ev of TODAS) {
    assert.equal(routeBoxEvent(ev, estado({ mangaRunning: true, pole: enPista, competition: enPista, training: enPista })), 'race', ev);
  }
});

test('manga cerrada con vuelta de bandera pendiente: sus cruces siguen siendo suyos, el resto no', () => {
  assert.equal(routeBoxEvent('lane_crossing', estado({ mangaLate: true, training: enPista })), 'race');
  assert.equal(routeBoxEvent('race_finished', estado({ mangaLate: true, training: enPista })), 'training');
  assert.equal(routeBoxEvent('race_started', estado({ mangaLate: true, owner: () => 'pole', pole: espera })), 'pole');
});

test('el GO va a quien es dueño', () => {
  assert.equal(routeBoxEvent('race_started', estado({ owner: () => 'race', pole: espera, competition: espera })), 'race');
  assert.equal(routeBoxEvent('race_started', estado({ owner: () => 'pole', pole: espera, competition: espera })), 'pole');
  assert.equal(routeBoxEvent('race_started', estado({ owner: () => 'training', pole: espera, competition: espera })), 'competition');
  assert.equal(routeBoxEvent('race_go', estado({ owner: () => 'training' })), 'training', 'sin heat preparado, al entreno libre');
});

test('GO de la pole sin piloto preparado: no es de nadie', () => {
  assert.equal(routeBoxEvent('race_started', estado({ owner: () => 'pole' })), null);
});

test('un heat en pista sigue con el GO de otro circuito, aunque la carrera lo pida', () => {
  assert.equal(routeBoxEvent('race_started', estado({ owner: () => 'race', competition: enPista })), 'competition');
});

test('pausa, STOP, fin y cruces solo van a quien está en pista', () => {
  for (const ev of NO_GO) {
    assert.equal(routeBoxEvent(ev, estado({ pole: enPista, competition: enPista, training: enPista })), 'pole', ev);
    assert.equal(routeBoxEvent(ev, estado({ competition: enPista, training: enPista })), 'competition', ev);
    assert.equal(routeBoxEvent(ev, estado({ training: enPista })), 'training', ev);
  }
  for (const ev of ['race_paused', 'race_resumed', 'race_stopped', 'race_finished']) {
    assert.equal(routeBoxEvent(ev, estado({ pole: espera, competition: espera })), null, ev);
  }
});

test('un cruce sin nadie en pista es del entreno libre (arranque con el primer cruce), salvo con una pole o un heat esperando', () => {
  assert.equal(routeBoxEvent('lane_crossing', estado()), 'training');
  assert.equal(routeBoxEvent('lane_crossing', estado({ pole: espera })), null);
  assert.equal(routeBoxEvent('lane_crossing', estado({ competition: espera })), null);
});

// ── Con los servicios de verdad ──────────────────────────────────────────────

function armarPole() {
  const raceId = Race.create({
    name: 'reparto', type: 'club', format: 'individual',
    lanes_count: 2, lane_sequence: [1, 2], manga_duration_minutes: 5, has_pole: 1,
  });
  const sessionId = PoleSession.create(raceId);
  const entryId = PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: 'A', membersJson: null });
  PoleSession.startPole(sessionId, 1, [entryId]);
  PoleTimingService.start({ poleSessionId: sessionId, entryId, entryName: 'A', poleLane: 1, durationMs: 60000, minLapMs: 0 });
}

const PARTICIPANTES = [{ name: 'Ana', color: '#e63946' }, { name: 'Bru', color: '#2196f3' }];

test('pole y entreno de competición esperando: el GO arranca la pole y el heat sigue esperando', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  armarPole();
  SerialService.emit('race_go', { durationMs: 60000 });
  SerialService.emit('race_started');
  assert.equal(PoleTimingService.isRunning, true);
  assert.equal(CompetitionService.isActive, false);
  assert.equal(CompetitionService.isStandby, true);
});

test('la pole no se queda los cruces ni el fin de un heat en pista', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  SerialService.emit('race_go', { durationMs: 60000 });
  SerialService.emit('race_started');
  assert.equal(CompetitionService.isActive, true);
  armarPole();
  SerialService.emit('lane_crossing', { lane: 1, lapTimeMs: 9000, circuit: 0, timestamp: Date.now() });
  assert.equal(CompetitionService.getLanes().find(l => l.lane === 1).count, 1);
  SerialService.emit('race_finished');
  assert.equal(CompetitionService.isActive, false, 'la bandera cierra el heat');
  assert.equal(PoleTimingService.isStandby, true, 'la pole sigue esperando su GO');
});

test('heat en pista y manga en marcha: el heat no recibe los cruces ni el fin de la manga', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  SerialService.emit('race_go', { durationMs: 60000 });
  SerialService.emit('race_started');
  Object.defineProperty(TimingService, 'activeMangaId', { get: () => 1, configurable: true });
  SerialService.emit('lane_crossing', { lane: 1, lapTimeMs: 9000, circuit: 0, timestamp: Date.now() });
  SerialService.emit('race_finished');
  assert.equal(CompetitionService.getLanes().find(l => l.lane === 1).count, 0);
  assert.equal(CompetitionService.isActive, true);
});

test('ninguna sesión escucha a SerialService por su cuenta: un solo oyente de reparto, el primero', () => {
  require('../src/services/TrainingService');
  for (const ev of ['race_go', 'race_started', 'race_paused', 'race_resumed', 'race_stopped', 'race_finished', 'lane_crossing']) {
    const fuentes = SerialService.listeners(ev).map(f => f.toString());
    assert.match(fuentes[0], /_route/, ev);
    assert.equal(fuentes.filter(src => /_route/.test(src)).length, 1, ev);
    assert.ok(!fuentes.some(src => /_pauseState|_stopHeat|forceStop|_activate|_lapHandler|_autoStartOnCrossing|cancelManga|finishCircuit/.test(src)), ev);
  }
});
