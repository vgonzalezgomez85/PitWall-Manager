const fs           = require('fs');
const path         = require('path');
const { performance } = require('perf_hooks');
const EventEmitter = require('events');
const Settings     = require('../models/Settings');
const DebugLogger  = require('./DebugLogger');

// Fixed offset so performance.now() (relative) maps to epoch ms (float, ~0.01ms precision)
const _PERF_OFFSET = Date.now() - performance.now();

const REPLAY_FILE = path.join(__dirname, '../data/RegistroCarrera.txt');

// DS-300 protocol: frame-based — baud rate configured per circuit in DB (Settings)
//
// Each crossing event = 1 frame of ~19 bytes.
// Frame boundaries are detected by silence gaps > FRAME_GAP_MS between bytes.
// Lane identity is encoded in byte index 10 (0-based) using a non-sequential bitmask.

// FRAME_GAP_MS can be overridden via Settings ("serial_frame_gap_ms") so the
// operator can tune the parser without redeploying — useful when a particular
// DS-300 unit emits frames with different timing.
const FRAME_GAP_MS_DEFAULT = 75;
let   FRAME_GAP_MS         = FRAME_GAP_MS_DEFAULT;
const DS_FRAME_LEN = 21;       // un frame DS-300 = 21 bytes fijos (0xe0 … 0xeb)
const MIN_CROSSING_MS = 500;   // minimum ms between two crossings on the same lane
const MAX_LAP_MS      = 240000; // elapsed > 240s → car stopped; reset ref, skip recording

// DS-300 emits a heartbeat frame every 60s while a manga is running (byte7=0x00 byte8=0xC0).
// If we don't see one for HEARTBEAT_TIMEOUT_MS, the DS is probably unplugged or off.
const HEARTBEAT_TIMEOUT_MS = 75000;

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
  constructor(circuitIndex, laneOffset, onCrossing, onGo, onStop, onPause, onResume, onGoSignal, onFinish, onResumeSignal, onSemaphoreStep) {
    this._circuitIndex     = circuitIndex;
    this._laneOffset       = laneOffset;
    this._onCrossing       = onCrossing;
    this._onGo             = onGo;
    this._onStop           = onStop;
    this._onPause          = onPause;
    this._onResume         = onResume;
    this._onGoSignal       = onGoSignal;
    this._onFinish         = onFinish;
    this._onResumeSignal   = onResumeSignal || (() => {});
    this._onSemaphoreStep  = onSemaphoreStep || (() => {});
    this._port          = null;
    this._rawLog        = [];
    this._frameBuf      = [];
    this._frameStartTs  = null;
    this._lastByteTs    = null;
    this._flushTimer    = null;
    this._raceState     = null;
    this._watchdogTimer = null;
    this._connected     = true;   // optimistic until we have reason to think otherwise
    this._lastHeartbeatTs = null;
    // Last DS-300 lap counter (B12) seen per local lane. Used to detect missed
    // crossings when the serial link drops temporarily: if the next frame for
    // the lane jumps from N to N+k (k>1), the gap is emitted as k-1 phantom
    // crossings filled with the lane's average lap time so the totals stay
    // consistent and the averages aren't skewed by null values.
    this._lastLapByLane = new Map();
    // Running stats of REAL lap times per lane (sum + count), used to estimate
    // phantom lap times. Phantom laps never feed back into these stats.
    this._lapStatsByLane = new Map();

    // ── Auto-reconnect state ────────────────────────────────────────────────
    this._lastConfig     = null;   // { portPath, baudRate, opts } saved en cada connect()
    this._reconnectTimer = null;
    this._reconnectMs    = 1500;   // delay actual; sube con backoff hasta MAX
    this._explicitClose  = false;  // true cuando el usuario llama close() — desactiva retry
  }

  async connect(portPath, baudRate, opts = {}) {
    if (!baudRate) throw new Error('baudRate required (configure in Settings)');
    // Guardamos la última config para el reintento automático
    this._lastConfig    = { portPath, baudRate, opts };
    this._explicitClose = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }

    const dataBits    = opts.dataBits    || 8;
    const parity      = opts.parity      || 'none';
    const stopBits    = opts.stopBits    || 1;
    const flowControl = opts.flowControl || 'none';
    const rtscts = flowControl === 'rtscts';
    const xon    = flowControl === 'xonxoff';
    const xoff   = flowControl === 'xonxoff';

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
      // highWaterMark big enough to absorb USB bursts on macOS without dropping.
      const p = new SerialPort({
        path: portPath, baudRate: rate, autoOpen: false,
        dataBits, stopBits, parity,
        rtscts, xon, xoff,
        hupcl: false, lock: false,
        highWaterMark: 65536,
      });
      const err = await new Promise(r => p.open(e => r(e)));
      if (!err) { this._port = p; openedAt = rate; break; }
      console.warn(`[DS-300 C${this._circuitIndex + 1}] ${portPath} @ ${rate} failed: ${err.message}`);
      if (rate === rates[rates.length - 1]) throw err;
    }

    // macOS: best-effort to drop the FTDI/PL2303 latency timer so bytes arrive
    // sooner instead of being batched. No-op if the driver doesn't expose it.
    if (process.platform === 'darwin' && this._port.set) {
      try {
        // Pulse DTR to wake the line and force flush of any stale buffers
        await new Promise(r => this._port.set({ dtr: true, rts: false }, () => r()));
      } catch {}
    }

    this._port.on('data', chunk => this._onData(chunk));
    this._port.on('error', err => {
      console.error(`[DS-300 C${this._circuitIndex + 1}] Port error:`, err.message);
      if (process.platform === 'linux' && err.message.includes('Permission denied')) {
        console.error('[DS-300] Linux: sudo usermod -a -G dialout $USER  then log out/in');
      }
    });
    this._port.on('close', () => {
      console.warn(`[DS-300 C${this._circuitIndex + 1}] Port closed`);
      this._setConnected(false);
      this._scheduleReconnect();
    });

    console.log(`[DS-300 C${this._circuitIndex + 1}] Connected to ${portPath} @ ${openedAt} baud (lane offset: ${this._laneOffset})`);
    // Port opened successfully — mark link as up so the UI doesn't show
    // "Sin señal del DS-300" before any traffic has been exchanged.
    this._setConnected(true);
    // Reapertura exitosa: reseteamos el delay de backoff
    this._reconnectMs = 1500;
  }

  // ── Auto-reconnect ──────────────────────────────────────────────────────
  // Programa un reintento cuando el puerto se cierra de forma inesperada
  // (DS-300 desconectado físicamente, USB suspendido, etc.). Backoff lineal
  // 1.5 → 3 → 6 → 10s tope. Se desactiva si close() fue llamado por el usuario.
  _scheduleReconnect() {
    if (this._explicitClose) return;          // cierre voluntario: no reintentamos
    if (!this._lastConfig)   return;
    if (this._reconnectTimer) return;         // ya hay uno programado
    // Si ya hay un puerto vivo (p. ej. el close fue de un port anterior
    // descartado durante un reconnect en curso), no reintentamos
    if (this._port && this._port.isOpen) return;

    const RECONNECT_MAX_MS = 10000;
    const delay = this._reconnectMs;
    console.warn(`[DS-300 C${this._circuitIndex + 1}] Reintentando en ${delay}ms…`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._explicitClose || !this._lastConfig) return;
      if (this._port && this._port.isOpen) return;   // ya estamos conectados
      const { portPath, baudRate, opts } = this._lastConfig;
      try {
        await this.connect(portPath, baudRate, opts);
        console.log(`[DS-300 C${this._circuitIndex + 1}] Reconectado ✓`);
      } catch (err) {
        // Falló: subir backoff y reintentar
        console.warn(`[DS-300 C${this._circuitIndex + 1}] Reconexión falló: ${err.message}`);
        this._reconnectMs = Math.min(RECONNECT_MAX_MS, Math.round(this._reconnectMs * 2));
        this._scheduleReconnect();
      }
    }, delay);
  }

  async close() {
    // Cierre solicitado por el usuario: cancelamos cualquier reintento pendiente
    this._explicitClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._watchdogTimer)  { clearTimeout(this._watchdogTimer);  this._watchdogTimer  = null; }
    if (!this._port) return;
    await new Promise(r => this._port.close(r));
    this._port = null;
  }

  // Mark the link as alive and (re)arm the heartbeat watchdog.
  _pingAlive() {
    if (!this._connected) this._setConnected(true);
    if (this._watchdogTimer) clearTimeout(this._watchdogTimer);
    // Watchdog is kept for future use (could emit a separate "stale heartbeat"
    // warning), but it must NOT flip `_connected` to false: the link state
    // tracks the OS-level port, not whether the DS chose to send a frame in
    // the last N seconds. Idle mangas can legitimately be silent.
    this._watchdogTimer = setTimeout(() => {}, HEARTBEAT_TIMEOUT_MS);
  }

  _setConnected(connected) {
    if (this._connected === connected) return;
    this._connected = connected;
    console.log(`[DS-300 C${this._circuitIndex + 1}] Link → ${connected ? 'connected' : 'DISCONNECTED'}`);
    const SocketService = require('./SocketService');
    SocketService.emit('serial:status', {
      circuit:    this._circuitIndex + 1,
      connected,
      lastHeartbeatTs: this._lastHeartbeatTs,
    });
  }

  get path()   { return this._port?.path ?? null; }
  get rawLog() { return [...this._rawLog]; }

  // Snapshot del contador de vueltas del DS-300 (B12) por carril GLOBAL
  // (localLane + laneOffset). Es el nº de cruces que la caja ha contado en la
  // manga en curso (se resetea en el GO / 0xA1). La reconciliación de cierre de
  // manga lo compara con las vueltas persistidas para no perder el cruce que
  // llega "en la bandera" (el frame de fin de manga se procesa µs antes que el
  // último cruce y éste se descartaría por circuito ya 'finished').
  getLapCounters() {
    const out = {};
    for (const [localLane, counter] of this._lastLapByLane) {
      if (counter != null) out[localLane + this._laneOffset] = counter;
    }
    return out;
  }

  _onData(chunk) {
    const now = _PERF_OFFSET + performance.now(); // float ms, ~0.01ms precision

    for (const b of chunk) {
      this._rawLog.push({ byte: b, ts: now });
      if (this._rawLog.length > 50000) this._rawLog.shift();
    }
    if (process.env.SLOTIME_RAW_DUMP) {
      try {
        require('fs').appendFileSync(
          process.env.SLOTIME_RAW_DUMP,
          Array.from(chunk).map(b => b.toString(16).padStart(2,'0')).join(' ') + ` @${now.toFixed(2)}\n`
        );
      } catch {}
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
    const prev = this._raceState;
    this._raceState = newState;
    console.log(`[DS-300 C${this._circuitIndex + 1}] Race state → ${newState}`);
    DebugLogger.log('ds_state', { circuit: this._circuitIndex + 1, from: prev, to: newState });
    if      (newState === 'running')  this._onGo();
    else if (newState === 'resumed')  this._onResume();
    else if (newState === 'paused')   this._onPause();
    else if (newState === 'stopped')  this._onStop();
    else if (newState === 'finished') this._onFinish();
  }

  _processFrame(frame, ts) {
    if (frame.length < 2) return;

    // ── De-merge de ráfagas ─────────────────────────────────────────────────
    // El DS-300 emite frames de 21 bytes (0xe0 … 0xeb). Cuando varios carriles
    // cruzan casi a la vez (GO, pista corta) el DS los manda seguidos y, como
    // llegan a < FRAME_GAP_MS unos de otros, _onData los concatena en un solo
    // buffer. Antes solo se leía el PRIMER cruce y se perdía el resto (root
    // cause de la pérdida de vueltas). Aquí re-separamos el buffer en frames de
    // 21 bytes y procesamos cada uno. Solo si divide limpio en frames bien
    // formados; si no, lo tratamos como antes para no romper fragmentación.
    if (frame.length > DS_FRAME_LEN && frame.length % DS_FRAME_LEN === 0) {
      const n = frame.length / DS_FRAME_LEN;
      let wellFormed = true;
      for (let i = 0; i < n && wellFormed; i++) {
        const off = i * DS_FRAME_LEN;
        if (frame[off] !== 0xe0 || frame[off + DS_FRAME_LEN - 1] !== 0xeb) wellFormed = false;
      }
      if (wellFormed) {
        for (let i = 0; i < n; i++) {
          this._processFrame(frame.slice(i * DS_FRAME_LEN, (i + 1) * DS_FRAME_LEN), ts);
        }
        return;
      }
    }

    if (DebugLogger.isEnabled()) {
      const hex = Array.from(frame).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const b7 = frame[7], b8 = frame[8];
      DebugLogger.log('frame', { circuit: this._circuitIndex + 1, len: frame.length, hex, b7, b8, frame_ts: ts });
    }

    // Any well-formed frame means the DS is alive; refresh the watchdog.
    this._pingAlive();

    // ── Heartbeat frame (DS sends one every 60s while running) ────────────────
    // Signature: frame[7]=0x00, frame[8]=0xC0. Byte 14 = minute counter.
    if (frame.length >= 15 && frame[7] === 0x00 && frame[8] === 0xC0) {
      const minute = frame[14];
      this._lastHeartbeatTs = ts;
      console.log(`[DS-300 C${this._circuitIndex + 1}] ♥ heartbeat (min ${minute})`);
      const SocketService = require('./SocketService');
      SocketService.emit('serial:heartbeat', { circuit: this._circuitIndex + 1, minute, ts });
      return;
    }

    const laneByte = frame.length >= 11 ? frame[10] : 0;

    // ── Real DS-300 GO sequence (3 frames, deltas +2500ms / +2953ms from t1):
    //    Trama 1: byte7=0x3E byte8=0xA1 byte10=BCD(durationMins)  → store duration, latch pending start
    //    Trama 2: byte7=0x00 byte8=0xA2                            → semaphore step 2 (intermediate)
    //    Trama 3: byte7=0x00 byte8=0xA3                            → current ON, race starts (countdown)
    if (frame.length >= 11 && frame[7] === 0x3e && frame[8] === 0xa1) {
      const mins = ds300Byte(frame[10]) ?? 0;
      // New manga → reset per-lane lap counters and stats for gap detection.
      this._lastLapByLane.clear();
      this._lapStatsByLane.clear();
      // Reset cached race state so the next transition to 'running' actually
      // fires the callback. Some DS-300 units don't emit 0xA4/0xA7 between
      // mangas, so without this reset _raceState stays 'running' and the new
      // GO is silently ignored by _setRaceState's same-state short-circuit.
      this._raceState = null;
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

    // Trama 3 (0xA3) is shared by GO and Resume sequences. Whoever has a
    // pending latch (go or resume) gets resolved here; otherwise it's ignored.
    if (frame.length >= 9 && frame[7] === 0x00 && frame[8] === 0xa3) {
      if (this._pendingGoStart) {
        this._pendingGoStart = false;
        if (this._goFallbackTimer) { clearTimeout(this._goFallbackTimer); this._goFallbackTimer = null; }
        this._setRaceState('running');
        return;
      }
      if (this._pendingResumeStart) {
        this._pendingResumeStart = false;
        if (this._resumeFallbackTimer) { clearTimeout(this._resumeFallbackTimer); this._resumeFallbackTimer = null; }
        this._setRaceState('resumed');
        return;
      }
      return;
    }

    // Trama 2 (0xA2) is consumed silently for state machine, but used to drive
    // the on-screen semaphore in real time so it matches the physical DS lights.
    if ((this._pendingGoStart || this._pendingResumeStart) && frame.length >= 9 && frame[7] === 0x00 && frame[8] === 0xa2) {
      this._onSemaphoreStep();
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
      // Pause: single frame B8=0xA5 → state changes immediately.
      if (frame[8] === 0xa5) {
        this._setRaceState('paused');
        return;
      }
      // Resume: 3-frame sequence (0xA6 → 0xA2 → 0xA3), same shape as GO. Don't
      // flip state on 0xA6 — wait until trama 3 (0xA3) arrives so the resume
      // event coincides with the DS-300 actually unlocking the track current.
      // Fallback after 5s in case trama 3 never arrives. We also fire
      // _onResumeSignal so the UI can show a semaphore animation during the
      // ~3s wait (identical to the GO countdown).
      if (frame[8] === 0xa6) {
        this._pendingResumeStart = true;
        this._onResumeSignal();
        if (this._resumeFallbackTimer) clearTimeout(this._resumeFallbackTimer);
        this._resumeFallbackTimer = setTimeout(() => {
          if (this._pendingResumeStart) {
            this._pendingResumeStart = false;
            this._setRaceState('resumed');
          }
        }, 5000);
        return;
      }
      return;
    }

    // ── Lane crossing ──────────────────────────────────────────────────────────
    // Read lap time directly from DS-300 frame bytes 14-17.
    // null → first crossing (bytes contain non-decimal nibbles, no previous reference).
    const lapTimeMs = readLapTimeMs(frame);
    // B12 = lap counter (BCD). DS-300 increments it monotonically per lane within a manga.
    const lapCounter = ds300Byte(frame[12]);

    for (const [mask, localLane] of LANE_MAP) {
      if (!(laneByte & mask)) continue;

      const globalLane = localLane + this._laneOffset;

      // Reconciliation: if B12 jumped by more than 1 since the previous frame
      // for this lane (link was down, we missed crossings), emit the missing
      // laps as phantom crossings. Each phantom is filled with the lane's
      // average real lap time so totals stay consistent and averages aren't
      // distorted by null values.
      if (lapCounter !== null) {
        const prev = this._lastLapByLane.get(localLane);
        if (prev != null && lapCounter > prev + 1) {
          const missed = lapCounter - prev - 1;
          const stats  = this._lapStatsByLane.get(localLane);
          const avgMs  = (stats && stats.count > 0) ? (stats.sum / stats.count) : null;
          console.warn(`[DS-300 C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — gap detected (prev B12=${prev}, now B12=${lapCounter}, ${missed} laps missing, avg=${avgMs ? avgMs.toFixed(1) + 'ms' : 'n/a'})`);
          for (let k = 0; k < missed; k++) {
            this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs: avgMs, missed: true });
          }
        }
        this._lastLapByLane.set(localLane, lapCounter);
      }

      if (lapTimeMs === null) {
        console.log(`[DS-300 C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — first crossing`);
        this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs: null });
        continue;
      }

      if (lapTimeMs < MIN_CROSSING_MS || lapTimeMs > MAX_LAP_MS) continue;

      console.log(`[DS-300 C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — ${lapTimeMs.toFixed(1)}ms`);
      // Feed real lap times into the running stats so future phantom laps can
      // estimate a realistic value. Phantoms themselves are NOT fed back.
      const stats = this._lapStatsByLane.get(localLane) || { sum: 0, count: 0 };
      stats.sum += lapTimeMs;
      stats.count += 1;
      this._lapStatsByLane.set(localLane, stats);
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
    // Refresh tunable parser params from Settings on every (re)init.
    const fg = parseInt(Settings.get('serial_frame_gap_ms', String(FRAME_GAP_MS_DEFAULT)), 10);
    FRAME_GAP_MS = (Number.isFinite(fg) && fg >= 10 && fg <= 500) ? fg : FRAME_GAP_MS_DEFAULT;
    console.log(`[SerialService] FRAME_GAP_MS = ${FRAME_GAP_MS} ms`);

    const mode = Settings.get('serial_mode', 'simulation');
    // 'serial' (DS-300) y 'bart' (BLE vía puente) comparten ruta: ambos
    // conectan los circuitos de circuits_serial; el type de cada entrada
    // decide CircuitConnection vs BartConnection.
    if (mode === 'serial' || mode === 'bart') {
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
      const baudRate = parseInt(Settings.get('serial_baud', ''), 10);
      if (portPath && baudRate) {
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
      const cfg  = circuitConfigs[i];
      const type = cfg.type || 'ds300';
      // Callbacks idénticos para cualquier fuente: lo que cambia es de dónde
      // salen los cruces, no cómo se reemiten. Aguas abajo nadie nota la fuente.
      const source = type === 'bart' ? 'bart' : 'ds300';
      const callbacks = [
        i,
        laneOffset,
        data => { DebugLogger.log('crossing_raw', { source, circuit: i, ...data }); this.emit('lane_crossing', { circuit: i, ...data }); },
        ()   => this.emit('race_started',       { circuit: i }),
        ()   => this.emit('race_stopped',       { circuit: i }),
        ()   => this.emit('race_paused',        { circuit: i }),
        ()   => this.emit('race_resumed',       { circuit: i }),
        ms   => this.emit('race_go',            { circuit: i, durationMs: ms }),
        ()   => this.emit('race_finished',      { circuit: i }),
        ()   => this.emit('race_resume_signal', { circuit: i }),
        ()   => this.emit('semaphore_step',     { circuit: i }),
      ];

      let conn, lanes;
      if (type === 'bart') {
        // Circuito BART: { type:'bart', host, port, lanes, lanesPerDevice?, minlap?, start? }
        // `lanes` = TOTAL de carriles que expone este Master (Master + Slaves):
        //   1 equipo solo → 4 · Master + 1 Slave → 8 · … · Master + 7 Slaves → 32.
        // `lanesPerDevice` = carriles por dispositivo físico (4 típico, 2 en equipos
        //   de 2 carriles); debe coincidir con cómo el hardware reparte device_id.
        const BartConnection = require('./bart/BartConnection');
        lanes = cfg.lanes || 4;
        conn  = new BartConnection(...callbacks);
        // BART va por TCP con reconexión propia: si el puente/emulador aún no
        // está arriba, NO tiramos a simulación — la conexión reintenta sola y se
        // engancha cuando aparezca. (El DS-300 sí propaga el fallo: puerto serie
        // ausente es un error de config.)
        try {
          await conn.connect(cfg.host || '127.0.0.1', cfg.port || 9300, { transport: cfg.transport || 'tcp', name: cfg.name, minlap: cfg.minlap, start: cfg.start, lanesPerDevice: cfg.lanesPerDevice || 4 });
        } catch (e) {
          console.warn(`[SerialService] BART C${i + 1}: ${e.message} — reintentando en segundo plano`);
        }
      } else {
        // Circuito DS-300: { port, baud, lanes, dataBits, ... }
        if (!cfg.baud) throw new Error(`Circuit ${i + 1}: baud rate missing in DB config`);
        lanes = cfg.lanes || 8;
        conn  = new CircuitConnection(...callbacks);
        await conn.connect(cfg.port, cfg.baud, { dataBits: cfg.dataBits, parity: cfg.parity, stopBits: cfg.stopBits, flowControl: cfg.flowControl });
      }
      connections.push(conn);
      laneOffset += lanes;
    }

    this._connections = connections;
    this._broadcastLinkStatus();
  }

  async connectSerial(portPath, baudRate) {
    if (!baudRate) throw new Error('baudRate required (configure in Settings)');
    await this.connectMultiple([{ port: portPath, baud: baudRate, lanes: 8 }]);
  }

  async closeAll() {
    for (const conn of this._connections) {
      await conn.close().catch(() => {});
    }
    this._connections = [];
    this._broadcastLinkStatus();
  }

  // ── Modo simulación: circuitos virtuales alimentados con tramas ───────────
  // No abren puerto serie; se les inyectan tramas con feedFrame() y reemiten los
  // mismos eventos (lane_crossing, race_go, race_finished…) que un DS-300 real,
  // así el resto del pipeline (TimingService, sockets) no nota la diferencia.
  async startSimMode(circuits) {
    await this.closeAll();
    this.stopSimulation();
    let laneOffset = 0;
    const connections = [];
    for (let i = 0; i < circuits.length; i++) {
      const callbacks = [
        i, laneOffset,
        data => this.emit('lane_crossing', { circuit: i, ...data }),
        ()   => this.emit('race_started',       { circuit: i }),
        ()   => this.emit('race_stopped',       { circuit: i }),
        ()   => this.emit('race_paused',        { circuit: i }),
        ()   => this.emit('race_resumed',       { circuit: i }),
        ms   => this.emit('race_go',            { circuit: i, durationMs: ms }),
        ()   => this.emit('race_finished',      { circuit: i }),
        ()   => this.emit('race_resume_signal', { circuit: i }),
        ()   => this.emit('semaphore_step',     { circuit: i }),
      ];
      connections.push(new CircuitConnection(...callbacks));
      laneOffset += (circuits[i].lanes || 8);
    }
    this._connections = connections;
    this._simReplay = true;
    this._broadcastLinkStatus();
    console.log(`[SerialService] Modo simulación: ${connections.length} circuitos virtuales.`);
  }

  // Inyecta una trama (array/Buffer de 21 bytes) en el circuito indicado (0..N).
  feedFrame(circuitIdx, bytes) {
    const conn = this._connections[circuitIdx];
    if (conn && typeof conn._processFrame === 'function') {
      try { conn._processFrame(Buffer.from(bytes), Date.now()); } catch (e) {}
    }
  }

  async stopSimMode() {
    this._simReplay = false;
    await this.closeAll();
  }

  _broadcastLinkStatus() {
    try {
      const SocketService = require('./SocketService');
      SocketService.emit('serial:status', this.getLinkStatus());
    } catch {}
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
    this._broadcastLinkStatus();

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
    DebugLogger.log('crossing_raw', { source: 'replay', lane, timestamp: Date.now(), lapTimeMs });
    this.emit('lane_crossing', { lane, timestamp: Date.now(), lapTimeMs });
    const next = (idx + 1) % laps.length;
    const t = setTimeout(() => this._replayLap(lane, laps, next), lapTimeMs);
    this._simTimers.set(lane, t);
  }

  startSimulation(lanesCount = 6, avgLapMs = 12000) {
    this.stopSimulation();
    this._simRunning = true;
    this._broadcastLinkStatus();
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
    DebugLogger.log('crossing_raw', { source: 'sim', lane, timestamp: Date.now(), lapTimeMs });
    this.emit('lane_crossing', { lane, timestamp: Date.now(), lapTimeMs });
    const t = setTimeout(() => this._simLap(lane, avgLapMs), lapTimeMs);
    this._simTimers.set(lane, t);
  }

  stopSimulation() {
    const was = this._simRunning;
    this._simRunning = false;
    this._simTimers.forEach(t => clearTimeout(t));
    this._simTimers.clear();
    if (was) this._broadcastLinkStatus();
  }

  // ── Comandos de salida hacia el hardware (inversión de control) ───────────
  // Solo aplican a fuentes que SlotTime pilota (BART). En el DS-300 manda la
  // caja, así que estas conexiones no exponen estos métodos → no-op. Si no se
  // pasa `circuit`, el comando va a TODAS las conexiones que lo soporten.
  _sendToCircuits(method, circuit) {
    const targets = (circuit == null)
      ? this._connections
      : [this._connections[circuit]].filter(Boolean);
    for (const c of targets) {
      if (typeof c[method] === 'function') {
        try { c[method](); } catch (e) { console.warn(`[SerialService] ${method} failed:`, e.message); }
      }
    }
  }
  sendStart(circuit)  { this._sendToCircuits('sendStart',  circuit); }
  sendStop(circuit)   { this._sendToCircuits('sendStop',   circuit); }
  sendPause(circuit)  { this._sendToCircuits('sendPause',  circuit); }
  sendResume(circuit) { this._sendToCircuits('sendResume', circuit); }
  sendClear(circuit)  { this._sendToCircuits('sendClear',  circuit); }
  setMinLap(ms, circuit) {
    const targets = (circuit == null) ? this._connections : [this._connections[circuit]].filter(Boolean);
    for (const c of targets) { if (typeof c.setMinLap === 'function') { try { c.setMinLap(ms); } catch {} } }
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
  // True si la fuente activa es BART (SlotTime pilota el GO/STOP). Se usa en la
  // vista live para mostrar el botón GO/STOP, igual que en simulación. En DS-300
  // manda la caja → no aplica.
  get isBart()         { return this._connections.some(c => c && c.isBart); }
  get connectedPort()  { return this._connections[0]?.path ?? null; }
  get connectedPorts() { return this._connections.map(c => c.path).filter(Boolean); }

  // Contador de vueltas del DS-300 (byte 12) por carril GLOBAL, agregando todos
  // los circuitos DS. Solo lo pueblan las CircuitConnection reales (el BART se
  // excluye por isBart). Lo usa la reconciliación de cierre de manga en
  // TimingService para recuperar el cruce "en la bandera". La decisión de si la
  // fuente es DS real (vs simulación) se toma en el llamante.
  getDsLapCounters() {
    const out = {};
    for (const c of this._connections) {
      if (c && !c.isBart && typeof c.getLapCounters === 'function') {
        Object.assign(out, c.getLapCounters());
      }
    }
    return out;
  }

  // True if any connected DS-300 circuit is currently in 'running' state. Used
  // so free training can skip standby when entering while the DS is mid-manga.
  // Simulation mode is excluded — it always streams crossings, so the standby
  // → GO flow stays useful there.
  isDSRunning() {
    return this._connections.some(c => c._raceState === 'running');
  }

  // Link status using the same criterion as the Settings page:
  //   - simulation mode running → connected (UI doesn't need to warn)
  //   - at least one serial port open → connected
  //   - otherwise → disconnected
  getLinkStatus() {
    // connectedPorts solo lista conexiones REALES (BART/DS con path no nulo), así
    // que un BART que aún busca o falló no cuenta como conectado.
    // _simReplay = reproducción de carrera simulada: la fuente es el reproductor
    // (no hay puerto serie), pero SÍ hay señal, así que cuenta como conectado y
    // no debe salir el aviso "Sin señal del DS-300".
    const connected = this._simRunning || this._simReplay || this.connectedPorts.length > 0;
    return {
      connected,
      simulating: this._simRunning || this._simReplay,
      ports:      this.connectedPorts,
    };
  }

  // Nº de circuitos configurados (de circuits_serial). 1 si no hay multi.
  circuitCount() {
    try {
      const cfg = JSON.parse(Settings.get('circuits_serial', '[]')) || [];
      return Array.isArray(cfg) && cfg.length > 0 ? cfg.length : 1;
    } catch { return 1; }
  }

  // Carriles (globales, con offset) que pertenecen a un circuito según
  // circuits_serial. Devuelve null si solo hay 1 circuito (no aplica feedback
  // por circuito). Fuente única reutilizada por los servicios de training.
  lanesOfCircuit(ci) {
    let cfg = [];
    try { cfg = JSON.parse(Settings.get('circuits_serial', '[]')) || []; } catch {}
    if (!Array.isArray(cfg) || cfg.length <= 1) return null;
    let off = 0;
    for (let i = 0; i < cfg.length; i++) {
      const n = cfg[i].lanes || 8;
      if (i === ci) {
        const lanes = [];
        for (let l = off + 1; l <= off + n; l++) lanes.push(l);
        return lanes;
      }
      off += n;
    }
    return null;
  }
}

module.exports = new SerialServiceClass();
