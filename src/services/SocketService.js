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

module.exports = {
  init(httpServer) {
    io = new Server(httpServer, { cors: { origin: '*' } });

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
      });
    });
  },

  emit(event, data) {
    if (io) io.emit(event, data);
  },

  get io() {
    return io;
  },

  // True if at least one localhost client is currently on a race live page.
  hasLocalLiveViewer() {
    return localLiveViewers > 0;
  },
};
