const fs           = require('fs');
const path         = require('path');
const { performance } = require('perf_hooks');
const EventEmitter = require('events');
const Settings     = require('../models/Settings');

// Fixed offset so performance.now() (relative) maps to epoch ms (float, ~0.01ms precision)
const _PERF_OFFSET = Date.now() - performance.now();

const REPLAY_FILE = path.join(__dirname, '../data/RegistroCarrera.txt');

// DS-300 protocol: frame-based at 56000 baud
//
// Each crossing event = 1 frame of ~19 bytes.
// Frame boundaries are detected by silence gaps > FRAME_GAP_MS between bytes.
// Lane identity is encoded in byte index 10 (0-based) using a non-sequential bitmask.

const FRAME_GAP_MS    = 75;    // gap > 75ms between bytes → new frame starts
const MIN_CROSSING_MS = 500;   // minimum ms between two crossings on the same lane
const MAX_LAP_MS      = 240000; // elapsed > 240s → car stopped; reset ref, skip recording

// DS-300 lap time is encoded in bytes 14-17 (0-based) as decimal-in-hex:
//   byte14 = minutes, byte15 = seconds, byte16 = hundredths, byte17 = ten-thousandths
//   e.g. 0x13 → read hex digits as decimal → 13 seconds
//   If any nibble is A-F → first crossing (no previous reference), no valid time.
function ds300Byte(b) {
  return ((b >> 4) <= 9 && (b & 0xF) <= 9) ? parseInt(b.toString(16), 10) : null;
}

function readLapTimeMs(frame) {
  if (frame.length < 18) return null;
  const mins  = ds300Byte(frame[14]);
  const secs  = ds300Byte(frame[15]);
  const cents = ds300Byte(frame[16]); // centésimas → × 10 ms
  const dmils = ds300Byte(frame[17]); // diezmilésimas → × 0.1 ms
  if (mins === null || secs === null || cents === null || dmils === null) return null;
  return mins * 60000 + secs * 1000 + cents * 10 + dmils * 0.1;
}

// DS-300 frame: lane identity is encoded in byte index 10 (0-based).
// Non-sequential bitmask — order matters.
const LANE_MAP = [
  [0x80, 1], [0x40, 2], [0x20, 3], [0x10, 4],
  [0x08, 5], [0x04, 6], [0x02, 7], [0x01, 8],
];

// ── Per-circuit connection ────────────────────────────────────────────────────
class CircuitConnection {
  constructor(circuitIndex, laneOffset, onCrossing, onGo, onStop, onPause, onResume, onGoSignal, onFinish) {
    this._circuitIndex  = circuitIndex;
    this._laneOffset    = laneOffset;
    this._onCrossing    = onCrossing;
    this._onGo          = onGo;
    this._onStop        = onStop;
    this._onPause       = onPause;
    this._onResume      = onResume;
    this._onGoSignal    = onGoSignal;
    this._onFinish      = onFinish;
    this._port          = null;
    this._rawLog        = [];
    this._frameBuf      = [];
    this._frameStartTs  = null;
    this._lastByteTs    = null;
    this._flushTimer    = null;
    this._raceState     = null;
  }

  async connect(portPath, baudRate = 56000) {
    const { SerialPort } = require('serialport');
    if (this._port) await new Promise(r => this._port.close(r));
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._frameBuf     = [];
    this._frameStartTs = null;
    this._lastByteTs   = null;

    // macOS pseudo-terminals reject non-standard baud rates (IOSSIOSPEED).
    // Fall back to 57600 for virtual ports — the actual rate is irrelevant there.
    const rates = baudRate !== 57600 ? [baudRate, 57600] : [57600];
    let openedAt = baudRate;
    for (const rate of rates) {
      const p = new SerialPort({ path: portPath, baudRate: rate, autoOpen: false });
      const err = await new Promise(r => p.open(e => r(e)));
      if (!err) { this._port = p; openedAt = rate; break; }
      console.warn(`[DS-300 C${this._circuitIndex + 1}] ${portPath} @ ${rate} failed: ${err.message}`);
      if (rate === rates[rates.length - 1]) throw err;
    }

    this._port.on('data', chunk => this._onData(chunk));
    this._port.on('error', err => {
      console.error(`[DS-300 C${this._circuitIndex + 1}] Port error:`, err.message);
      if (process.platform === 'linux' && err.message.includes('Permission denied')) {
        console.error('[DS-300] Linux: sudo usermod -a -G dialout $USER  then log out/in');
      }
    });

    console.log(`[DS-300 C${this._circuitIndex + 1}] Connected to ${portPath} @ ${openedAt} baud (lane offset: ${this._laneOffset})`);
  }

  async close() {
    if (!this._port) return;
    await new Promise(r => this._port.close(r));
    this._port = null;
  }

  get path()   { return this._port?.path ?? null; }
  get rawLog() { return [...this._rawLog]; }

  _onData(chunk) {
    const now = _PERF_OFFSET + performance.now(); // float ms, ~0.01ms precision

    for (const b of chunk) {
      this._rawLog.push({ byte: b, ts: now });
      if (this._rawLog.length > 200) this._rawLog.shift();
    }

    // Cancel any pending silence-flush — we just got more bytes
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }

    for (const byte of chunk) {
      const gap = this._lastByteTs !== null && (now - this._lastByteTs) > FRAME_GAP_MS;

      if (gap) {
        // Gap detected mid-chunk: flush whatever was buffered before this chunk
        if (this._frameBuf.length > 0) {
          this._processFrame(this._frameBuf, this._frameStartTs);
        }
        this._frameBuf     = [byte];
        this._frameStartTs = now;
      } else {
        if (this._frameBuf.length === 0) this._frameStartTs = now;
        this._frameBuf.push(byte);
      }

      this._lastByteTs = now;
    }

    // Flush the frame after FRAME_GAP_MS of silence — don't wait for the next frame
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._frameBuf.length > 0) {
        this._processFrame(this._frameBuf, this._frameStartTs);
        this._frameBuf     = [];
        this._frameStartTs = null;
      }
    }, FRAME_GAP_MS + 5);
  }

  _setRaceState(newState) {
    if (newState === this._raceState) return;
    this._raceState = newState;
    console.log(`[DS-300 C${this._circuitIndex + 1}] Race state → ${newState}`);
    if      (newState === 'running')  this._onGo();
    else if (newState === 'resumed')  this._onResume();
    else if (newState === 'paused')   this._onPause();
    else if (newState === 'stopped')  this._onStop();
    else if (newState === 'finished') this._onFinish();
  }

  _processFrame(frame, ts) {
    if (frame.length < 2) return;

    const laneByte = frame.length >= 11 ? frame[10] : 0;

    // ── Real DS-300 GO sequence (3 frames, deltas +2500ms / +2953ms from t1):
    //    Trama 1: byte7=0x3E byte8=0xA1 byte10=BCD(durationMins)  → store duration, latch pending start
    //    Trama 2: byte7=0x00 byte8=0xA2                            → semaphore step 2 (intermediate)
    //    Trama 3: byte7=0x00 byte8=0xA3                            → current ON, race starts (countdown)
    if (frame.length >= 11 && frame[7] === 0x3e && frame[8] === 0xa1) {
      const mins = ds300Byte(frame[10]) ?? 0;
      this._onGoSignal(mins * 60000);
      this._pendingGoStart = true;
      if (this._goFallbackTimer) clearTimeout(this._goFallbackTimer);
      // Fallback: if trama 3 never arrives, start race anyway after 5s
      this._goFallbackTimer = setTimeout(() => {
        if (this._pendingGoStart) {
          this._pendingGoStart = false;
          this._setRaceState('running');
        }
      }, 5000);
      return;
    }

    if (this._pendingGoStart && frame.length >= 9 && frame[7] === 0x00 && frame[8] === 0xa3) {
      this._pendingGoStart = false;
      if (this._goFallbackTimer) { clearTimeout(this._goFallbackTimer); this._goFallbackTimer = null; }
      this._setRaceState('running');
      return;
    }

    // Trama 2 (0xA2) is consumed silently — only relevant for hardware-driven LED panels
    if (this._pendingGoStart && frame.length >= 9 && frame[7] === 0x00 && frame[8] === 0xa2) {
      return;
    }

    // ── Control frame (no lane crossing) ──────────────────────────────────────
    if (!laneByte) {
      // Forced stop: byte8=0xa7
      if (frame[8] === 0xa7) {
        this._setRaceState('stopped');
        return;
      }
      // Normal end (time expired): byte8=0xa4
      if (frame[8] === 0xa4) {
        this._setRaceState('finished');
        return;
      }
      const stateByte = frame[1];
      if      (stateByte === 0x06) this._setRaceState('running');
      else if (stateByte === 0x0f) this._setRaceState('resumed');
      else if (stateByte === 0x0c) this._setRaceState('paused');
      else if (stateByte === 0x08) this._setRaceState('stopped');
      return;
    }

    // ── Lane crossing ──────────────────────────────────────────────────────────
    // Read lap time directly from DS-300 frame bytes 14-17.
    // null → first crossing (bytes contain non-decimal nibbles, no previous reference).
    const lapTimeMs = readLapTimeMs(frame);

    for (const [mask, localLane] of LANE_MAP) {
      if (!(laneByte & mask)) continue;

      const globalLane = localLane + this._laneOffset;

      if (lapTimeMs === null) {
        console.log(`[DS-300 C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — first crossing`);
        this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs: null });
        continue;
      }

      if (lapTimeMs < MIN_CROSSING_MS || lapTimeMs > MAX_LAP_MS) continue;

      console.log(`[DS-300 C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — ${lapTimeMs.toFixed(1)}ms`);
      this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs });
    }
  }
}

// ── Main service ──────────────────────────────────────────────────────────────
class SerialServiceClass extends EventEmitter {
  constructor() {
    super();
    this._connections = [];
    this._simRunning  = false;
    this._simTimers   = new Map();
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
      const baudRate = parseInt(Settings.get('serial_baud', '56000'), 10);
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
      const { port, baud = 56000, lanes = 8 } = circuitConfigs[i];
      const conn = new CircuitConnection(
        i,
        laneOffset,
        data => this.emit('lane_crossing', data),
        ()   => this.emit('race_started'),
        ()   => this.emit('race_stopped'),
        ()   => this.emit('race_paused'),
        ()   => this.emit('race_resumed'),
        ms   => this.emit('race_go', { durationMs: ms }),
        ()   => this.emit('race_finished'),
      );
      await conn.connect(port, baud);
      connections.push(conn);
      laneOffset += lanes;
    }

    this._connections = connections;
  }

  async connectSerial(portPath, baudRate = 56000) {
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
    if (fs.existsSync(REPLAY_FILE)) {
      this.startFileReplay(REPLAY_FILE);
      return;
    }
    const lanes = parseInt(Settings.get('sim_lanes',   '6'),    10);
    const avgMs = parseInt(Settings.get('sim_avg_ms', '12000'), 10);
    this.startSimulation(lanes, avgMs);
  }

  _parseReplayFile(content) {
    const lineRe = /^(\d+):(\d+):(\d+)\.(\d+)\s+((?:[0-9A-Fa-f]{2}\s*)+)/;
    let prevRawMs = -1;
    let offset    = 0;
    const events  = [];

    for (const raw of content.split('\n')) {
      const m = raw.match(lineRe);
      if (!m) continue;

      const bytes = m[5].trim().split(/\s+/).map(h => parseInt(h, 16));
      if (bytes.length < 11) continue;
      const laneByte = bytes[10];
      if (!laneByte) continue;

      // Find which lane(s) crossed
      const lanes = [];
      for (const [mask, lane] of LANE_MAP) {
        if (laneByte & mask) lanes.push(lane);
      }
      if (lanes.length === 0) continue;

      // Support up to 4 decimal places (diezmilésimas); pad/truncate to 4 digits
      const frac4 = m[4].padEnd(4, '0').slice(0, 4);
      const rawMs = parseInt(m[1]) * 3600000
                  + parseInt(m[2]) * 60000
                  + parseInt(m[3]) * 1000
                  + parseInt(frac4) * 0.1;

      // Midnight wraparound: if timestamp goes back by more than 1 hour
      if (prevRawMs >= 0 && rawMs < prevRawMs - 3600000) offset += 86400000;
      prevRawMs = rawMs;

      const absMs = rawMs + offset;
      for (const lane of lanes) events.push({ absMs, lane });
    }

    events.sort((a, b) => a.absMs - b.absMs);
    return events;
  }

  startFileReplay(filePath) {
    this.stopSimulation();
    this._simRunning = true;

    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { return this.startSimulation(); }

    const events = this._parseReplayFile(content);
    if (events.length === 0) return this.startSimulation();

    // Build per-lane lap-time arrays from the parsed events
    const laneEvents = new Map();
    for (const ev of events) {
      if (!laneEvents.has(ev.lane)) laneEvents.set(ev.lane, []);
      laneEvents.get(ev.lane).push(ev.absMs);
    }

    const laneLaps = new Map();
    for (const [lane, times] of laneEvents) {
      const laps = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d >= 500 && d <= 120000) laps.push(d);
      }
      if (laps.length > 0) laneLaps.set(lane, laps);
    }

    const lanesFound = [...laneLaps.keys()];
    console.log(`[SerialService] File replay — ${lanesFound.length} lanes, ${events.length} events from ${filePath}`);

    for (const lane of lanesFound) {
      const laps = laneLaps.get(lane);
      const stagger = Math.random() * (laps[0] || 12000);
      const t = setTimeout(() => this._replayLap(lane, laps, 0), stagger);
      this._simTimers.set(lane, t);
    }
  }

  _replayLap(lane, laps, idx) {
    if (!this._simRunning) return;
    const lapTimeMs = laps[idx];
    this.emit('lane_crossing', { lane, timestamp: Date.now(), lapTimeMs });
    const next = (idx + 1) % laps.length;
    const t = setTimeout(() => this._replayLap(lane, laps, next), lapTimeMs);
    this._simTimers.set(lane, t);
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
    return this._connections.flatMap(c => c.rawLog)
      .sort((a, b) => a.ts - b.ts)
      .slice(-40);
  }

  get isSimulating()   { return this._simRunning; }
  get connectedPort()  { return this._connections[0]?.path ?? null; }
  get connectedPorts() { return this._connections.map(c => c.path).filter(Boolean); }
}

module.exports = new SerialServiceClass();
