#!/usr/bin/env node
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
// Conecta al socket.io de SloTime como cliente y muestra el primer
// serial:status que llega tras el handshake.
const { io } = require('socket.io-client');
const sock = io('http://localhost:3000', { transports: ['websocket'] });

let received = false;
sock.on('connect',  () => console.log('socket connected, id =', sock.id));
sock.on('serial:status', (data) => {
  received = true;
  console.log('serial:status →', JSON.stringify(data, null, 2));
  setTimeout(() => process.exit(0), 200);
});
setTimeout(() => {
  if (!received) console.log('TIMEOUT — no serial:status received in 3s');
  process.exit(received ? 0 : 1);
}, 3000);
