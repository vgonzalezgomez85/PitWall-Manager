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
// La manga y el entreno libre con las señales de un DS, ya por el repartidor
// (GoOwnerService). Lo que hacía app.js con el GO de la caja no tenía tests: vive
// ahora en services/MangaBoxHandlers.
'use strict';

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db              = require('../src/config/database');
const SerialService   = require('../src/services/SerialService');
const SocketService   = require('../src/services/SocketService');
const TimingService   = require('../src/services/TimingService');
const TrainingService = require('../src/services/TrainingService');
const GoOwner         = require('../src/services/GoOwnerService');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

const conexionesOriginales = SerialService._connections;
const hasLive = SocketService.hasLocalLiveViewer;
const linkOriginal = SerialService.getLinkStatus.bind(SerialService);
SerialService.getLinkStatus = () => ({ ...linkOriginal(), simulating: false });

function apagarTimers() {
  clearInterval(TimingService._tickInt);      TimingService._tickInt = null;
  clearTimeout(TimingService._autoStopTimer); TimingService._autoStopTimer = null;
  clearTimeout(TimingService._outageReconcileTimer); TimingService._outageReconcileTimer = null;
  clearTimeout(TimingService._lateCloseTimer);      TimingService._lateCloseTimer = null;
  clearTimeout(TimingService._flagReconcileTimer);  TimingService._flagReconcileTimer = null;
  if (TimingService.session) {
    Object.values(TimingService.session.circuits).forEach(c => {
      if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    });
  }
  TimingService._detachLapHandler();
  TimingService.session = null;
  TimingService._pendingSetup = null;
  TimingService._tandaBoundary = false;
  TimingService._lateWindows.clear();
}

after(() => {
  apagarTimers();
  TrainingService.resetSession?.();
  TrainingService.stop();
  SerialService._connections = conexionesOriginales;
  SerialService.getLinkStatus = linkOriginal;
  SocketService.hasLocalLiveViewer = hasLive;
  limpiarBdTemporal();
});

beforeEach(async () => {
  await new Promise(r => setImmediate(r));
  apagarTimers();
  TrainingService.stop();
  GoOwner._claimRaceId = null;
  GoOwner._remoteGo = null;
  SerialService._connections = [{ connected: true }];   // un DS: manda la caja
  SocketService.hasLocalLiveViewer = () => true;
  // Sin la pausa de rearme del entreno tras un fin de la caja.
  TrainingService._boxEndedAt = 0;
  TrainingService._boxPaused = false;
});

let n = 0;
function carrera() {
  n++;
  const a = { nombre: `Ana${n}`, id: crearPerfil(`Ana${n}`) };
  crearEquipoCatalogo(`E${n}`, [a]);
  const r = crearCarreraConManga([{ nombre: `E${n}`, pilotos: [a] }], { circuitsConfig: [1] });
  db.prepare("UPDATE races SET status = 'active' WHERE id = ?").run(r.raceId);
  return r;
}

function go(durationMs = 120000) {
  SerialService.emit('race_go', { durationMs });
  SerialService.emit('race_started', { circuit: 0 });
}

const vueltas = (mangaId) => db.prepare('SELECT COUNT(*) AS n FROM laps WHERE manga_id = ?').get(mangaId).n;

test('carrera pedida con el directo abierto: el GO del DS arranca la manga con la duración de la caja', () => {
  const { raceId, mangaId } = carrera();
  GoOwner.claimRace(raceId, 'test');
  go(90000);
  assert.equal(TimingService.activeMangaId, mangaId);
  assert.equal(TimingService.session.durationMs ?? TimingService.session.circuits[0].durationMs, 90000);
  assert.equal(TrainingService.isActive, false, 'el entreno libre no se lleva el mismo GO');
});

test('los cruces de la manga van a la manga y no arrancan el entreno libre', async () => {
  const { raceId, mangaId } = carrera();
  GoOwner.claimRace(raceId, 'test');
  go();
  const t0 = Date.now();
  SerialService.emit('lane_crossing', { lane: 1, timestamp: t0 + 5000, lapTimeMs: null, circuit: 0 });
  SerialService.emit('lane_crossing', { lane: 1, timestamp: t0 + 17000, lapTimeMs: 12000, circuit: 0 });
  await new Promise(r => setImmediate(r));
  assert.ok(vueltas(mangaId) >= 1);
  assert.equal(TrainingService.isActive, false);
});

test('STOP del DS con la manga en marcha: la manga se cancela', () => {
  const { raceId, mangaId } = carrera();
  GoOwner.claimRace(raceId, 'test');
  go();
  assert.equal(TimingService.activeMangaId, mangaId);
  SerialService.emit('race_stopped');
  assert.equal(TimingService.activeMangaId, null);
  assert.equal(db.prepare('SELECT status FROM mangas WHERE id = ?').get(mangaId).status, 'pending');
});

test('pausa y reanudación del DS pausan la manga, no el entreno', () => {
  const { raceId } = carrera();
  GoOwner.claimRace(raceId, 'test');
  go();
  SerialService.emit('race_paused', { circuit: 0 });
  assert.equal(TimingService.isPaused, true);
  SerialService.emit('race_resumed', { circuit: 0 });
  assert.equal(TimingService.isPaused, false);
});

test('sin carrera pedida, el GO del DS es del entreno libre y la manga no arranca', () => {
  const { mangaId } = carrera();
  go();
  assert.equal(TrainingService.isActive, true);
  assert.equal(TimingService.activeMangaId, null);
  assert.equal(db.prepare('SELECT status FROM mangas WHERE id = ?').get(mangaId).status, 'pending');
});

test('con el entreno libre en pista, el fin del DS lo cierra y no toca ninguna manga', () => {
  carrera();
  go();
  assert.equal(TrainingService.isActive, true);
  SerialService.emit('race_finished', { circuit: 0 });
  assert.equal(TrainingService.isActive, false);
});

test('con un DS, el primer cruce sin GO arranca el entreno libre', () => {
  SerialService.emit('lane_crossing', { lane: 2, timestamp: Date.now(), lapTimeMs: 11000, circuit: 0 });
  assert.equal(TrainingService.isActive, true);
});

test('el primer cruce no arranca el entreno si la carrera tiene el GO', () => {
  const { raceId } = carrera();
  GoOwner.claimRace(raceId, 'test');
  SerialService.emit('lane_crossing', { lane: 2, timestamp: Date.now(), lapTimeMs: 11000, circuit: 0 });
  assert.equal(TrainingService.isActive, false);
});
