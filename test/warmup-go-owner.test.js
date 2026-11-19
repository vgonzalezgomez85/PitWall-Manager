/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
// Warm-up antes de la manga: a quién va el GO y las señales de la caja.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideGoOwner, routeBoxEvent } = require('../src/lib/goOwner');

const BASE = {
  mangaRaceId: null, poleRaceId: null, halfTanda: null, claimRaceId: null,
  tandaBoundary: false, liveViewer: false, simReplay: false,
};
const idle = { ready: false, active: false };
const route = (event, s) => routeBoxEvent(event, {
  mangaRunning: false, mangaLate: false, owner: () => 'training',
  pole: idle, competition: idle, training: idle, ...s,
});

test('con un warm-up preparado el GO es del warm-up, aunque la carrera esté pedida', () => {
  const d = decideGoOwner({ ...BASE, claimRaceId: 7, liveViewer: true, warmupRaceId: 7 });
  assert.deepEqual([d.owner, d.reason, d.raceId], ['warmup', 'warmup', 7]);
});

test('una manga en marcha manda sobre el warm-up', () => {
  assert.equal(decideGoOwner({ ...BASE, mangaRaceId: 3, warmupRaceId: 7 }).owner, 'race');
});

test('sin warmupRaceId todo sigue igual (compatibilidad)', () => {
  assert.equal(decideGoOwner({ ...BASE, claimRaceId: 7, liveViewer: true }).owner, 'race');
});

test('el GO del warm-up llega al warm-up solo si está preparado', () => {
  const w = { ready: true, active: false };
  assert.equal(route('race_go', { owner: () => 'warmup', warmup: w }), 'warmup');
  assert.equal(route('race_go', { owner: () => 'warmup', warmup: idle }), null);
});

test('con el warm-up en pista, pausa, STOP, fin y cruces son suyos', () => {
  const w = { ready: true, active: true };
  for (const ev of ['race_paused', 'race_resumed', 'race_stopped', 'race_finished', 'lane_crossing']) {
    assert.equal(route(ev, { warmup: w }), 'warmup', ev);
  }
});

test('un cruce con el warm-up esperando el GO no arranca el entreno libre', () => {
  assert.equal(route('lane_crossing', { warmup: { ready: true, active: false } }), null);
});

test('sin warm-up las rutas de siempre no cambian', () => {
  assert.equal(route('lane_crossing', {}), 'training');
  assert.equal(route('race_go', { owner: () => 'race' }), 'race');
});
