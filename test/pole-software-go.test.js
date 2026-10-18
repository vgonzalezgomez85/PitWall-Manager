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
// Pole position con fuentes dirigidas por PitWall (BART, TicTac, simulación): el GO,
// la pausa y la reanudación los da PitWall en vez de la caja DS. Con un DS manda la
// caja y estos endpoints rechazan la petición.
'use strict';

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Race             = require('../src/models/Race');
const PoleSession      = require('../src/models/PoleSession');
const PoleController   = require('../src/controllers/PoleController');
const PoleTimingService = require('../src/services/PoleTimingService');
const SerialService    = require('../src/services/SerialService');
const TicTacConnection = require('../src/services/TicTacConnection');
const { tictacConectado } = require('./helpers/tictacAparato');

const conexionesOriginales = SerialService._connections;
const enviados = [];
const originales = {};
for (const m of ['sendStart', 'sendStop', 'sendPause', 'sendResume']) {
  originales[m] = SerialService[m].bind(SerialService);
  SerialService[m] = (...a) => { enviados.push(m); return originales[m](...a); };
}

let conn, emitidos;

after(() => {
  PoleTimingService.abort();
  SerialService._connections = conexionesOriginales;
  for (const m of Object.keys(originales)) SerialService[m] = originales[m];
  limpiarBdTemporal();
});

beforeEach(() => {
  PoleTimingService.abort();
  PoleTimingService._omitFirstCrossing = true;
  enviados.length = 0;
  emitidos = [];
  const noop = () => {};
  conn = new TicTacConnection(0, 0, d => { emitidos.push(d); SerialService.emit('lane_crossing', { circuit: 0, ...d }); },
                              noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  SerialService._connections = [conn];
});

function escenario(nombres = ['A', 'B'], minutos = 5) {
  const raceId = Race.create({
    name: 'pole-sw', type: 'club', format: 'individual',
    lanes_count: 6, lane_sequence: [1, 2, 3, 4, 5, 6],
    manga_duration_minutes: minutos, has_pole: 1,
  });
  const sessionId = PoleSession.create(raceId);
  const ids = nombres.map(n =>
    PoleSession.addEntry({ poleSessionId: sessionId, entityType: 'driver', entityName: n, membersJson: null }));
  PoleSession.startPole(sessionId, 1, ids);
  return { raceId, sessionId, ids };
}

function peticion(raceId) {
  const out = { status: 200, body: null };
  const req = { params: { id: String(raceId) }, body: {}, t: k => k };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; }, redirect() {}, render() {} };
  return { req, res, out };
}

function preparar(e, durationMs = 60000) {
  PoleTimingService.start({ poleSessionId: e.sessionId, entryId: e.ids[0], entryName: 'A', poleLane: 1, durationMs, minLapMs: 0 });
}

function cruce(min, ms, lane = 1) {
  const b = Buffer.alloc(16);
  b[0] = 0xc0; b[2] = 0x1b; b[4] = lane;
  b.writeUInt16BE(min, 7); b.writeUInt16BE(ms, 9);
  conn._onData(b);
}

test('go() arranca la pole desde standby y arma la fuente (sendStart)', () => {
  preparar(escenario());
  assert.equal(PoleTimingService.isStandby, true);
  assert.equal(PoleTimingService.go(), true);
  assert.equal(PoleTimingService.isRunning, true);
  assert.deepEqual(enviados.filter(m => m === 'sendStart'), ['sendStart']);
});

test('go() sin standby no hace nada', () => {
  assert.equal(PoleTimingService.go(), false);
  preparar(escenario());
  PoleTimingService.go();
  assert.equal(PoleTimingService.go(), false, 'ya está corriendo');
});

test('pausa y reanudación cambian el estado y se lo mandan a la fuente', () => {
  preparar(escenario());
  PoleTimingService.go();
  assert.equal(PoleTimingService.pause(), true);
  assert.equal(PoleTimingService.isPaused, true);
  assert.equal(PoleTimingService.pause(), false, 'ya en pausa');
  assert.equal(PoleTimingService.resume(), true);
  assert.equal(PoleTimingService.isPaused, false);
  assert.ok(enviados.includes('sendPause') && enviados.includes('sendResume'));
});

test('abortar o terminar la pole para la fuente (sendStop)', () => {
  preparar(escenario());
  PoleTimingService.go();
  PoleTimingService.abort();
  assert.ok(enviados.includes('sendStop'));
  enviados.length = 0;
  preparar(escenario());
  PoleTimingService.go();
  PoleTimingService.finish(false);
  assert.ok(enviados.includes('sendStop'));
});

test('con TicTac: el primer cruce tras el GO es la vuelta de salida y la mejor vuelta sale del reloj del aparato', () => {
  const e = escenario();
  preparar(e);
  cruce(0, 1000);                    // coche rodando antes del GO
  PoleTimingService.go();            // el GO borra la referencia de reloj
  // Los cruces del test llegan de golpe; el antirrebote de la pole mide con el reloj
  // del PC, así que se simula el espaciado real entre cruces.
  const espaciado = (min, ms) => { PoleTimingService.session.lastCrossing -= 10000; cruce(min, ms); };
  espaciado(0, 9000);                // salida: sin tiempo, se omite
  espaciado(0, 21500);               // 1ª vuelta voladora: 12,5 s
  espaciado(0, 33100);               // 2ª: 11,6 s
  espaciado(0, 45800);               // 3ª: 12,7 s
  assert.equal(PoleTimingService.currentBestLap, 11600);
  PoleTimingService.finish(false);
  const entrada = PoleSession.getEntriesOrdered(e.sessionId)[0];
  assert.equal(entrada.lap_time_ms, 11600);
});

test('la pole termina sola al agotar el tiempo y guarda la mejor vuelta', async () => {
  const e = escenario();
  preparar(e, 300);
  PoleTimingService.go();
  cruce(0, 1000); cruce(0, 13000);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(PoleTimingService.session, null);
  assert.equal(PoleSession.getEntriesOrdered(e.sessionId)[0].lap_time_ms, 12000);
});

test('endpoints: con un DS (manda la caja) rechazan GO, pausa y reanudar', () => {
  SerialService._connections = [{ connected: true }];
  const e = escenario();
  for (const accion of ['goParticipant', 'pauseParticipant', 'resumeParticipant']) {
    const { req, res, out } = peticion(e.raceId);
    PoleController[accion](req, res);
    assert.equal(out.status, 409, accion);
    assert.equal(out.body.error, 'not_software_go');
  }
});

test('endpoint GO con TicTac: manda la orden con el tiempo y arranca con el verde del aparato', () => {
  const e = escenario(['A', 'B'], 5);
  const t = tictacConectado();
  SerialService._connections = [t.conn];
  const { req, res, out } = peticion(e.raceId);
  PoleController.goParticipant(req, res);
  assert.equal(out.status, 200);
  assert.deepEqual(t.ordenesHex(), ['c10500'], 'C1 con 5 minutos');
  assert.equal(PoleTimingService.isStandby, true, 'sigue esperando: la corriente aún no está');
  t.evento(t.E.ARRANQUE_TIEMPO, [5, 0]);
  t.evento(t.E.SEMAFORO);
  assert.equal(PoleTimingService.isRunning, false, 'el semáforo del aparato no arranca');
  t.evento(t.E.INICIO);
  assert.equal(PoleTimingService.isRunning, true, 'arranca con el verde del aparato');
  t.conn._limpiarEspera();
});

test('endpoint GO: si se aborta durante el semáforo, el GO ya no vale', async () => {
  const e = escenario();
  Object.defineProperty(PoleController, 'SEMAPHORE_MS', { get: () => 80, configurable: true });
  try {
    const { req, res } = peticion(e.raceId);
    PoleController.goParticipant(req, res);
    PoleTimingService.abort();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(PoleTimingService.isRunning, false);
  } finally {
    delete PoleController.SEMAPHORE_MS;
    Object.defineProperty(PoleController, 'SEMAPHORE_MS', { get: () => 3000, configurable: true });
  }
});

test('endpoint pausa y reanudar con TicTac: corta y abre la caja, y la pole sigue sus tramas', async () => {
  const e = escenario();
  const t = tictacConectado();
  SerialService._connections = [t.conn];
  let p = peticion(e.raceId);
  PoleController.goParticipant(p.req, p.res);
  t.evento(t.E.INICIO);
  assert.equal(PoleTimingService.isRunning, true);

  p = peticion(e.raceId);
  const pausa = PoleController.pauseParticipant(p.req, p.res);
  assert.equal(t.ordenesHex().at(-1), 'c3');
  t.evento(t.E.PAUSA);
  await pausa;
  assert.equal(p.out.body.ok, true);
  assert.equal(PoleTimingService.isPaused, true);

  p = peticion(e.raceId);
  PoleController.resumeParticipant(p.req, p.res);
  assert.equal(t.ordenesHex().at(-1), 'c4');
  assert.equal(PoleTimingService.isPaused, true, 'hasta el verde del aparato sigue en pausa');
  t.evento(t.E.INICIO);
  assert.equal(PoleTimingService.isPaused, false);

  // Parar: corta la corriente y el STOP con que contesta el aparato es el eco de
  // la orden, no un segundo stop (re-armaría y dejaría al piloto a medias).
  PoleController.stopParticipant(peticion(e.raceId).req, peticion(e.raceId).res);
  assert.equal(t.ordenesHex().at(-1), 'c2');
  assert.equal(PoleTimingService.isStandby, true);
  t.evento(t.E.STOP);
  assert.equal(PoleTimingService.isStandby, true);
});

test('la pole ignora las vueltas repuestas (estimadas): no cuentan ni pueden ser la mejor', () => {
  const e = escenario();
  preparar(e);
  PoleTimingService.go();
  const espaciado = (min, ms) => { PoleTimingService.session.lastCrossing -= 10000; cruce(min, ms); };
  espaciado(0, 9000);
  espaciado(0, 21500);                                   // 12,5 s
  const antes = PoleTimingService.session.lapCount;
  SerialService.emit('lane_crossing', { lane: 1, timestamp: Date.now(), lapTimeMs: 8000, missed: true });
  assert.equal(PoleTimingService.session.lapCount, antes);
  assert.equal(PoleTimingService.currentBestLap, 12500, 'una estimada de 8 s no puede ser la mejor');
});
