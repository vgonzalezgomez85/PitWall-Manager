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
// ════════════════════════════════════════════════════════════════════════════
//  WORKER DE STATS — hilo aparte para los agregados caros de `laps`.
//
//  Motiva esto que el cálculo de la proyección de carrera (~100 ms) y el
//  agregado de mangas anteriores (~40-75 ms) son SELECTs síncronos de
//  better-sqlite3 que hoy bloquean el event loop principal en cada cruce y en
//  cada petición de live-stats. Con 24 carriles y muchas pantallas, ese bloqueo
//  acumulado retrasa el tick de 1 s y puede partir una trama del DS-300
//  (FRAME_GAP_MS = 75 ms). Aquí corre en un núcleo distinto y el hilo principal
//  solo recibe el resultado ya hecho.
//
//  Este worker SOLO LEE: abre su propia conexión `readonly` al mismo
//  `pitwall.db` (ver src/config/database.js, rama PITWALL_DB_READONLY). El
//  cálculo es el módulo puro `src/engine/raceProjection.js` — el MISMO que usa
//  el hilo principal, con un test de equivalencia (test/race-projection-engine).
//
//  Protocolo (mensajes con el hilo principal):
//    → { type: 'projection', reqId, raceId }          proyección de una carrera
//    → { type: 'raceWide', reqId, raceId, minLapMs }  agregados race-wide de live-stats
//    → { type: 'invalidate' }                         alguien tocó `laps` (corrección):
//                                                     tira las cachés internas del worker
//    → { type: 'ping', reqId }                        latido
//    ← { type: 'ready' }                              emitido una vez, al cargar
//    ← { type: 'projection'|'raceWide', reqId, raceId, value, computedAt, ms }
//    ← { type: 'pong', reqId }
//    ← { type: 'error', reqId, raceId, error }
// ════════════════════════════════════════════════════════════════════════════
'use strict';

// DEBE fijarse antes de requerir la BD o cualquier modelo: decide qué conexión
// abre el singleton de src/config/database.js. (El cliente que arranca el worker
// también lo pasa por `env`, esto es el cinturón por si se ejecuta suelto.)
process.env.PITWALL_DB_READONLY = '1';

const { parentPort } = require('node:worker_threads');
const raceProjection = require('../engine/raceProjection');
const raceWideStats  = require('../engine/raceWideStats');

if (!parentPort) {
  throw new Error('statsWorker.js solo se ejecuta como worker_thread');
}

// Perezoso: el primer require abre la conexión readonly. Si PITWALL_DATA está
// mal y el fichero no existe, `fileMustExist` lanza aquí y el error viaja al
// hilo principal como { type:'error' } en vez de tumbar el worker al cargar.
let _db = null, _Lap = null;
function deps() {
  if (!_db)  _db  = require('../config/database');
  if (!_Lap) _Lap = require('../models/Lap');
  return { db: _db, Lap: _Lap };
}

function handleProjection(raceId) {
  return raceProjection.buildRaceProjection(raceId, deps());
}

function handleRaceWide(raceId, minLapMs) {
  return raceWideStats.build(raceId, { db: deps().db, minLapMs });
}

// Una corrección de vueltas en el hilo principal no llega sola hasta aquí: la
// conexión readonly ve el nuevo estado de `laps`, pero las cachés INTERNAS del
// modelo Lap (p. ej. `_settledCache`, invalidada por su contador de mutaciones,
// que en este proceso nunca sube porque nadie escribe) se quedarían pegadas.
// `markExternalMutation()` incrementa ese contador → las cachés se rehacen.
function handleInvalidate() {
  if (_Lap && typeof _Lap.markExternalMutation === 'function') _Lap.markExternalMutation();
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { type, reqId, raceId } = msg;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'projection': {
        const value = handleProjection(raceId);
        parentPort.postMessage({
          type: 'projection', reqId, raceId, value,
          computedAt: Date.now(), ms: +(performance.now() - t0).toFixed(2),
        });
        return;
      }
      case 'raceWide': {
        const value = handleRaceWide(raceId, msg.minLapMs);
        parentPort.postMessage({
          type: 'raceWide', reqId, raceId, value,
          computedAt: Date.now(), ms: +(performance.now() - t0).toFixed(2),
        });
        return;
      }
      case 'invalidate':
        handleInvalidate();
        return;
      case 'ping':
        parentPort.postMessage({ type: 'pong', reqId });
        return;
      default:
        parentPort.postMessage({ type: 'error', reqId, raceId, error: `tipo de mensaje desconocido: ${type}` });
    }
  } catch (err) {
    parentPort.postMessage({
      type: 'error', reqId, raceId,
      error: (err && err.message) || String(err),
    });
  }
});

// Avisa de que ya está listo para recibir peticiones (conexión no abierta aún —
// se abre perezosa en la primera petición).
parentPort.postMessage({ type: 'ready' });
