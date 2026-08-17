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
// SocketService.emitLap agrupa cruces en lote bajo carga (a diferencia de
// emitStandings, que coalesce quedándose con el último) porque un 'lap' de
// un carril NUNCA puede sustituir al de otro carril — se perdería el aviso.
// Prueba pura de la capa de broadcast, sin tocar TimingService/SerialService
// (no toca la lectura de tramas DS-300 en absoluto): llama a emitLap()
// directamente y observa qué le llega a clientes socket.io reales.
'use strict';

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const http       = require('node:http');
const { io: ioc } = require('socket.io-client');

const SocketService = require('../src/services/SocketService');

function startServer() {
  const server = http.createServer();
  SocketService.init(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function connectClients(port, n) {
  return Promise.all(
    Array.from({ length: n }, () => new Promise((resolve, reject) => {
      const c = ioc(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      c.on('connect', () => resolve(c));
      c.on('connect_error', reject);
    }))
  );
}

function waitForLapEvents(client, count, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${count} eventos 'lap', llegaron ${received.length}`)), timeoutMs);
    client.on('lap', (laps) => {
      received.push(laps);
      if (received.length >= count) { clearTimeout(timer); resolve(received); }
    });
  });
}

test('pocos clientes (<=10): cada emitLap() llega YA, como array de 1 elemento', async () => {
  const server = await startServer();
  const port = server.address().port;
  const [listener] = await connectClients(port, 1);   // 1 cliente total → delay=0

  const gotPromise = waitForLapEvents(listener, 2);
  SocketService.emitLap({ lane: 1, lapNumber: 1 });
  await new Promise((r) => setTimeout(r, 30));
  SocketService.emitLap({ lane: 2, lapNumber: 1 });
  const got = await gotPromise;

  assert.equal(got.length, 2, 'dos emisiones separadas, no agrupadas');
  assert.deepEqual(got[0], [{ lane: 1, lapNumber: 1 }]);
  assert.deepEqual(got[1], [{ lane: 2, lapNumber: 1 }]);

  listener.close();
  await new Promise((r) => server.close(r));
});

test('muchos clientes (>30): varios cruces seguidos de carriles distintos se agrupan en UN array, sin perder ninguno', async () => {
  const server = await startServer();
  const port = server.address().port;
  // 31 clientes → adaptiveDelay() = 300ms (ver SocketService.js)
  const clients = await connectClients(port, 31);
  const listener = clients[0];

  const gotPromise = waitForLapEvents(listener, 1, 3000);
  // Cruces de 5 carriles distintos, disparados casi a la vez (dentro de la
  // ventana de 300ms) — con standings esto perdería 4; con laps NO debe perder ninguno.
  for (let lane = 1; lane <= 5; lane++) {
    SocketService.emitLap({ lane, lapNumber: 1 });
  }
  const [batch] = await gotPromise;

  assert.equal(batch.length, 5, 'los 5 cruces llegan juntos, ninguno se descarta');
  assert.deepEqual(batch.map(l => l.lane), [1, 2, 3, 4, 5], 'se conserva el orden de llegada');

  clients.forEach(c => c.close());
  await new Promise((r) => server.close(r));
});
