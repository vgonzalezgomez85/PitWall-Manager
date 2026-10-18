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
// Control remoto del interface TicTac: PitWall le manda las órdenes C1..C4 (GO con
// tiempo, stop, pausa, reanudar) y el aparato lleva el semáforo, el reloj y el relé
// de la pista, y lo cuenta con sus tramas de evento, que se leen como las de un DS.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const P  = require('../src/lib/tictacProtocol');
const { decideGoOwner } = require('../src/lib/goOwner');
const SerialService      = require('../src/services/SerialService');
const TimingService      = require('../src/services/TimingService');
const GoOwnerService     = require('../src/services/GoOwnerService');
const TicTacConnection   = require('../src/services/TicTacConnection');
const SessionController  = require('../src/controllers/SessionController');
const TrainingController = require('../src/controllers/TrainingController');
const TrainingService    = require('../src/services/TrainingService');
const { tictacConectado } = require('./helpers/tictacAparato');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

const conexionesOriginales = SerialService._connections;
const tiemposOriginales = { ...TicTacConnection.TIEMPOS };
const SENALES = ['race_go', 'race_started', 'race_paused', 'race_resumed', 'race_finished',
                 'race_stopped', 'race_resume_signal', 'semaphore_step'];

let senales, escuchas, t;

beforeEach(() => {
  senales = [];
  escuchas = SENALES.map(ev => {
    const fn = d => senales.push(ev === 'race_go' ? `${ev}:${d.durationMs}` : ev);
    SerialService.on(ev, fn);
    return [ev, fn];
  });
  t = tictacConectado();
  SerialService._connections = [t.conn];
});

afterEach(() => {
  for (const [ev, fn] of escuchas) SerialService.off(ev, fn);
  for (const c of SerialService._connections) c?._limpiarEspera?.();
  Object.assign(TicTacConnection.TIEMPOS, tiemposOriginales);
  GoOwnerService._remoteGo = null;
});

after(() => {
  SerialService._connections = conexionesOriginales;
  TimingService.clearPendingManga();
  limpiarBdTemporal();
});

const espera = ms => new Promise(r => setTimeout(r, ms));

// ── Códec ─────────────────────────────────────────────────────────────────────

test('la orden de arranque lleva minutos (1-60) y horas, como TICTAC_Slot', () => {
  const hex = min => P.ordenArrancar(min * 60000).subarray(0, 3).toString('hex');
  assert.equal(hex(1),  'c10100');
  assert.equal(hex(10), 'c10a00');
  assert.equal(hex(60), 'c13c00', '60 min = 60 + 0 h, no 0 + 1 h');
  assert.equal(hex(61), 'c10101');
  assert.equal(hex(90), 'c11e01');
  assert.equal(P.ordenArrancar(20000).subarray(0, 3).toString('hex'), 'c10100', 'menos de un minuto: el mínimo');
  const o = P.orden(P.ORDEN.PAUSA);
  assert.equal(o.length, 16);
  assert.ok(o.subarray(1).every(b => b === 0), 'el resto de la trama va a 0');
});

test('el arranque por tiempo del aparato trae la duración (minutos + horas)', () => {
  const b = Buffer.alloc(16);
  b[0] = 0xc0; b[2] = 0x1c; b[3] = 0xa1; b[4] = 30; b[5] = 1;
  assert.equal(P.decodificar(b).durationMs, 90 * 60000);
});

// ── Órdenes y eventos ─────────────────────────────────────────────────────────

test('GO: manda C1 por USB con el ID de informe delante, y la manga arranca con el verde del aparato', () => {
  SerialService.sendGo(10 * 60000);
  assert.equal(t.ordenes.length, 1);
  assert.equal(t.ordenes[0].length, 17);
  assert.deepEqual([...t.ordenes[0].subarray(0, 4)], [0x00, 0xc1, 10, 0]);
  assert.deepEqual(senales, [], 'pulsar no arranca nada: espera al aparato');

  t.evento(t.E.ARRANQUE_TIEMPO, [10, 0]);
  t.evento(t.E.SEMAFORO);
  t.evento(t.E.INICIO);
  assert.deepEqual(senales, ['race_go:600000', 'semaphore_step', 'race_started']);
});

test('pausa, reanudar y fin de tiempo llegan de las tramas del aparato', () => {
  SerialService.sendGo(60000);
  t.evento(t.E.ARRANQUE_TIEMPO, [1, 0]);
  t.evento(t.E.INICIO);
  senales.length = 0;

  SerialService.sendPause();
  assert.equal(t.ordenesHex().at(-1), 'c3');
  assert.deepEqual(senales, [], 'la pausa es cuando el aparato corta');
  t.evento(t.E.PAUSA);
  // TimingService reenvía la pausa a la fuente al pausar el circuito: no se repite la orden.
  SerialService.sendPause();
  assert.equal(t.ordenesHex().filter(o => o === 'c3').length, 1);

  SerialService.sendResume();
  assert.equal(t.ordenesHex().at(-1), 'c4');
  t.evento(t.E.SEMAFORO);
  t.evento(t.E.INICIO);
  t.evento(t.E.FINAL);
  assert.deepEqual(senales, ['race_paused', 'race_resume_signal', 'semaphore_step', 'race_resumed', 'race_finished']);

  // Con la manga ya cerrada por el aparato, el STOP del cierre de PitWall no se manda.
  const antes = t.ordenes.length;
  SerialService.sendStop();
  assert.equal(t.ordenes.length, antes);
});

test('el STOP con que contesta el aparato a nuestra orden es su eco: no se propaga', () => {
  SerialService.sendGo(60000);
  t.evento(t.E.INICIO);
  senales.length = 0;
  SerialService.sendStop();
  assert.equal(t.ordenesHex().at(-1), 'c2');
  t.evento(t.E.STOP);
  assert.deepEqual(senales, []);
});

test('un STOP del aparato que nadie ha pedido sí para la manga', () => {
  t.evento(t.E.INICIO);
  t.evento(t.E.STOP);
  assert.deepEqual(senales, ['race_started', 'race_stopped']);
});

test('entreno sin tiempo: se le da uno largo al aparato y a PitWall se le dice «sin tiempo»', () => {
  SerialService.sendGo(null);
  assert.equal(t.ordenesHex()[0], 'c13c08', '9 horas');
  t.evento(t.E.ARRANQUE_TIEMPO, [60, 8]);
  assert.deepEqual(senales, ['race_go:0']);
});

test('si el aparato no contesta al GO, PitWall arranca por su cuenta tras su semáforo', async () => {
  Object.assign(TicTacConnection.TIEMPOS, { respuesta: 20, semaforoLocal: 30 });
  SerialService.sendGo(5 * 60000);
  await espera(25);
  assert.deepEqual(senales, ['race_go:300000']);
  await espera(40);
  assert.deepEqual(senales, ['race_go:300000', 'race_started']);
  // Un INICIO que llegue tarde ya no arranca otra vez.
  t.evento(t.E.INICIO);
  assert.deepEqual(senales, ['race_go:300000', 'race_started']);
});

test('sin el aparato conectado, el GO y la pausa siguen funcionando como antes', async () => {
  Object.assign(TicTacConnection.TIEMPOS, { semaforoLocal: 30 });
  const sinUsb = tictacConectado({ conUsb: false });
  SerialService._connections = [sinUsb.conn];
  SerialService.sendGo(60000);
  assert.deepEqual(senales, ['race_go:60000'], 'el semáforo sale en el acto');
  await espera(40);
  SerialService.sendPause();
  assert.deepEqual(senales, ['race_go:60000', 'race_started', 'race_paused']);
});

test('si el verde no llega tras el arranque del aparato, PitWall arranca igualmente', async () => {
  Object.assign(TicTacConnection.TIEMPOS, { verdeMax: 30 });
  SerialService.sendGo(60000);
  t.evento(t.E.ARRANQUE_TIEMPO, [1, 0]);
  await espera(45);
  assert.deepEqual(senales, ['race_go:60000', 'race_started']);
});

// ── Dueño del GO ──────────────────────────────────────────────────────────────

test('el arranque que devuelve la caja es de quien pulsó GO, aunque otra carrera tenga el directo', () => {
  const base = { mangaRaceId: null, poleRaceId: null, halfTanda: null, claimRaceId: 7,
                 tandaBoundary: false, liveViewer: true, simReplay: false };
  assert.equal(decideGoOwner(base).owner, 'race');
  assert.equal(decideGoOwner({ ...base, remoteGo: { owner: 'training', raceId: null } }).owner, 'training');
  assert.deepEqual(
    { ...decideGoOwner({ ...base, claimRaceId: null, liveViewer: false, remoteGo: { owner: 'race', raceId: 3 } }) },
    { owner: 'race', reason: 'remote_go', raceId: 3, claimed: true });
  assert.equal(decideGoOwner({ ...base, mangaRaceId: 9, remoteGo: { owner: 'training', raceId: null } }).owner, 'race',
               'una manga en marcha manda');
});

test('la marca del GO pedido caduca sola', () => {
  GoOwnerService.armRemoteGo('training');
  assert.equal(GoOwnerService.snapshot().remoteGo.owner, 'training');
  GoOwnerService._remoteGo.until = Date.now() - 1;
  assert.equal(GoOwnerService.snapshot().remoteGo, null);
});

// ── Endpoints ─────────────────────────────────────────────────────────────────

function peticion(params = {}, body = {}) {
  const out = { status: 200, body: null, redirect: null };
  const req = { params, body, t: k => k, xhr: true, get: () => '' };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; },
    redirect(u) { out.redirect = u; },
    render() {},
  };
  return { req, res, out };
}

test('GO de una manga con TicTac: deja la manga lista para el verde y manda el tiempo de la carrera', () => {
  const a = { nombre: 'Ana', id: crearPerfil('Ana') };
  crearEquipoCatalogo('E1', [a]);
  const { raceId, mangaId } = crearCarreraConManga([{ nombre: 'E1', pilotos: [a] }], { circuitsConfig: [1] });
  db.prepare('UPDATE races SET manga_duration_minutes = 8 WHERE id = ?').run(raceId);

  const { req, res, out } = peticion({ id: String(raceId), mangaId: String(mangaId) });
  SessionController.start(req, res);
  assert.deepEqual(out.body, { ok: true, semaphore: true });
  assert.deepEqual(t.ordenesHex(), ['c10800']);
  assert.equal(TimingService.isRunning, false, 'la manga arranca con el verde de la caja, no al pulsar');
  assert.equal(TimingService._pendingSetup.manga.id, mangaId);
  const go = GoOwnerService.decide();
  assert.equal(go.owner, 'race');
  assert.equal(go.raceId, raceId);
});

test('GO del entreno con TicTac: manda la orden con su duración y el GO es del entreno', () => {
  TrainingService.prepare(4);
  const { req, res, out } = peticion({}, { mode: 'free', duration_minutes: '15' });
  TrainingController.go(req, res);
  assert.deepEqual(out.body, { ok: true, semaphore: true });
  assert.deepEqual(t.ordenesHex(), ['c10f00']);
  assert.equal(GoOwnerService.decide().owner, 'training');
  TrainingService.resetSession();
});
