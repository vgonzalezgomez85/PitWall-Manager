const EventEmitter = require('events');
const Settings = require('../models/Settings');

// ── DS-300 protocol constants ─────────────────────────────────────────────────
const FRAME_LEN   = 21;
const FRAME_START = 0xE0;
const FRAME_END   = 0xEB;
const CMD_LAP     = 0xA9;
const CMD_GO      = 0xA1;
const CMD_STOP    = 0xA7;

function bcd(byte) {
  return ((byte >> 4) & 0x0F) * 10 + (byte & 0x0F);
}

function laneFromMask(mask) {
  for (let bit = 7; bit >= 0; bit--) {
    if (mask & (1 << bit)) return 8 - bit;
  }
  return null;
}

function parseLapTimeMs(b14, b15, b16, b17) {
  if (b14 === 0xAA || b15 === 0xAB) return null;
  const mins   = bcd(b14);
  const secs   = bcd(b15);
  const centis = bcd(b16);
  return mins * 60000 + secs * 1000 + centis * 10;
}

function checksumOk(frame) {
  let sum = 0;
  for (let i = 1; i <= 17; i++) sum += frame[i];
  return (sum & 0xFF) === frame[18];
}

// ── Per-circuit connection state ──────────────────────────────────────────────
class CircuitConnection {
  constructor(circuitIndex, laneOffset, onCrossing, onGo, onStop) {
    this._circuitIndex = circuitIndex;
    this._laneOffset   = laneOffset;   // global lane = ds300Lane + laneOffset
    this._onCrossing   = onCrossing;
    this._onGo         = onGo;
    this._onStop       = onStop;
    this._port         = null;
    this._buf          = Buffer.alloc(0);
    this._rawLog       = [];
  }

  async connect(portPath, baudRate = 4800) {
    const { SerialPort } = require('serialport');
    if (this._port) await new Promise(r => this._port.close(r));
    this._buf = Buffer.alloc(0);

    this._port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    await new Promise((resolve, reject) => {
      this._port.open(err => err ? reject(err) : resolve());
    });

    this._port.on('data', chunk => this._onData(chunk));
    this._port.on('error', err => {
      console.error(`[DS-300 C${this._circuitIndex + 1}] Port error:`, err.message);
      if (process.platform === 'linux' && err.message.includes('Permission denied')) {
        console.error(`[DS-300] Linux: add your user to the dialout group and restart:\n  sudo usermod -a -G dialout $USER`);
      }
    });

    console.log(`[DS-300 C${this._circuitIndex + 1}] Connected to ${portPath} @ ${baudRate} baud (lane offset: ${this._laneOffset})`);
  }

  async close() {
    if (!this._port) return;
    await new Promise(r => this._port.close(r));
    this._port = null;
  }

  get path()    { return this._port?.path ?? null; }
  get rawLog()  { return [...this._rawLog]; }

  _onData(chunk) {
    for (const b of chunk) {
      this._rawLog.push({ byte: b, ts: Date.now() });
      if (this._rawLog.length > 200) this._rawLog.shift();
    }
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= FRAME_LEN) {
      const start = this._buf.indexOf(FRAME_START);
      if (start < 0) { this._buf = Buffer.alloc(0); break; }
      if (start > 0) { this._buf = this._buf.slice(start); continue; }
      if (this._buf.length < FRAME_LEN) break;

      const frame = this._buf.slice(0, FRAME_LEN);
      if (frame[FRAME_LEN - 1] !== FRAME_END) { this._buf = this._buf.slice(1); continue; }
      if (!checksumOk(frame)) {
        console.warn(`[DS-300 C${this._circuitIndex + 1}] Checksum failed`);
        this._buf = this._buf.slice(FRAME_LEN);
        continue;
      }

      this._parseFrame(frame);
      this._buf = this._buf.slice(FRAME_LEN);
    }

    if (this._buf.length > FRAME_LEN * 4) {
      this._buf = this._buf.slice(this._buf.length - FRAME_LEN * 2);
    }
  }

  _parseFrame(frame) {
    const cmd  = frame[8];
    const type = frame[7];
    const now  = Date.now();

    if (cmd === CMD_LAP && type === 0x1B) {
      const localLane  = laneFromMask(frame[10]);
      if (localLane === null) return;
      const globalLane = localLane + this._laneOffset;
      const lapTimeMs  = parseLapTimeMs(frame[14], frame[15], frame[16], frame[17]);
      const lapNumber  = frame[12];

      console.log(`[DS-300 C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — ${lapTimeMs != null ? lapTimeMs + 'ms' : 'first crossing'}`);
      this._onCrossing({ lane: globalLane, timestamp: now, lapTimeMs, lapNumber, circuit: this._circuitIndex + 1 });
    }

    if (cmd === CMD_GO)  { console.log(`[DS-300 C${this._circuitIndex + 1}] GO`);   this._onGo(); }
    if (cmd === CMD_STOP){ console.log(`[DS-300 C${this._circuitIndex + 1}] STOP`); this._onStop(); }
  }
}

// ── Main service ──────────────────────────────────────────────────────────────
class SerialServiceClass extends EventEmitter {
  constructor() {
    super();
    this._connections  = [];   // CircuitConnection[]
    this._simRunning   = false;
    this._simTimers    = new Map();
  }

  // ── Startup ──────────────────────────────────────────────────────────────

  init() {
    const mode = Settings.get('serial_mode', 'simulation');
    if (mode === 'serial') {
      const circuitsJson = Settings.get('circuits_serial', '[]');
      let circuits = [];
      try { circuits = JSON.parse(circuitsJson); } catch {}

      if (circuits.length > 0) {
        this.connectMultiple(circuits).catch(err => {
          console.warn('[SerialService] Could not open ports, falling back to simulation:', err.message);
          if (process.platform === 'linux' && err.message.includes('Permission denied')) {
            console.warn('[SerialService] Linux tip: sudo usermod -a -G dialout $USER  (then log out and back in)');
          }
          if (process.platform === 'win32' && err.message.includes('Access denied')) {
            console.warn('[SerialService] Windows tip: check that no other program (e.g. Arduino IDE) is using the COM port.');
          }
          this._startSim();
        });
        return;
      }

      // Legacy single-port config
      const portPath = Settings.get('serial_port', '');
      const baudRate = parseInt(Settings.get('serial_baud', '4800'), 10);
      if (portPath) {
        this.connectMultiple([{ port: portPath, baud: baudRate, lanes: 8 }]).catch(() => this._startSim());
        return;
      }
    }
    this._startSim();
  }

  // ── Connect multiple DS-300s ──────────────────────────────────────────────

  async connectMultiple(circuitConfigs) {
    await this.closeAll();
    this.stopSimulation();

    let laneOffset = 0;
    const connections = [];

    for (let i = 0; i < circuitConfigs.length; i++) {
      const { port, baud = 4800, lanes = 8 } = circuitConfigs[i];
      const conn = new CircuitConnection(
        i,
        laneOffset,
        data => this.emit('lane_crossing', data),
        ()   => this.emit('race_started'),
        ()   => this.emit('race_stopped'),
      );
      await conn.connect(port, baud);
      connections.push(conn);
      laneOffset += lanes;
    }

    this._connections = connections;
  }

  // Legacy single-port API (for backward compat)
  async connectSerial(portPath, baudRate = 4800) {
    await this.connectMultiple([{ port: portPath, baud: baudRate, lanes: 8 }]);
  }

  async closeAll() {
    for (const conn of this._connections) {
      await conn.close().catch(() => {});
    }
    this._connections = [];
  }

  async closeSerial() { await this.closeAll(); }

  // ── Simulation ───────────────────────────────────────────────────────────

  _startSim() {
    const lanes  = parseInt(Settings.get('sim_lanes',   '6'),   10);
    const avgMs  = parseInt(Settings.get('sim_avg_ms', '12000'), 10);
    this.startSimulation(lanes, avgMs);
  }

  startSimulation(lanesCount = 6, avgLapMs = 12000) {
    this.stopSimulation();
    this._simRunning = true;
    for (let lane = 1; lane <= lanesCount; lane++) {
      const stagger = Math.random() * avgLapMs;
      const t = setTimeout(() => this._simLap(lane, avgLapMs), stagger);
      this._simTimers.set(lane, t);
    }
    console.log(`[SerialService] Simulation started — ${lanesCount} lanes, ~${avgLapMs}ms avg lap`);
  }

  _simLap(lane, avgLapMs) {
    if (!this._simRunning) return;
    const variation = avgLapMs * 0.2;
    const lapTimeMs = Math.round(avgLapMs + (Math.random() * variation * 2 - variation));
    this.emit('lane_crossing', { lane, timestamp: Date.now(), lapTimeMs });
    const t = setTimeout(() => this._simLap(lane, avgLapMs), lapTimeMs);
    this._simTimers.set(lane, t);
  }

  stopSimulation() {
    this._simRunning = false;
    this._simTimers.forEach(t => clearTimeout(t));
    this._simTimers.clear();
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  async listPorts() {
    try {
      const { SerialPort } = require('serialport');
      return SerialPort.list();
    } catch { return []; }
  }

  getRawLog() {
    // Merge raw logs from all connections
    return this._connections.flatMap(c => c.rawLog)
      .sort((a, b) => a.ts - b.ts)
      .slice(-40);
  }

  get isSimulating()   { return this._simRunning; }
  get connectedPort()  { return this._connections[0]?.path ?? null; }
  get connectedPorts() { return this._connections.map(c => c.path).filter(Boolean); }
}

module.exports = new SerialServiceClass();
