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
// Fuente «interface TicTac»: lee los cruces del interface TicTacSlot.
//
// El aparato es un dispositivo USB HID (no crea ningún puerto COM), así que el modo
// normal es USB: PitWall lo busca por VID/PID y se engancha solo, y si se desenchufa
// vuelve a engancharse al volver a conectarlo. El modo «serie» queda para el
// emulador (emulador-tictac) o su puente hid-bridge.js, que reenvían las tramas a
// un PTY.
//
// El aparato solo manda cruces: no manda GO, pausa, stop ni fin. Esas señales las
// genera PitWall (SerialService.softwareGo), y de este lado solo hace falta saber
// cuándo empieza una manga (sendStart) y si hay una viva (setExternalRaceState).
// Las tramas de evento (0x1C) que llegaran se muestran en el visor y se ignoran.
const { performance } = require('perf_hooks');
const DebugLogger  = require('./DebugLogger');
const FrameMonitor = require('./FrameMonitor');
const P = require('../lib/tictacProtocol');

const MIN_CROSSING_MS = 500;      // rebote: dos cruces del mismo carril en < 0,5 s
const MAX_LAP_MS      = 240000;   // > 240 s sin cruzar = coche parado o manga nueva: el cruce es un «primero»
const MAX_LANE        = 8;
const RECONNECT_MAX_MS = 10000;
const HID_VID         = 0x04d8;   // Microchip (1240)
const HID_PID         = 0x0001;
const HID_USAGE_PAGE  = 0xffa0;   // página de uso propietaria del TicTacSlot
const USB_SCAN_MS     = 2000;     // cada cuánto se busca el aparato mientras no está enganchado
const RAW_LOG_MAX     = 2000;
const BUF_MAX         = 4096;     // tope del buffer de troceado: ante basura sin sincronismo no crece

// `node-hid` es un módulo nativo opcional: si no se pudo instalar o compilar, la
// fuente USB no está disponible pero el resto de PitWall sigue funcionando.
let _hidLoader = () => require('node-hid');

class TicTacConnection {
  // Solo para los tests: sustituye el módulo HID por uno falso.
  static setHidLoader(fn) { _hidLoader = fn || (() => require('node-hid')); }

  // Aparatos TicTacSlot conectados por USB, para que Ajustes muestre si lo detecta.
  // { available, devices: [{ path, product, manufacturer }], error }
  static listDevices() {
    let HID;
    try { HID = _hidLoader(); }
    catch (e) { return { available: false, devices: [], error: e.message }; }
    try {
      const devices = HID.devices()
        .filter(d => d.vendorId === HID_VID && d.productId === HID_PID)
        .map(d => ({ path: d.path, product: d.product || null, manufacturer: d.manufacturer || null, usagePage: d.usagePage }));
      return { available: true, devices, error: null };
    } catch (e) {
      return { available: true, devices: [], error: e.message };
    }
  }

  // Mismas posiciones que CircuitConnection/BartConnection: connectMultiple arma un
  // único array de callbacks para todas las fuentes. Aquí solo se usan los de cruce
  // y enlace.
  constructor(circuitIndex, laneOffset, onCrossing, onGo, onStop, onPause, onResume, onGoSignal, onFinish, onResumeSignal, onSemaphoreStep, onHeartbeat, onLinkChange) {
    this._circuitIndex = circuitIndex;
    this._laneOffset   = laneOffset;
    this._onCrossing   = onCrossing;
    this._onLinkChange = onLinkChange || (() => {});

    this.isTicTac   = true;
    this._port      = null;
    this._connected = false;       // false hasta abrir el puerto de verdad
    this._rawLog    = [];
    this._buf       = Buffer.alloc(0);
    this._mangaActive = false;     // lo dice TimingService, no el aparato

    // Estado por carril. El reloj del aparato es la referencia del tiempo de vuelta;
    // la hora de llegada al PC solo marca el instante del cruce.
    this._lastClockByLane = new Map();
    this._lastLapByLane   = new Map();

    this._hid            = null;   // dispositivo HID abierto (modo USB)
    this._usbScanTimer   = null;
    this._usbError       = null;
    this._lastConfig     = null;
    this._reconnectTimer = null;
    this._reconnectMs    = 1500;
    this._explicitClose  = false;
  }

  get connected()       { return this._connected; }
  get lastHeartbeatTs() { return null; }
  get usbError()        { return this._usbError; }
  get path() {
    if (!this._connected) return null;
    if (this._hid) return `hid://${HID_VID.toString(16).padStart(4, '0')}:${HID_PID.toString(16).padStart(4, '0')}`;
    return this._port?.path ?? null;
  }
  get rawLog()          { return [...this._rawLog]; }

  // ── Transporte USB (HID) ─────────────────────────────────────────────────
  // Nunca lanza por «no hay aparato»: lo normal es arrancar PitWall con el interface
  // aún desenchufado. Busca cada USB_SCAN_MS y se engancha cuando aparece.
  async connectUsb() {
    this._lastConfig    = { transport: 'usb' };
    this._explicitClose = false;
    this._startUsbScan();
    this._scanUsbOnce();
  }

  _startUsbScan() {
    if (this._usbScanTimer) return;
    this._usbScanTimer = setInterval(() => this._scanUsbOnce(), USB_SCAN_MS);
    this._usbScanTimer.unref?.();
  }

  _stopUsbScan() {
    if (this._usbScanTimer) { clearInterval(this._usbScanTimer); this._usbScanTimer = null; }
  }

  _scanUsbOnce() {
    if (this._explicitClose || this._hid) return;
    let HID;
    try { HID = _hidLoader(); }
    catch (e) {
      if (this._usbError !== e.message) console.warn(`[TicTac C${this._circuitIndex + 1}] Lectura USB no disponible (node-hid): ${e.message}`);
      this._usbError = e.message;
      return;
    }
    this._usbError = null;

    let info;
    try {
      const found = HID.devices().filter(d => d.vendorId === HID_VID && d.productId === HID_PID);
      info = found.find(d => d.usagePage === HID_USAGE_PAGE) || found[0];
    } catch (e) {
      console.warn(`[TicTac C${this._circuitIndex + 1}] No se pudo listar los dispositivos HID: ${e.message}`);
      return;
    }
    if (!info) return;

    let dev;
    try { dev = new HID.HID(info.path); }
    catch (e) {
      console.warn(`[TicTac C${this._circuitIndex + 1}] No se pudo abrir el TicTacSlot: ${e.message}`);
      DebugLogger.log('tictac_usb_open_error', { circuit: this._circuitIndex + 1, error: e.message });
      return;
    }

    this._hid = dev;
    this._buf = Buffer.alloc(0);
    dev.on('data', buf => { if (this._hid === dev) this._onData(Buffer.from(buf)); });
    dev.on('error', err => { if (this._hid === dev) this._usbLost(err); });
    console.log(`[TicTac C${this._circuitIndex + 1}] TicTacSlot detectado por USB (lane offset: ${this._laneOffset})`);
    this._setConnected(true);
  }

  // Desenchufado (o fallo de lectura): se suelta el dispositivo y se vuelve a buscar.
  _usbLost(err) {
    console.warn(`[TicTac C${this._circuitIndex + 1}] USB perdido: ${err && err.message ? err.message : err}`);
    this._releaseUsb();
    this._setConnected(false);
  }

  _releaseUsb() {
    const dev = this._hid;
    this._hid = null;
    if (dev) { try { dev.removeAllListeners?.(); dev.on?.('error', () => {}); dev.close(); } catch {} }
  }

  async connect(portPath, baudRate, opts = {}) {
    this._lastConfig    = { portPath, baudRate, opts };
    this._explicitClose = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }

    const { SerialPort } = require('serialport');
    if (this._port) await new Promise(r => this._port.close(r));
    this._buf = Buffer.alloc(0);

    // Un PTY de macOS rechaza velocidades no estándar; la velocidad es irrelevante ahí.
    const rates = baudRate !== 57600 ? [baudRate, 57600] : [57600];
    for (const rate of rates) {
      const p = new SerialPort({ path: portPath, baudRate: rate, autoOpen: false, hupcl: false, lock: false, highWaterMark: 65536 });
      const err = await new Promise(r => p.open(e => r(e)));
      if (!err) { this._port = p; break; }
      console.warn(`[TicTac C${this._circuitIndex + 1}] ${portPath} @ ${rate} failed: ${err.message}`);
      if (rate === rates[rates.length - 1]) { this._scheduleReconnect(); throw err; }
    }

    this._port.on('data', chunk => this._onData(chunk));
    this._port.on('error', err => console.error(`[TicTac C${this._circuitIndex + 1}] Port error:`, err.message));
    this._port.on('close', () => {
      console.warn(`[TicTac C${this._circuitIndex + 1}] Port closed`);
      this._setConnected(false);
      this._scheduleReconnect();
    });

    console.log(`[TicTac C${this._circuitIndex + 1}] Connected to ${portPath} (lane offset: ${this._laneOffset})`);
    this._setConnected(true);
    this._reconnectMs = 1500;
  }

  _scheduleReconnect() {
    if (this._explicitClose || !this._lastConfig || this._reconnectTimer) return;
    if (this._port && this._port.isOpen) return;
    const delay = this._reconnectMs;
    console.warn(`[TicTac C${this._circuitIndex + 1}] Reintentando en ${delay}ms…`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._explicitClose || !this._lastConfig) return;
      if (this._port && this._port.isOpen) return;
      const { portPath, baudRate, opts } = this._lastConfig;
      try {
        await this.connect(portPath, baudRate, opts);
        console.log(`[TicTac C${this._circuitIndex + 1}] Reconectado ✓`);
      } catch (err) {
        this._reconnectMs = Math.min(RECONNECT_MAX_MS, Math.round(this._reconnectMs * 2));
        this._scheduleReconnect();
      }
    }, delay);
  }

  async close() {
    this._explicitClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopUsbScan();
    this._releaseUsb();
    if (!this._port) return;
    await new Promise(r => this._port.close(r));
    this._port = null;
  }

  _setConnected(connected) {
    if (this._connected === connected) return;
    this._connected = connected;
    console.log(`[TicTac C${this._circuitIndex + 1}] Link → ${connected ? 'connected' : 'DISCONNECTED'}`);
    this._onLinkChange(this._circuitIndex, connected);
  }

  // GO de PitWall: cada carril empieza de cero. El reloj del aparato no se reinicia
  // al arrancar la manga, así que sin esto el primer cruce traería la vuelta desde
  // el último cruce de antes (el calentamiento, la manga anterior). Con la
  // referencia borrada sale «sin tiempo» y TimingService lo cuenta como la vuelta de
  // salida desde el GO, igual que el primer cruce de un DS.
  sendStart() {
    this._lastClockByLane.clear();
    this._lastLapByLane.clear();
  }

  // Con la manga viva, una vuelta larguísima es una vuelta (p. ej. el primer cruce
  // tras una pausa de varios minutos, que TimingService corrige restando la pausa).
  // Fuera de una manga, un silencio de > 240 s es otra sesión: cruce «primero».
  setExternalRaceState(running) { this._mangaActive = !!running; }

  // Los contadores por carril sobreviven a una reconexión por ajustes (mismo
  // criterio que el DS): sin la referencia de reloj, el primer cruce tras el corte
  // saldría sin tiempo de vuelta.
  exportLaneState() {
    return { lastClock: new Map(this._lastClockByLane), lastLap: new Map(this._lastLapByLane) };
  }
  importLaneState(s) {
    if (!s || !s.lastClock) return;
    this._lastClockByLane = new Map(s.lastClock);
    this._lastLapByLane   = new Map(s.lastLap || []);
  }

  _onData(chunk) {
    const now = performance.timeOrigin + performance.now();
    for (const b of chunk) {
      this._rawLog.push({ byte: b, ts: now });
      if (this._rawLog.length > RAW_LOG_MAX) this._rawLog.shift();
    }

    let buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const { frames, rest } = P.extraerTramas(buf);
    this._buf = rest.length > BUF_MAX ? Buffer.alloc(0) : Buffer.from(rest);

    for (const frame of frames) {
      // El visor no puede tumbar el cronometraje.
      try { FrameMonitor.push('tictac', this._circuitIndex + 1, frame, now, { laneOffset: this._laneOffset }); } catch {}
      try {
        this._processFrame(frame, now);
      } catch (err) {
        console.error(`[TicTac C${this._circuitIndex + 1}] Trama descartada por error de parseo:`, err.message);
        DebugLogger.log('tictac_frame_error', { circuit: this._circuitIndex + 1, error: err.message });
      }
    }
  }

  _processFrame(frame, ts) {
    const d = P.decodificar(frame);
    if (!d) return;

    if (d.tipo === 'evento') {
      DebugLogger.log('tictac_evento', { circuit: this._circuitIndex + 1, codigo: d.codigo, nombre: d.nombre });
      return;
    }
    if (d.tipo !== 'cruce') return;

    if (d.lane < 1 || d.lane > MAX_LANE) {
      console.warn(`[TicTac C${this._circuitIndex + 1}] carril ${d.lane} fuera de rango — trama descartada`);
      DebugLogger.log('tictac_carril_invalido', { circuit: this._circuitIndex + 1, lane: d.lane });
      return;
    }

    const globalLane = d.lane + this._laneOffset;
    const prevClock  = this._lastClockByLane.get(d.lane);
    const prevLap    = this._lastLapByLane.get(d.lane);

    // El nº de vuelta del aparato solo avisa de huecos (no se sabe cuándo lo reinicia
    // el propio aparato). No se rellenan vueltas fantasma: sería inventar tiempos.
    if (prevLap != null && d.lap > prevLap + 1) {
      console.warn(`[TicTac C${this._circuitIndex + 1}] Carril ${globalLane}: salto de vuelta ${prevLap} → ${d.lap}`);
      DebugLogger.log('tictac_hueco', { circuit: this._circuitIndex + 1, lane: globalLane, prev: prevLap, now: d.lap });
    }
    this._lastLapByLane.set(d.lane, d.lap);

    // Primer cruce, o tanto tiempo desde el anterior que es otra manga/coche parado:
    // no hay tiempo de vuelta válido y pasa a ser la nueva referencia.
    let lapTimeMs = null;
    if (prevClock != null) {
      const dt = P.deltaReloj(prevClock, d.clockMs);
      if (dt <= MAX_LAP_MS || this._mangaActive) lapTimeMs = dt;
    }

    if (lapTimeMs === null) {
      this._lastClockByLane.set(d.lane, d.clockMs);
      console.log(`[TicTac C${this._circuitIndex + 1}] Lane ${d.lane} → global ${globalLane} — first crossing`);
      this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs: null });
      return;
    }

    // Rebote: no mueve la referencia, o la vuelta real siguiente saldría recortada.
    if (lapTimeMs < MIN_CROSSING_MS) return;

    this._lastClockByLane.set(d.lane, d.clockMs);
    console.log(`[TicTac C${this._circuitIndex + 1}] Lane ${d.lane} → global ${globalLane} — ${lapTimeMs.toFixed(1)}ms`);
    this._onCrossing({ lane: globalLane, timestamp: ts, lapTimeMs });
  }
}

module.exports = TicTacConnection;
