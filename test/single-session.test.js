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
// Una sola sesión en pista (GoOwnerService.blockerFor / begin): manga, pole y
// entreno de competición no arrancan con otra de ellas en pista; el entreno libre
// va de fondo y deja la caja a quien arranca.
'use strict';

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db                 = require('../src/config/database');
const Race               = require('../src/models/Race');
const PoleSession        = require('../src/models/PoleSession');
const SerialService      = require('../src/services/SerialService');
const TimingService      = require('../src/services/TimingService');
const TrainingService    = require('../src/services/TrainingService');
const CompetitionService = require('../src/services/CompetitionTrainingService');
const PoleTimingService  = require('../src/services/PoleTimingService');
const GoOwner            = require('../src/services/GoOwnerService');
const SessionController  = require('../src/controllers/SessionController');
const PoleController     = require('../src/controllers/PoleController');
const TrainingController = require('../src/controllers/TrainingController');
const { crearCarreraConManga } = require('./helpers/seed');

const conexionesOriginales = SerialService._connections;

function limpiar() {
  PoleTimingService.abort();
  CompetitionService.stop();
  TrainingService.stop();
  if (TimingService.isRunning) TimingService.cancelManga();
  clearInterval(TimingService._tickInt); TimingService._tickInt = null;
  TimingService._detachLapHandler();
  TimingService.session = null;
}

after(() => {
  limpiar();
  SerialService._connections = conexionesOriginales;
  limpiarBdTemporal();
});

beforeEach(() => {
  limpiar();
  SerialService._connections = [{ connected: true }];   // un DS: los GO de los botones no hacen semáforo
});

afterEach(() => {
  delete TimingService.activeMangaId;
});

function peticion(params = {}, body = {}) {
  const out = { status: 200, body: null, view: null, locals: null };
  const req = { params, body, t: k => k, xhr: true, get: () => '' };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; },
    render(v, l) { out.view = v; out.locals = l; },
    redirect() {},
  };
  return { req, res, out };
}

const PARTICIPANTES = [{ name: 'Ana', color: '#e63946' }, { name: 'Bru', color: '#2196f3' }];
function heatEnPista() {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  CompetitionService.activate(60000);
  assert.equal(CompetitionService.isActive, true);
}

function pole() {
  const raceId = Race.create({
    name: 'una-sesion', type: 'club', format: 'individual',
    lanes_count: 2, lane_sequence: [1, 2], manga_duration_minutes: 5, has_pole: 1,
  });
  const sessionId = PoleSession.create(raceId);
  const entryId = PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: 'A', membersJson: null });
  PoleSession.startPole(sessionId, 1, [entryId]);
  return { raceId, sessionId, entryId };
}
function poleEnPista() {
  const p = pole();
  PoleTimingService.start({ poleSessionId: p.sessionId, entryId: p.entryId, entryName: 'A', poleLane: 1, durationMs: 60000, minLapMs: 0 });
  PoleTimingService.go();
  assert.equal(PoleTimingService.isRunning, true);
  return p;
}

let n = 0;
function manga() {
  n++;
  return crearCarreraConManga([{ nombre: `E${n}`, pilotos: [{ nombre: `P${n}` }] }], { circuitsConfig: [1] });
}

// ── Quién impide arrancar a quién ────────────────────────────────────────────

test('blockerFor: el entreno libre no impide nada; las demás sesiones sí', () => {
  entrenoLibreEnPista();
  assert.equal(GoOwner.busySession(), 'training');
  for (const s of ['race', 'pole', 'competition']) assert.equal(GoOwner.blockerFor(s), null, s);
  TrainingService.stop();

  heatEnPista();
  assert.equal(GoOwner.blockerFor('race'), 'competition');
  assert.equal(GoOwner.blockerFor('pole'), 'competition');
  assert.equal(GoOwner.blockerFor('training'), 'competition');
  assert.equal(GoOwner.blockerFor('competition'), null, 'una sesión no se bloquea a sí misma');
});

// ── Botones ──────────────────────────────────────────────────────────────────

test('GO de la manga con un entreno de competición en pista: 409 y la manga no arranca', () => {
  heatEnPista();
  const { raceId, mangaId } = manga();
  const { req, res, out } = peticion({ id: String(raceId), mangaId: String(mangaId) });
  SessionController.start(req, res);
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'competition_running');
  assert.equal(out.body.message, 'goowner.ocupado_competition');
  assert.equal(TimingService.isRunning, false);
  assert.equal(CompetitionService.isActive, true);
});

test('pole con un entreno de competición en pista: no se arma ni arranca', () => {
  heatEnPista();
  const p = pole();
  let r = peticion({ id: String(p.raceId) });
  PoleController.timing(r.req, r.res);
  assert.equal(r.out.locals.blocked, true);
  assert.equal(PoleTimingService.isStandby, false);
  for (const accion of ['startParticipant', 'goParticipant']) {
    SerialService._simRunning = accion === 'goParticipant';
    r = peticion({ id: String(p.raceId) });
    PoleController[accion](r.req, r.res);
    assert.equal(r.out.status, 409, accion);
    assert.equal(r.out.body.error, 'competition_running', accion);
  }
  SerialService._simRunning = false;
});

test('GO de los entrenos con la pole en pista: 409 con el aviso de la pole', () => {
  poleEnPista();
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  TrainingService.prepare(2);
  for (const mode of ['competition', 'free']) {
    const { req, res, out } = peticion({}, { mode, duration_minutes: '5' });
    TrainingController.go(req, res);
    assert.equal(out.status, 409, mode);
    assert.equal(out.body.error, 'pole_running', mode);
    assert.equal(out.body.message, 'goowner.ocupado_pole', mode);
  }
  assert.equal(CompetitionService.isActive, false);
  assert.equal(TrainingService.isActive, false);
});

test('GO del entreno libre con una manga en marcha: 409', () => {
  Object.defineProperty(TimingService, 'activeMangaId', { get: () => 1, configurable: true });
  TrainingService.prepare(2);
  const { req, res, out } = peticion({}, { mode: 'free' });
  TrainingController.go(req, res);
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'race_running');
});

// ── El entreno libre deja la caja ────────────────────────────────────────────

function entrenoLibreEnPista() {
  TrainingService.prepare(2);
  TrainingService._activate();
  assert.equal(TrainingService.isActive, true);
}

test('arranca la pole con el entreno libre en pista: el entreno se para', () => {
  entrenoLibreEnPista();
  poleEnPista();
  assert.equal(TrainingService.isActive, false);
  SerialService.emit('lane_crossing', { lane: 1, lapTimeMs: 9000, timestamp: Date.now(), circuit: 0 });
  assert.equal(TrainingService.isActive, false, 'el cruce es de la pole, no rearranca el entreno');
});

test('arranca un heat de competición con el entreno libre en pista: el entreno se para', () => {
  entrenoLibreEnPista();
  heatEnPista();
  assert.equal(TrainingService.isActive, false);
});

test('GO de la manga con el entreno libre en pista: no bloquea, la manga arranca y el entreno se para', () => {
  entrenoLibreEnPista();
  const { raceId, mangaId } = manga();
  const { req, res, out } = peticion({ id: String(raceId), mangaId: String(mangaId) });
  SessionController.start(req, res);
  assert.notEqual(out.status, 409);
  assert.equal(TimingService.activeMangaId, mangaId);
  assert.equal(TrainingService.isActive, false);
  assert.equal(db.prepare('SELECT status FROM mangas WHERE id = ?').get(mangaId).status, 'active');
});
