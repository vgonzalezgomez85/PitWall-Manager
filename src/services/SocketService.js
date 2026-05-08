const { Server } = require('socket.io');

let io = null;

module.exports = {
  init(httpServer) {
    io = new Server(httpServer, { cors: { origin: '*' } });

    io.on('connection', (socket) => {
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
    });
  },

  emit(event, data) {
    if (io) io.emit(event, data);
  },

  get io() {
    return io;
  }
};
