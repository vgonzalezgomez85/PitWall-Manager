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
// Manga y pole comparten la caja: nunca corren a la vez (lo encontró Alessandro en
// simulación, manga en una ventana y pole en otra). Con un DS, una pole que espera
// el GO no puede reaccionar al GO, STOP o fin de la manga que corre. Y con pole,
// las tandas salen de sus resultados: no se crean a mano antes de acabarla.
'use strict';

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db                = require('../src/config/database');
const Race              = require('../src/models/Race');
const PoleSession       = require('../src/models/PoleSession');
const PoleController    = require('../src/controllers/PoleController');
const SessionController = require('../src/controllers/SessionController');
const TandaController   = require('../src/controllers/TandaController');
const PoleTimingService = require('../src/services/PoleTimingService');
const TimingService     = require('../src/services/TimingService');
const SerialService     = require('../src/services/SerialService');
const { crearCarreraConManga } = require('./helpers/seed');

const conexionesOriginales = SerialService._connections;

after(() => {
  PoleTimingService.abort();
  SerialService._connections = conexionesOriginales;
  limpiarBdTemporal();
});

beforeEach(() => {
  PoleTimingService.abort();
  SerialService._connections = [{ connected: true }];   // un DS: manda la caja
  SerialService._simRunning = false;
});

afterEach(() => {
  delete TimingService.activeMangaId;
  delete TimingService.activeRaceId;
  if (TimingService.isRunning) TimingService.cancelManga();
});

// La manga corre sin montar toda su sesión: solo lo que miran la pole y GoOwner.
function mangaEnMarcha(raceId = 999) {
  Object.defineProperty(TimingService, 'activeMangaId', { get: () => 1, configurable: true });
  Object.defineProperty(TimingService, 'activeRaceId',  { get: () => raceId, configurable: true });
}

function pole(nombres = ['A', 'B']) {
  const raceId = Race.create({
    name: 'pole-excl', type: 'club', format: 'individual',
    lanes_count: 4, lane_sequence: [1, 2, 3, 4], manga_duration_minutes: 5, has_pole: 1,
  });
  const sessionId = PoleSession.create(raceId);
  const ids = nombres.map(n =>
    PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: n, membersJson: null }));
  PoleSession.startPole(sessionId, 1, ids);
  return { raceId, sessionId, ids };
}

function armar(e) {
  PoleTimingService.start({ poleSessionId: e.sessionId, entryId: e.ids[0], entryName: 'A', poleLane: 1, durationMs: 60000, minLapMs: 0 });
}

function peticion(params, body = {}) {
  const out = { status: 200, body: null, view: null, locals: null, redirect: null };
  const req = { params, body, t: k => k, xhr: true, get: () => '' };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; },
    render(v, l) { out.view = v; out.locals = l; },
    redirect(u) { out.redirect = u; },
  };
  return { req, res, out };
}

// ── La pole no arranca con una manga en marcha ───────────────────────────────

test('abrir la pole con una manga en marcha no arma al piloto', () => {
  const e = pole();
  mangaEnMarcha();
  const { req, res, out } = peticion({ id: String(e.raceId) });
  PoleController.timing(req, res);
  assert.equal(out.view, 'races/pole-timing');
  assert.equal(out.locals.blocked, true);
  assert.equal(PoleTimingService.isStandby, false);
});

test('«Iniciar» y GO de la pole devuelven 409 con una manga en marcha', () => {
  const e = pole();
  SerialService._simRunning = true;
  mangaEnMarcha();
  for (const accion of ['startParticipant', 'goParticipant']) {
    const { req, res, out } = peticion({ id: String(e.raceId) });
    PoleController[accion](req, res);
    assert.equal(out.status, 409, accion);
    assert.equal(out.body.error, 'manga_running', accion);
  }
  assert.equal(PoleTimingService.isStandby, false);
  assert.equal(PoleTimingService.isRunning, false);
});

test('GO de la pole: si arranca una manga durante el semáforo, la pole no sale', async () => {
  const e = pole();
  SerialService._simRunning = true;
  Object.defineProperty(PoleController, 'SEMAPHORE_MS', { get: () => 50, configurable: true });
  try {
    const { req, res, out } = peticion({ id: String(e.raceId) });
    PoleController.goParticipant(req, res);
    assert.equal(out.body.ok, true);
    mangaEnMarcha();
    await new Promise(r => setTimeout(r, 120));
    assert.equal(PoleTimingService.isRunning, false);
  } finally {
    delete PoleController.SEMAPHORE_MS;
    Object.defineProperty(PoleController, 'SEMAPHORE_MS', { get: () => 3000, configurable: true });
  }
});

// ── Señales del DS con la pole esperando y una manga en marcha ───────────────

test('DS: el GO de otra caja con la manga en marcha no arranca la pole', () => {
  const e = pole();
  armar(e);
  mangaEnMarcha();
  SerialService.emit('race_go', { durationMs: 120000 });
  SerialService.emit('race_started', { circuit: 1 });
  assert.equal(PoleTimingService.isRunning, false);
  assert.equal(PoleTimingService.isStandby, true);
  assert.equal(PoleTimingService.session.durationMs, 60000, 'la duración del GO de la manga no se queda');
});

test('DS: el fin y el STOP de la manga no cierran el intento del piloto que espera', () => {
  const e = pole();
  armar(e);
  mangaEnMarcha();
  const finales = [];
  const SocketService = require('../src/services/SocketService');
  const emitir = SocketService.emit;
  SocketService.emit = (ev, d) => { if (ev === 'pole:finished') finales.push(d); return emitir.call(SocketService, ev, d); };
  try {
    SerialService.emit('race_finished');
    SerialService.emit('race_stopped');
  } finally {
    SocketService.emit = emitir;
  }
  assert.deepEqual(finales, []);
  assert.equal(PoleTimingService.isStandby, true);
  assert.equal(PoleTimingService.currentEntryId, e.ids[0]);
  const entrada = PoleSession.getEntriesOrdered(e.sessionId)[0];
  assert.equal(entrada.lap_time_ms, null);
});

test('DS: sin manga, el GO sigue siendo de la pole que espera', () => {
  const e = pole();
  armar(e);
  SerialService.emit('race_go', { durationMs: 90000 });
  SerialService.emit('race_started', { circuit: 0 });
  assert.equal(PoleTimingService.isRunning, true);
  assert.equal(PoleTimingService.session.durationMs, 90000);
  SerialService.emit('race_finished');
  assert.equal(PoleTimingService.session, null, 'el fin de la caja cierra al piloto en pista');
});

// ── La manga no arranca con la pole en pista ─────────────────────────────────

test('GO de la manga con un piloto de la pole en pista: 409 y la manga no arranca', () => {
  const e = pole();
  armar(e);
  PoleTimingService.go();
  const { raceId, mangaId } = crearCarreraConManga([{ nombre: 'E1', pilotos: [{ nombre: 'Ana' }] }], { circuitsConfig: [1] });
  const { req, res, out } = peticion({ id: String(raceId), mangaId: String(mangaId) });
  SessionController.start(req, res);
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'pole_running');
  assert.equal(TimingService.isRunning, false);
  assert.equal(PoleTimingService.isRunning, true);
});

test('GO de la manga con la pole solo esperando: la pole se aparta sin parar la fuente', () => {
  const e = pole();
  armar(e);
  let stops = 0;
  const sendStop = SerialService.sendStop;
  SerialService.sendStop = () => { stops++; };
  try {
    const { raceId, mangaId } = crearCarreraConManga([{ nombre: 'E2', pilotos: [{ nombre: 'Bea' }] }], { circuitsConfig: [1] });
    const { req, res } = peticion({ id: String(raceId), mangaId: String(mangaId) });
    SessionController.start(req, res);
    assert.equal(PoleTimingService.session, null);
    assert.equal(TimingService.activeMangaId, mangaId);
    assert.equal(stops, 0);
  } finally {
    SerialService.sendStop = sendStop;
  }
});

// ── Tandas a mano con la pole sin terminar ───────────────────────────────────

test('con la pole sin terminar no se crean tandas a mano', () => {
  const e = pole();
  for (const accion of ['newForm', 'create']) {
    const { req, res, out } = peticion({ id: String(e.raceId) });
    TandaController[accion](req, res);
    assert.equal(out.status, 409, accion);
    assert.equal(out.locals.message, 'show.tienes_que_terminar_la_sesion_de_pole_position');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tandas WHERE race_id = ?').get(e.raceId).n, 0);
});

test('con la pole terminada (o sin pole) el formulario de tanda se abre', () => {
  const e = pole();
  PoleSession.finish(e.sessionId);
  const { req, res, out } = peticion({ id: String(e.raceId) });
  TandaController.newForm(req, res);
  assert.equal(out.status, 200);
  assert.equal(out.view, 'races/tanda-new');
});
