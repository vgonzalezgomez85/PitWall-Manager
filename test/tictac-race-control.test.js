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
// Fase 3: con el interface TicTac PitWall dirige la carrera. El aparato solo manda
// cruces, así que el GO, la pausa, el stop y el fin los genera PitWall. Se ejercita el
// camino real: TicTacConnection → SerialService → TimingService.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Manga         = require('../src/models/Manga');
const SerialService = require('../src/services/SerialService');
const TimingService = require('../src/services/TimingService');
const TicTacConnection = require('../src/services/TicTacConnection');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

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
  TimingService._lateWindows.clear();
}

const linkOriginal = SerialService.getLinkStatus.bind(SerialService);
SerialService.getLinkStatus = () => ({ ...linkOriginal(), simulating: false });
const conexionesOriginales = SerialService._connections;

after(() => {
  apagarTimers();
  SerialService._connections = conexionesOriginales;
  SerialService.getLinkStatus = linkOriginal;
  limpiarBdTemporal();
});

let conn, emitidos;

beforeEach(async () => {
  await new Promise(r => setImmediate(r));
  apagarTimers();
  for (const t of ['manga_circuits', 'driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams',
                   'mangas', 'tandas', 'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles', 'settings']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
  // Un TicTac de verdad, sin puerto: sus cruces salen por el mismo evento que en producción.
  emitidos = [];
  const noop = () => {};
  conn = new TicTacConnection(0, 0, d => { emitidos.push(d); SerialService.emit('lane_crossing', { circuit: 0, ...d }); },
                              noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
  SerialService._connections = [conn];
});

function cruceTrama({ lane = 1, lap = 1, min = 0, ms = 0, seq = 0 }) {
  const b = Buffer.alloc(16);
  b[0] = 0xc0; b[1] = seq; b[2] = 0x1b; b[4] = lane;
  b.writeUInt16BE(lap, 5); b.writeUInt16BE(min, 7); b.writeUInt16BE(ms, 9);
  return b;
}
const aparato = (lane, min, ms) => conn._onData(cruceTrama({ lane, min, ms }));

function unEquipo() {
  const a = { nombre: 'Ana', id: crearPerfil('Ana') };
  crearEquipoCatalogo('E1', [a]);
  const { raceId, mangaId } = crearCarreraConManga([{ nombre: 'E1', pilotos: [a] }], { circuitsConfig: [1] });
  const race  = db.prepare('SELECT * FROM races  WHERE id = ?').get(raceId);
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return { raceId, mangaId, race, manga };
}
function darGo(e, durMs) {
  const lanes   = Manga.getLanes(e.mangaId);
  const teams   = db.prepare('SELECT * FROM teams   WHERE tanda_id = ?').all(e.manga.tanda_id);
  const drivers = db.prepare('SELECT * FROM drivers WHERE tanda_id = ?').all(e.manga.tanda_id);
  TimingService.startManga(e.manga, e.race, lanes, teams, drivers, durMs);
}

test('con TicTac, PitWall da el GO: softwareGo, termina por temporizador y no es BART', () => {
  assert.equal(SerialService.isTicTac, true);
  assert.equal(SerialService.softwareGo, true);
  assert.equal(SerialService.endsByTimer, true);
  assert.equal(SerialService.isBart, false, 'el aparato no se pausa: la compensación de pausa del DS aplica');
  assert.equal(SerialService.getLinkStatus().circuits[0].isTicTac, true);
});

test('las píldoras de estado nombran la fuente: TicTac, BART o el modelo de DS', () => {
  assert.equal(SerialService.getLinkStatus().label, 'TicTac');
  SerialService._connections = [{ connected: true, _model: 'ds200' }];
  assert.equal(SerialService.getLinkStatus().label, 'DS-200');
  SerialService._connections = [{ connected: true }, { connected: true, isBart: true }, conn];
  assert.equal(SerialService.getLinkStatus().label, 'DS-300 + BART + TicTac');
  SerialService._connections = [{ connected: true }, { connected: true }];
  assert.equal(SerialService.getLinkStatus().label, 'DS-300', 'un solo nombre aunque haya varias cajas');
});

test('con un DS, manda la caja: ni softwareGo ni temporizador', () => {
  SerialService._connections = [{ connected: true }];
  assert.equal(SerialService.isTicTac, false);
  assert.equal(SerialService.softwareGo, false);
  assert.equal(SerialService.endsByTimer, false);
});

test('el GO borra la referencia de reloj: el primer cruce sale sin tiempo y cuenta como vuelta de salida', () => {
  const e = unEquipo();
  aparato(1, 0, 1000);                    // coche rodando antes del GO
  darGo(e, 60 * 60000);
  aparato(1, 0, 13000);                   // sin GO esto sería «12 s» de vuelta
  assert.equal(emitidos[1].lapTimeMs, null, 'primer cruce tras el GO: sin tiempo');
  assert.equal(TimingService.session.laneMap[1].lapCount, 1);
  aparato(1, 0, 25500);
  assert.equal(emitidos[2].lapTimeMs, 12500);
  assert.equal(TimingService.session.laneMap[1].lapCount, 2);
});

test('con la manga viva una vuelta larga NO se convierte en «primer cruce» (pausa de minutos)', () => {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  aparato(1, 0, 5000);
  aparato(1, 10, 5000);                   // 10 min después: p. ej. tras una pausa larga
  assert.equal(emitidos[1].lapTimeMs, 600000);
});

test('sin manga viva, un silencio de más de 240 s sí es otra sesión: cruce «primero»', () => {
  aparato(1, 0, 5000);
  aparato(1, 10, 5000);
  assert.deepEqual(emitidos.map(x => x.lapTimeMs), [null, null]);
});

test('el fin llega JUSTO al agotar el tiempo (sin los 30 s de respaldo del DS)', async () => {
  const e = unEquipo();
  darGo(e, 400);
  assert.equal(TimingService.isRunning, true);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(TimingService.session, null, 'PitWall cerró la manga por tiempo');
  assert.equal(db.prepare('SELECT status FROM mangas WHERE id = ?').get(e.mangaId).status, 'finished');
});

test('un cruce no retrasa el fin: la manga sigue cerrando a su hora', async () => {
  const e = unEquipo();
  darGo(e, 500);
  aparato(1, 0, 1000);
  setTimeout(() => aparato(1, 0, 14000), 250);   // sigue rodando hasta el final
  await new Promise(r => setTimeout(r, 800));
  assert.equal(TimingService.session, null);
});

test('la vuelta de bandera cuenta tras el fin, con el tiempo real del aparato', async () => {
  const e = unEquipo();
  darGo(e, 300);
  aparato(1, 0, 1000);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(TimingService.session, null);
  aparato(1, 0, 13400);                          // el coche cruza la meta tras la bandera
  const f = db.prepare('SELECT * FROM laps WHERE manga_id = ? AND lane = 1 AND is_flag_lap = 1').all(e.mangaId);
  assert.equal(f.length, 1);
  assert.equal(f[0].lap_time_ms, 12400, 'tiempo REAL, no la media');
});

test('pausa y reanudación: el cruce tras reanudar descuenta lo que duró la pausa', () => {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  aparato(1, 0, 1000);
  aparato(1, 0, 13000);                          // vuelta de referencia
  TimingService.pauseManga();
  assert.equal(TimingService.isPaused, true);
  aparato(1, 0, 20000);                          // cruce durante la pausa: se ignora
  assert.equal(TimingService.session.laneMap[1].lapCount, 2, 'durante la pausa no se cuenta');

  const c = TimingService.session.circuits[0];
  c.pauseStart = Date.now() - 5000;              // la pausa duró 5 s
  TimingService.resumeManga();
  assert.equal(TimingService.session.laneMap[1].pendingPauseAdjustMs > 0, true, 'se compensa como en un DS');
});

test('el stop forzado cierra la manga y la fuente TicTac sigue viva', () => {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  TimingService.stopManga(true);
  assert.equal(TimingService.session, null);
  assert.doesNotThrow(() => aparato(1, 0, 3000));
});

// ── La vuelta de bandera es igual para todos los dispositivos ───────────────────
const Settings = require('../src/models/Settings');

function cruceDirecto(lane, lapTimeMs) {
  SerialService.emit('lane_crossing', { lane, timestamp: Date.now(), lapTimeMs, circuit: 0 });
}
const vueltasBandera = (mangaId, lane) =>
  db.prepare('SELECT * FROM laps WHERE manga_id = ? AND lane = ? AND is_flag_lap = 1').all(mangaId, lane);

function conFuente(conexiones, simulando, fn) {
  const link = SerialService.getLinkStatus;
  SerialService._connections = conexiones;
  SerialService.getLinkStatus = () => ({ ...link(), simulating: simulando });
  try { return fn(); } finally { SerialService.getLinkStatus = link; }
}

function finalConCruce() {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  const c = TimingService.session.circuits[0];
  c.startTime = Date.now() - 60 * 60000;
  cruceDirecto(1, null);
  cruceDirecto(1, 12000);
  TimingService.finishCircuit(0);
  cruceDirecto(1, 11800);                       // el coche cruza la meta tras la bandera
  return e;
}

test('bandera con BART: el cruce tras el final cuenta con su tiempo real', () => {
  conFuente([{ connected: true, isBart: true }], false, () => {
    const e = finalConCruce();
    const f = vueltasBandera(e.mangaId, 1);
    assert.equal(f.length, 1);
    assert.equal(f[0].lap_time_ms, 11800);
  });
});

test('bandera con simulación: el cruce tras el final cuenta con su tiempo real', () => {
  conFuente([], true, () => {
    const e = finalConCruce();
    const f = vueltasBandera(e.mangaId, 1);
    assert.equal(f.length, 1);
    assert.equal(f[0].lap_time_ms, 11800);
  });
});

test('bandera: con la ventana a 0 en Ajustes ningún dispositivo la usa', () => {
  Settings.setMany({ late_crossing_grace_ms: '0' });
  conFuente([{ connected: true, isBart: true }], false, () => {
    const e = finalConCruce();
    assert.equal(vueltasBandera(e.mangaId, 1).length, 0);
  });
});

// ── Reposición de vueltas perdidas, en el motor real ─────────────────────────────
const pasaSeq = (o) => conn._onData(cruceTrama(o));

test('un cruce perdido del TicTac suma sus vueltas, estimadas, sin deformar la media ni la mejor vuelta', async () => {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  pasaSeq({ seq: 1, lap: 1, ms: 1000 });                 // salida
  pasaSeq({ seq: 2, lap: 2, ms: 13000 });                // 12,0 s
  pasaSeq({ seq: 3, lap: 3, ms: 24500 });                // 11,5 s ← mejor vuelta real
  const ld = TimingService.session.laneMap[1];
  assert.equal(ld.lapCount, 3);
  const mejorAntes = ld.bestLapMs;

  pasaSeq({ seq: 5, lap: 5, ms: 48500 });                // falta el cruce de la vuelta 4: 24 s para 2
  assert.equal(ld.lapCount, 5, 'las dos vueltas del tramo cuentan para el total');
  assert.equal(ld.bestLapMs, mejorAntes, 'una estimada no puede ser la mejor vuelta');

  await new Promise(r => setImmediate(r));               // la vuelta de salida se persiste en setImmediate
  const filas = db.prepare('SELECT lap_number, lap_time_ms, is_estimated FROM laps WHERE manga_id = ? AND lane = 1 ORDER BY lap_number').all(e.mangaId);
  assert.deepEqual(filas.map(f => f.lap_number), [1, 2, 3, 4, 5]);
  assert.deepEqual(filas.map(f => f.is_estimated), [0, 0, 0, 1, 1], 'las repuestas quedan marcadas para revisarlas');
  assert.equal(filas[3].lap_time_ms, 11750, 'la media de las vueltas reales (12,0 y 11,5)');
});

test('un salto del contador sin trama perdida NO añade vueltas en el motor', () => {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  pasaSeq({ seq: 1, lap: 1, ms: 1000 });
  pasaSeq({ seq: 2, lap: 2, ms: 13000 });
  pasaSeq({ seq: 3, lap: 9, ms: 25000 });
  assert.equal(TimingService.session.laneMap[1].lapCount, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM laps WHERE manga_id = ? AND is_estimated = 1').get(e.mangaId).c, 0);
});

test('una vuelta repuesta sin vueltas reales previas tampoco puede ser la mejor vuelta', () => {
  const e = unEquipo();
  darGo(e, 60 * 60000);
  pasaSeq({ seq: 1, lap: 1, ms: 1000 });
  pasaSeq({ seq: 3, lap: 3, ms: 21000 });                // 20 s para 2 vueltas, sin media previa: 10 s estimadas
  const ld = TimingService.session.laneMap[1];
  assert.equal(ld.lapCount, 3);
  assert.ok(!ld.bestLapMs, 'ninguna estimada compite por la mejor vuelta');
});
