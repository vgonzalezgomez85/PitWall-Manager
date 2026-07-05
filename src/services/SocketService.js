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
const { Server } = require('socket.io');

let io = null;
// Tracks how many LOCALHOST clients are on a race "live" page right now.
// Hardware GO events only start a manga if at least one localhost live viewer
// is present (remote/mobile spectators don't count).
let localLiveViewers = 0;

function isLocalAddress(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1'
      || addr === '::1'
      || addr === '::ffff:127.0.0.1'
      || addr.startsWith('::ffff:127.');
}

// ── Adaptive standings throttle ───────────────────────────────────────────────
// Standings payload (~3-5 KB) is broadcast to every socket on each lap. With
// few clients we emit per lap for snappy UX; as clients pile up we coalesce
// emits to protect bandwidth and CPU. Delay is recomputed on every call so it
// adapts in real time as people connect/disconnect.
let _standingsLatest = null;
let _standingsTimer  = null;
let _standingsLastEmit = 0;

function adaptiveDelay() {
  if (!io) return 0;
  const n = io.engine.clientsCount || 0;
  if (n <= 10)  return 0;     // small club: emit per lap, no batching
  if (n <= 30)  return 150;   // ~6/s
  if (n <= 80)  return 300;   // ~3/s
  if (n <= 150) return 450;   // ~2/s
  return 600;                 // huge event: ~1.6/s
}

function flushStandings() {
  if (!io || !_standingsLatest) return;
  io.emit('standings', _standingsLatest);
  _standingsLatest = null;
  _standingsLastEmit = Date.now();
  _standingsTimer = null;
}

module.exports = {
  init(httpServer) {
    io = new Server(httpServer, { cors: { origin: '*' } });

    // Gate de acceso: bloquea sockets de navegadores desde IPs no autorizadas;
    // permite localhost, allowlist y la app móvil. (Infolap va por UDP, no
    // pasa por aquí.) Fail-open si algo falla, para no tumbar el live.
    io.use((socket, next) => {
      try {
        const { isSocketAllowed } = require('../middleware/accessControl');
        if (isSocketAllowed(socket)) return next();
        return next(new Error('forbidden'));
      } catch { return next(); }
    });

    io.on('connection', (socket) => {
      const remote = socket.handshake.address;
      const local  = isLocalAddress(remote);

      // Push current DS-300 link status to the freshly connected client so the
      // "Sin señal del DS-300" banner reflects reality from the first render.
      // Same criterion as the Settings page: simulation OR port open → OK.
      try {
        const SerialService = require('./SerialService');
        socket.emit('serial:status', SerialService.getLinkStatus());
      } catch {}

      socket.on('standings:request', () => {
        const TimingService = require('./TimingService');
        const data = TimingService.getStandings();
        if (data) socket.emit('standings', data);
      });

      socket.on('training:request', () => {
        const TrainingService = require('./TrainingService');
        if (TrainingService.isActive) {
          socket.emit('training:data', TrainingService.getLanes());
        }
      });

      // ── Race-live viewer presence tracking (localhost only) ───────────────
      let counted = false;
      socket.on('race:live:join', () => {
        if (local && !counted) { counted = true; localLiveViewers++; }
      });
      socket.on('race:live:leave', () => {
        if (counted) { counted = false; localLiveViewers = Math.max(0, localLiveViewers - 1); }
      });
      socket.on('disconnect', () => {
        if (counted) { counted = false; localLiveViewers = Math.max(0, localLiveViewers - 1); }
        setImmediate(() => this._emitConnections());
      });

      this._emitConnections();
    });
  },

  // Cuenta de conexiones por tipo, EXCLUYENDO localhost (el PC de control no
  // cuenta como espectador). Web = navegadores; mobile = app móvil (socket.io
  // con query client=mobile); infolap = clientes UDP del server Infolap.
  getConnectionCounts() {
    let web = 0, mobile = 0;
    if (io) {
      for (const [, s] of io.sockets.sockets) {
        if (isLocalAddress(s.handshake.address)) continue;
        // Móvil si la app se identifica (query client=mobile) o si NO es un
        // navegador: los navegadores siempre mandan user-agent "Mozilla/…";
        // el cliente React Native no manda user-agent.
        const q  = s.handshake.query || {};
        const ua = s.handshake.headers['user-agent'] || '';
        const isMobileApp = q.client === 'mobile' || !/mozilla/i.test(ua);
        if (isMobileApp) mobile++; else web++;
      }
    }
    let infolap = 0;
    try { infolap = require('./InfolapServer').remoteClientCount(); } catch {}
    return { web, mobile, infolap };
  },

  _emitConnections() {
    if (io) io.emit('connections', this.getConnectionCounts());
  },

  emit(event, data) {
    if (io) io.emit(event, data);
  },

  // Coalescing emit for `standings`: keeps only the latest payload and fires
  // at a frequency adapted to the number of connected clients. Use this
  // instead of emit('standings', ...) so the system auto-throttles.
  emitStandings(data) {
    if (!io) return;
    _standingsLatest = data;
    const delay = adaptiveDelay();
    if (delay === 0) {
      // Immediate path for small clubs — emit and reset state.
      if (_standingsTimer) { clearTimeout(_standingsTimer); _standingsTimer = null; }
      flushStandings();
      return;
    }
    if (_standingsTimer) return; // already scheduled — latest payload will be used
    const sinceLast = Date.now() - _standingsLastEmit;
    const wait = Math.max(0, delay - sinceLast);
    _standingsTimer = setTimeout(flushStandings, wait);
  },

  get io() {
    return io;
  },

  // True if at least one localhost client is currently on a race live page.
  hasLocalLiveViewer() {
    return localLiveViewers > 0;
  },
};
