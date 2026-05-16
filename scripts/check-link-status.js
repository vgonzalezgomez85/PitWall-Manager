#!/usr/bin/env node
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
