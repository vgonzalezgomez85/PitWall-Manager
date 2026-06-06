'use strict';

// ============================================================================
//  BartConnection — fuente de cruces BART para SerialService.
//
//  Hermana de CircuitConnection (DS-300): misma firma de constructor y los
//  MISMOS callbacks (onCrossing/onGo/…), de modo que SerialService la trata
//  igual y nada aguas abajo (TimingService, etc.) se entera de que la fuente
//  es BART y no un DS-300.
//
//  Hoy el transporte es TCP (contra el emulador o un puente BLE→TCP). El día
//  que haya hardware, el BLE entra cambiando SOLO _openTransport() — el parser,
//  el mapeo de carriles y la detección de huecos no se tocan.
//
//  BART es PASIVO para el timing: SlotTime consume cruces y lleva su propia
//  lógica de carrera. Los comandos de salida (START/MinLap) son "higiene del
//  hardware" best-effort: si no llegan, el cronometraje sigue igual.
// ============================================================================

const net = require('net');
const P   = require('./protocol');

const MIN_CROSSING_MS = 500;     // igual que el DS-300: descarta rebotes
const MAX_LAP_MS      = 240000;  // > 240s → coche parado, no se registra
const RECONNECT_MAX_MS = 10000;

// Nordic UART Service (UUIDs 128-bit en minúsculas sin guiones, formato noble)
const NUS_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX      = '6e400002b5a3f393e0a9e50e24dcca9e'; // phone → master (write)
const NUS_TX      = '6e400003b5a3f393e0a9e50e24dcca9e'; // master → phone (notify)
const _u = (s) => String(s || '').replace(/-/g, '').toLowerCase();

class BartConnection {
  constructor(circuitIndex, laneOffset, onCrossing, onGo, onStop, onPause, onResume, onGoSignal, onFinish, onResumeSignal, onSemaphoreStep) {
    this._circuitIndex    = circuitIndex;
    this._laneOffset      = laneOffset;
    this._onCrossing      = onCrossing;
    this._onGo            = onGo            || (() => {});
    this._onStop          = onStop          || (() => {});
    this._onPause         = onPause         || (() => {});
    this._onResume        = onResume        || (() => {});
    this._onGoSignal      = onGoSignal      || (() => {});
    this._onFinish        = onFinish        || (() => {});
    this._onResumeSignal  = onResumeSignal  || (() => {});
    this._onSemaphoreStep = onSemaphoreStep || (() => {});

    this.isBart      = true;         // marca de fuente (SerialService.isBart, UI)
    this._sock       = null;         // socket TCP (transporte tcp)
    this._peripheral = null;         // periférico BLE (transporte ble)
    this._rxChar     = null;         // característica RX para escribir comandos (BLE)
    this._bleScanTimer = null;
    this._connected = true;          // optimista hasta que algo diga lo contrario
    this._raceState = null;          // 'running' | 'paused' | 'stopped' | null
    this._rawLog    = [];

    // Detección de huecos: igual disciplina que el DS-300, pero el contador es
    // el campo `laps` de cada paquete BART (acumulado por carril).
    this._lastLapByLane  = new Map();
    this._lapStatsByLane = new Map();

    // Transporte / reconexión
    this._host           = null;
    this._port           = null;
    this._opts           = {};
    this._reconnectTimer = null;
    this._reconnectMs    = 1500;
    this._explicitClose  = false;

    // Parser binario con resync 0xA5 + validación CRC (compartido con el emulador)
    this._parser = new P.FrameParser(
      (msgType /*, op */) => P.notifyLength(msgType),
      ({ msgType, frame }) => this._onFrame(msgType, frame),
      (err) => console.warn(`[BART C${this._circuitIndex + 1}] frame ${err.type}${err.frame ? ' [' + P.hex(err.frame) + ']' : ''}`),
    );
  }

  // ── Surface esperada por SerialService ──────────────────────────────────
  get path()   {
    if (this._opts && this._opts.transport === 'ble') return `bart-ble://${this._opts.name || 'BART_MST'}`;
    return this._host ? `bart://${this._host}:${this._port}` : null;
  }
  get rawLog() { return [...this._rawLog]; }

  // ── Conexión ────────────────────────────────────────────────────────────
  async connect(host, port, opts = {}) {
    this._host = host;
    this._port = port;
    this._opts = opts;
    this._explicitClose = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    await this._openTransport();
  }

  _openTransport() {
    return this._opts.transport === 'ble' ? this._openBle() : this._openTcp();
  }

  // ── Transporte TCP (emulador o puente BLE→TCP) ───────────────────────────
  _openTcp() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this._port, this._host);
      let settled = false;

      sock.on('connect', () => {
        this._sock = sock;
        this._reconnectMs = 1500;
        this._setConnected(true);
        console.log(`[BART C${this._circuitIndex + 1}] conectado a ${this.path}`);
        this._sendSetup();              // NOTIFY ON (+ MinLap / START best-effort)
        if (!settled) { settled = true; resolve(); }
      });
      sock.on('data',  chunk => this._onData(chunk));
      sock.on('close', () => { this._setConnected(false); this._scheduleReconnect(); });
      sock.on('error', err => {
        console.warn(`[BART C${this._circuitIndex + 1}] socket: ${err.message}`);
        if (!settled) { settled = true; reject(err); }   // 1er intento falla → init() hace fallback
      });
    });
  }

  // ── Transporte BLE real (central, noble) ─────────────────────────────────
  // Escanea por el servicio NUS, conecta al Master, suscribe TX (notify) y
  // escribe comandos en RX. El día de mañana, un BART físico entra por aquí
  // igual que el emulador BLE.
  _openBle() {
    return new Promise((resolve, reject) => {
      let noble;
      try { noble = require('@abandonware/noble'); }
      catch (e) { return reject(new Error('falta @abandonware/noble (npm install) — ' + e.message)); }

      const wantName = this._opts.name || 'BART_MST';
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

      const startScan = () => {
        console.log(`[BART C${this._circuitIndex + 1}] escaneando BLE (NUS / "${wantName}")…`);
        // Sin filtro de servicio: muchos periféricos (p.ej. bleno) NO meten el
        // UUID del NUS en el paquete de anuncio (va en scan-response o falta),
        // así que filtrar por servicio se los pierde. Emparejamos en onDiscover
        // por servicio O por nombre.
        try { noble.startScanning([], false); } catch (e) { fail(e); }
      };

      const onDiscover = async (peripheral) => {
        const adv = peripheral.advertisement || {};
        const matchSvc  = (adv.serviceUuids || []).map(_u).includes(NUS_SERVICE);
        const matchName = adv.localName && adv.localName === wantName;
        if (!matchSvc && !matchName) return;             // no es nuestro BART
        noble.removeListener('discover', onDiscover);
        try { await noble.stopScanningAsync(); } catch {}
        try {
          this._peripheral = peripheral;
          await peripheral.connectAsync();
          const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([NUS_SERVICE], [NUS_RX, NUS_TX]);
          const rx = characteristics.find(c => _u(c.uuid) === NUS_RX);
          const tx = characteristics.find(c => _u(c.uuid) === NUS_TX);
          if (!rx || !tx) throw new Error('características NUS RX/TX no encontradas');
          this._rxChar = rx;
          tx.on('data', (d) => this._onData(d));
          await tx.subscribeAsync();                     // CCCD notify on
          peripheral.once('disconnect', () => {
            this._rxChar = null; this._peripheral = null;
            this._setConnected(false);
            this._scheduleReconnect();
          });
          this._reconnectMs = 1500;
          this._setConnected(true);
          console.log(`[BART C${this._circuitIndex + 1}] conectado por BLE a ${peripheral.address || wantName}`);
          this._sendSetup();
          if (!settled) { settled = true; resolve(); }
        } catch (e) {
          console.warn(`[BART C${this._circuitIndex + 1}] BLE: ${e.message}`);
          fail(e);
        }
      };

      noble.on('discover', onDiscover);
      if (noble.state === 'poweredOn') startScan();
      else noble.once('stateChange', (s) => {
        if (s === 'poweredOn') startScan();
        else fail(new Error('BLE no disponible: ' + s));
      });

      // Si en 15s no aparece, falla (init no cae a sim en BART; reintenta solo).
      this._bleScanTimer = setTimeout(() => {
        if (!settled) { try { noble.stopScanning(); } catch {} noble.removeListener('discover', onDiscover); fail(new Error('BLE: periférico no encontrado (timeout)')); }
      }, 15000);
    });
  }

  // ── Comandos de salida (inversión de control) ────────────────────────────
  // Best-effort: el timing NO depende de ellos. Si un comando se pierde, la
  // carrera sigue cronometrando con los cruces que lleguen.
  _write(buf) {
    const b = Buffer.from(buf);
    if (this._rxChar) { try { this._rxChar.write(b, true, () => {}); } catch {} return; }  // BLE (writeWithoutResponse)
    if (this._sock && !this._sock.destroyed) this._sock.write(b);                            // TCP
  }
  _cmd(op)    { this._write(P.seal([P.SYNC, P.MSG.CMD, op])); }

  sendStart()   { this._cmd(P.OP.START); }
  sendStop()    { this._cmd(P.OP.STOP); }
  sendPause()   { this._cmd(P.OP.PAUSE); }
  sendClear()   { this._cmd(P.OP.CLEAR); }
  // No hay OP_RESUME en BART: reanudar = volver a START (4.1 / Apéndice H).
  sendResume()  { this._cmd(P.OP.START); }
  setMinLap(ms) {
    const b = Buffer.alloc(5);
    b[0] = P.SYNC; b[1] = P.MSG.CMD; b[2] = P.OP.SET_MINLAP; b.writeUInt16LE((ms | 0) & 0xFFFF, 3);
    this._write(P.seal(b));
  }

  _sendSetup() {
    this._write(P.seal([P.SYNC, P.MSG.CMD, P.OP.NOTIFY, 0x01]));        // 7.1 habilitar notificaciones
    if (this._opts.minlap != null) this.setMinLap(this._opts.minlap);
    // Por defecto NO armamos el Master: el GO/START lo manda SlotTime cuando
    // arranca la manga (inversión de control). start:true fuerza armado (p.ej.
    // monitor de cruces sin manga).
    if (this._opts.start === true) this.sendStart();
  }

  _scheduleReconnect() {
    if (this._explicitClose || this._reconnectTimer) return;
    const delay = this._reconnectMs;
    console.warn(`[BART C${this._circuitIndex + 1}] reconectando en ${delay}ms…`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try { await this._openTransport(); }
      catch { this._reconnectMs = Math.min(RECONNECT_MAX_MS, Math.round(this._reconnectMs * 2)); this._scheduleReconnect(); }
    }, delay);
  }

  async close() {
    this._explicitClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._bleScanTimer) { clearTimeout(this._bleScanTimer); this._bleScanTimer = null; }
    if (this._sock) { try { this._sock.destroy(); } catch {} this._sock = null; }
    if (this._peripheral) { try { await this._peripheral.disconnectAsync(); } catch {} this._peripheral = null; }
    this._rxChar = null;
  }

  _setConnected(connected) {
    if (this._connected === connected) return;
    this._connected = connected;
    console.log(`[BART C${this._circuitIndex + 1}] Link → ${connected ? 'connected' : 'DISCONNECTED'}`);
    try {
      const SocketService = require('../SocketService');
      SocketService.emit('serial:status', { circuit: this._circuitIndex + 1, connected });
    } catch {}
  }

  // ── Stream entrante ───────────────────────────────────────────────────────
  _onData(chunk) {
    const now = Date.now();
    for (const b of chunk) {
      this._rawLog.push({ byte: b, ts: now });
      if (this._rawLog.length > 50000) this._rawLog.shift();
    }
    this._parser.push(chunk);
  }

  _onFrame(msgType, frame) {
    if (msgType === P.MSG.LAP)         this._onLap(frame);
    else if (msgType === P.MSG.STATUS) this._onStatus(frame);
    // ACK: nada que hacer en el camino de timing.
  }

  _onStatus(frame) {
    const state = frame[3];
    this._raceState = state === P.STATE.RUN   ? 'running'
                    : state === P.STATE.PAUSE ? 'paused'
                    : state === P.STATE.STOP  ? 'stopped' : null;
  }

  // A5 01 01 lane laps[2] lap_ms[2] ts_d10[2] reserved[2] CRC
  _onLap(frame) {
    const localLane = frame[3];
    const laps      = frame.readUInt16LE(4);
    const lapMsRaw  = frame.readUInt16LE(6);
    const ts        = Date.now();                          // NUESTRO reloj es la verdad
    const globalLane = localLane + this._laneOffset;

    // lap_ms es uint16 → 0xFFFF = desborde (coche parado >65s) → sin valor fiable
    const lapTimeMs = lapMsRaw >= 0xFFFF ? null : lapMsRaw;

    // Relleno de huecos por el contador acumulado (maneja wrap de uint16).
    const prev = this._lastLapByLane.get(localLane);
    if (prev != null) {
      const delta = (laps - prev + 0x10000) & 0xFFFF;
      if (delta > 1) {
        const missed = delta - 1;
        const stats  = this._lapStatsByLane.get(localLane);
        const avgMs  = (stats && stats.count > 0) ? (stats.sum / stats.count) : null;
        console.warn(`[BART C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — hueco detectado (prev=${prev}, now=${laps}, ${missed} perdidas, avg=${avgMs ? avgMs.toFixed(1) + 'ms' : 'n/a'})`);
        for (let k = 0; k < missed; k++) {
          this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs: avgMs, missed: true });
        }
      }
    }
    this._lastLapByLane.set(localLane, laps);

    if (lapTimeMs === null) {
      this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs: null });
      return;
    }
    if (lapTimeMs < MIN_CROSSING_MS || lapTimeMs > MAX_LAP_MS) return;

    const stats = this._lapStatsByLane.get(localLane) || { sum: 0, count: 0 };
    stats.sum += lapTimeMs; stats.count += 1;
    this._lapStatsByLane.set(localLane, stats);

    console.log(`[BART C${this._circuitIndex + 1}] Lane ${localLane} → global ${globalLane} — ${lapTimeMs}ms (lap ${laps})`);
    this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs });
  }
}

module.exports = BartConnection;
