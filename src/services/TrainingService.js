const SerialService = require('./SerialService');
const SocketService = require('./SocketService');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

class TrainingServiceClass {
  constructor() {
    this._active    = false;
    this._lanes     = [];
    this._laneData  = new Map();
    this._handler   = null;
    this._startedAt = null;
  }

  get isActive()  { return this._active; }
  get startedAt() { return this._startedAt; }

  start(lanesCount) {
    if (this._active) this.stop();

    this._active    = true;
    this._startedAt = Date.now();
    this._lanes     = [];
    this._laneData  = new Map();

    for (let i = 1; i <= lanesCount; i++) {
      this._lanes.push(i);
      this._laneData.set(i, { laps: [], sum: 0, count: 0 });
    }

    this._handler = ({ lane, lapTimeMs }) => {
      if (!this._active || lapTimeMs == null) return;
      const ld = this._laneData.get(lane);
      if (!ld) return;

      ld.count++;
      ld.sum += lapTimeMs;
      ld.laps.push(lapTimeMs);
      ld.laps.sort((a, b) => a - b);

      SocketService.emit('training:lap', {
        lane,
        color:    LANE_COLORS[lane - 1] || '#8b949e',
        lapTimeMs,
        count:  ld.count,
        avgMs:  Math.round(ld.sum / ld.count),
        bestMs: ld.laps[0],
        laps:   [...ld.laps],
      });
    };

    SerialService.on('lane_crossing', this._handler);
    console.log(`[TrainingService] Started — ${lanesCount} lanes`);
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    if (this._handler) {
      SerialService.off('lane_crossing', this._handler);
      this._handler = null;
    }
    SocketService.emit('training:stopped');
    console.log('[TrainingService] Stopped');
  }

  getLanes() {
    return this._lanes.map(lane => {
      const ld = this._laneData.get(lane) || { laps: [], sum: 0, count: 0 };
      return {
        lane,
        color:  LANE_COLORS[lane - 1] || '#8b949e',
        count:  ld.count,
        avgMs:  ld.count > 0 ? Math.round(ld.sum / ld.count) : null,
        bestMs: ld.laps.length > 0 ? ld.laps[0] : null,
        laps:   [...ld.laps],
      };
    });
  }
}

module.exports = new TrainingServiceClass();
