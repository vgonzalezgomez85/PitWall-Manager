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
// Extras de las carreras sprint: warm-up antes de la manga y añadir pilotos a la
// pole ya empezada. Cada uno con su interruptor en Ajustes, apagado por defecto.
'use strict';

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { routeBoxEvent } = require('../src/lib/goOwner');
const Race             = require('../src/models/Race');
const Settings         = require('../src/models/Settings');
const Tanda            = require('../src/models/Tanda');
const Driver           = require('../src/models/Driver');
const Manga            = require('../src/models/Manga');
const PoleSession      = require('../src/models/PoleSession');
const SerialService    = require('../src/services/SerialService');
const SprintExtras     = require('../src/services/SprintExtras');
const Warmup           = require('../src/services/WarmupService');
const TrainingService  = require('../src/services/TrainingService');
const PoleController   = require('../src/controllers/PoleController');
const WarmupController = require('../src/controllers/WarmupController');
const SettingsController = require('../src/controllers/SettingsController');

const conexionesOriginales = SerialService._connections;

after(() => {
  Warmup.discard();
  Warmup._drainUntil = 0;
  SerialService._connections = conexionesOriginales;
  limpiarBdTemporal();
});

beforeEach(() => {
  Warmup.discard();
  Warmup._drainUntil = 0;
  SerialService._connections = [{ connected: true }];   // un DS: la caja da el GO
  Settings.set('sprint_warmup', 'off');
  Settings.set('sprint_pole_add', 'off');
});

const sprint = (extra = {}) => Race.findById(Race.create({
  name: 'sprint', type: 'club', format: 'individual',
  lanes_count: 2, lane_sequence: [1, 2], manga_duration_minutes: 3, ...extra,
}));

function call(handler, { params = {}, body = {} } = {}) {
  let status = 200, json = null, redirect = null;
  const res = {
    status(c) { status = c; return res; },
    json(j) { json = j; return res; },
    redirect(u) { redirect = u; },
    render() {},
  };
  handler({ params, body, t: (k) => k }, res);
  return { status, json, redirect };
}

// ── Interruptores ────────────────────────────────────────────────────────────

test('apagados por defecto, y solo valen en sprint individual', () => {
  const r = sprint();
  assert.equal(SprintExtras.warmupEnabled(r), false);
  assert.equal(SprintExtras.poleAddEnabled(r), false);

  Settings.set('sprint_warmup', 'on');
  assert.equal(SprintExtras.warmupEnabled(r), true);
  assert.equal(SprintExtras.poleAddEnabled(r), false, 'cada interruptor va por su cuenta');

  Settings.set('sprint_pole_add', 'on');
  assert.equal(SprintExtras.poleAddEnabled(r), true);

  const resistencia = Race.findById(Race.create({
    name: 'res', type: 'championship', format: 'team', lanes_count: 2, lane_sequence: [1, 2], manga_duration_minutes: 10,
  }));
  assert.equal(SprintExtras.warmupEnabled(resistencia), false);
  assert.equal(SprintExtras.poleAddEnabled(resistencia), false);
  assert.equal(SprintExtras.isSprint({ type: 'club', format: 'team' }), false, 'sprint por equipos antigua: fuera');
});

test('Ajustes → Preferencias guarda los dos interruptores y rechaza otros valores', () => {
  for (const key of ['sprint_warmup', 'sprint_pole_add']) {
    assert.equal(call(SettingsController.savePrefs, { body: { key, value: 'on' } }).json.ok, true, key);
    assert.equal(Settings.get(key), 'on');
    assert.equal(call(SettingsController.savePrefs, { body: { key, value: 'si' } }).status, 400, key);
  }
});

// ── Añadir piloto a la pole ─────────────────────────────────────────────────

function poleConPilotos(race, nombres) {
  const sessionId = PoleSession.create(race.id);
  const ids = nombres.map(n => PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: n }));
  PoleSession.startPole(sessionId, 1, ids);
  return sessionId;
}

test('añadir piloto: con el interruptor apagado el servidor lo rechaza', () => {
  const race = sprint({ has_pole: 1 });
  poleConPilotos(race, ['Ana', 'Bru']);
  const r = call(PoleController.addEntry, { params: { id: String(race.id) }, body: { name: 'Carla' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'disabled');
});

test('añadir piloto: va al final, no repite nombre y con la pole cerrada la reabre', () => {
  Settings.set('sprint_pole_add', 'on');
  const race = sprint({ has_pole: 1 });
  const sessionId = poleConPilotos(race, ['Ana', 'Bru']);
  const p = { id: String(race.id) };

  const ok = call(PoleController.addEntry, { params: p, body: { name: '  Carla  ' } });
  assert.equal(ok.json.ok, true);
  assert.deepEqual(PoleSession.getEntriesOrdered(sessionId).map(e => e.entity_name), ['Ana', 'Bru', 'Carla']);
  assert.equal(PoleSession.getEntriesOrdered(sessionId).at(-1).entity_type, 'driver');

  assert.equal(call(PoleController.addEntry, { params: p, body: { name: 'carla' } }).status, 409, 'sin distinguir mayúsculas');

  PoleSession.finish(sessionId);
  const late = call(PoleController.addEntry, { params: p, body: { name: 'Dani' } });
  assert.equal(late.json.reopened, true);
  const s = PoleSession.findByRace(race.id);
  assert.equal(s.status, 'in_progress');
  assert.equal(PoleSession.getEntriesOrdered(sessionId)[s.current_idx].entity_name, 'Dani', 'sale el siguiente');
});

test('añadir piloto: con las tandas ya creadas desde la pole no deja', () => {
  Settings.set('sprint_pole_add', 'on');
  const race = sprint({ has_pole: 1 });
  const sessionId = poleConPilotos(race, ['Ana']);
  PoleSession.finish(sessionId);
  Tanda.create(race.id);
  const r = call(PoleController.addEntry, { params: { id: String(race.id) }, body: { name: 'Bru' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'tanda_exists');
});

// ── Warm-up ──────────────────────────────────────────────────────────────────

function mangaPendiente(race) {
  const tandaId = Tanda.create(race.id);
  const ents = ['Ana', 'Bru'].map(name => ({ id: Driver.create({ race_id: race.id, tanda_id: tandaId, name }), type: 'driver', name }));
  Manga.persistSchedule(tandaId, race.id, Manga.buildSchedule([1, 2], ents, 1, 1));
  return Manga.findByTanda(tandaId)[0];
}

test('warm-up: con el interruptor apagado no se arma ni se abre su ventana', () => {
  const race = sprint();
  const manga = mangaPendiente(race);
  const params = { id: String(race.id), mangaId: String(manga.id) };
  const r = call(WarmupController.arm, { params, body: { minutes: 2 } });
  assert.equal(r.status, 403);
  assert.equal(Warmup.isStandby, false);
  assert.match(call(WarmupController.page, { params }).redirect, /\/live$/);
});

test('warm-up con DS: vueltas sin guardar; terminado antes, los cruces de la caja no arrancan el entreno libre', () => {
  Settings.set('sprint_warmup', 'on');
  const race = sprint();
  const manga = mangaPendiente(race);
  const params = { id: String(race.id), mangaId: String(manga.id) };
  const db = require('../src/config/database');
  const vueltas = () => db.prepare('SELECT COUNT(*) n FROM laps').get().n;
  const antes = vueltas();

  assert.equal(call(WarmupController.arm, { params, body: { minutes: 2 } }).json.state, 'standby');
  SerialService.emit('race_go', { durationMs: 180000 });
  SerialService.emit('race_started');
  assert.equal(Warmup.isRunning, true);
  assert.equal(Warmup.session.durationMs, 180000, 'manda la duración de la caja');

  const t0 = Date.now();
  SerialService.emit('lane_crossing', { lane: 1, lapTimeMs: null, circuit: 0, timestamp: t0 });
  SerialService.emit('lane_crossing', { lane: 1, lapTimeMs: 9100, circuit: 0, timestamp: t0 + 9100 });
  assert.equal(Warmup.snapshot(manga.id).lanes.find(l => l.lane === 1).laps, 1);

  call(WarmupController.close, { params });
  assert.equal(Warmup.isRunning, false);
  assert.equal(Warmup.isDraining, true, 'la caja sigue con su carrera hasta su STOP');

  SerialService.emit('lane_crossing', { lane: 2, lapTimeMs: 9300, circuit: 0, timestamp: t0 + 20000 });
  assert.equal(TrainingService.isActive, false, 'el entreno libre no se lleva los cruces del warm-up');

  SerialService.emit('race_stopped');
  assert.equal(Warmup.isDraining, false);
  assert.equal(vueltas(), antes, 'el warm-up no guarda vueltas');
  assert.equal(Manga.findById(manga.id).status, 'pending');
});

test('reparto: con el warm-up en `draining` sus señales son suyas, el GO no', () => {
  const nadie = { ready: false, active: false };
  const s = { mangaRunning: false, mangaLate: false, owner: () => 'race', pole: nadie, competition: nadie, training: nadie,
              warmup: { ready: false, active: false, draining: true } };
  for (const ev of ['lane_crossing', 'race_paused', 'race_resumed', 'race_stopped', 'race_finished']) {
    assert.equal(routeBoxEvent(ev, s), 'warmup', ev);
  }
  assert.equal(routeBoxEvent('race_go', s), 'race');
});
