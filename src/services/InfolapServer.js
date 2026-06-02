// Servidor compatible con el protocolo Infolap (Tic Tac Slot legacy), para
// que la app Android Infolap pueda conectarse a Voltrace y recibir vueltas
// en tiempo real como si fuera el "Gestor de Carreras" v5.8.8 de TTS.
//
// Protocolo (verificado contra capturas reales — ver scripts/test-infolap-codec.js):
//   Fase 1 — Discovery:
//     - Cliente envía UDP broadcast a :4441 con "InfoLap:CXXX" (12 bytes).
//     - Server responde unicast a <ip-cliente>:12543 con
//       "OK <name1>;#<id1><name2>;#<id2>...".
//
//   Fase 2 — Push:
//     - Server empuja 1 paquete de 52 bytes por carril, ciclando entre todos.
//     - Cliente es push-only tras el discovery: no envía nada más.
//     - Si dejan de llegar probes (~30s), olvidamos al cliente.
//
// El módulo es OPT-IN: solo arranca si `infolap_enabled = '1'` en Settings.
// Hace pull pasivo de TimingService.session — no muta nada del flujo principal.

const dgram = require('dgram');
const codec = require('./infolapCodec');

const PORT_LISTEN  = 4441;
const PORT_PUSH    = 12543;
const CLIENT_TTL_MS = 30_000;  // drop clientes sin probe en este tiempo

class InfolapServerClass {
  constructor() {
    this._socket   = null;
    this._clients  = new Map();   // ip → { lastSeen: ts }
    this._pushInt  = null;
    this._lanesState = new Map(); // lane → { name, lastLapMs, firstReport }
    this._packetSeq  = 1;
    this._altFlag    = ' ';
    this._cycleIdx   = 0;
    this._lapHandler = null;
    this._timingSvc  = null;       // resuelto perezosamente (evita ciclo de require)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  start() {
    if (this._socket) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('error', (err) => {
      console.error('[Infolap] socket error:', err.message);
      this.stop();
    });

    sock.on('message', (msg, rinfo) => {
      if (codec.isDiscoveryProbe(msg)) {
        this._onProbe(rinfo.address);
      }
    });

    sock.on('listening', () => {
      try { sock.setBroadcast(true); } catch {}
      console.log(`[Infolap] listening on UDP :${PORT_LISTEN}`);
    });

    sock.bind(PORT_LISTEN);
    this._socket = sock;

    // Push timer: si hay clientes y hay datos, empuja cada 800ms.
    this._pushInt = setInterval(() => this._tick(), 800);

    // Hook a cruces para mantener `_lanesState.lastLapMs` actualizado
    // independientemente de cuándo se haga push.
    const SerialService = require('./SerialService');
    this._lapHandler = ({ lane, lapTimeMs }) => {
      if (lapTimeMs == null) return;
      const st = this._lanesState.get(lane) || {};
      st.lastLapMs = lapTimeMs;
      this._lanesState.set(lane, st);
    };
    SerialService.on('lane_crossing', this._lapHandler);
  }

  stop() {
    if (this._pushInt) { clearInterval(this._pushInt); this._pushInt = null; }
    if (this._lapHandler) {
      const SerialService = require('./SerialService');
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }
    if (this._socket) {
      try { this._socket.close(); } catch {}
      this._socket = null;
    }
    this._clients.clear();
    this._lanesState.clear();
    console.log('[Infolap] stopped');
  }

  // Reset del estado per-manga (forzar primer reporte de cada carril otra vez)
  resetSession() {
    this._lanesState.clear();
    this._cycleIdx = 0;
    this._packetSeq = 1;
  }

  get isRunning() { return this._socket != null; }

  // ── Discovery ──────────────────────────────────────────────────────────────
  _onProbe(ip) {
    const wasNew = !this._clients.has(ip);
    this._clients.set(ip, { lastSeen: Date.now() });
    if (wasNew) console.log(`[Infolap] new client ${ip}`);

    // Respondemos a cada probe (la app real envía probes cada ~2s y espera
    // discovery response cada vez — sirve también como ack/keepalive).
    const entries = this._currentEntries();
    if (entries.length === 0) return;
    const resp = codec.buildDiscoveryResponse(entries);
    this._socket.send(resp, 0, resp.length, PORT_PUSH, ip);
  }

  // ── Push de paquetes de estado ─────────────────────────────────────────────
  _tick() {
    if (!this._socket) return;

    // Purga clientes viejos
    const now = Date.now();
    for (const [ip, info] of this._clients) {
      if (now - info.lastSeen > CLIENT_TTL_MS) this._clients.delete(ip);
    }
    if (this._clients.size === 0) return;

    const entries = this._currentEntries();
    if (entries.length === 0) return;

    // Manga number (1-indexed) si hay sesión, si no 1
    const mangaNum = this._currentMangaNumber();

    // Próximo carril del ciclo
    const e = entries[this._cycleIdx % entries.length];
    this._cycleIdx++;

    const lane = e.lane;
    const state = this._lanesState.get(lane) || {};
    const firstReport = state.lastLapMs == null;

    const pkt = codec.buildPacket({
      seq:         this._packetSeq,
      lane,
      name:        e.name,
      lapMs:       state.lastLapMs ?? null,
      firstReport,
      mangaNum,
      altFlag:     this._altFlag,
    });

    // Marcamos firstReport una vez aunque no llegue lap, para que el cliente
    // sepa que ese carril existe. (Memory: "1"=primer reporte, "X"=normal.)
    // Tras enviarlo con firstReport=true cambiamos a "no-first" hasta que
    // haya un reset.
    if (firstReport) {
      state.firstReport = false;
      this._lanesState.set(lane, state);
    }

    // Alterna F/space entre paquetes consecutivos
    this._altFlag = (this._altFlag === ' ') ? 'F' : ' ';
    this._packetSeq++;
    if (this._packetSeq > 999) this._packetSeq = 1;

    for (const [ip] of this._clients) {
      this._socket.send(pkt, 0, pkt.length, PORT_PUSH, ip, (err) => {
        if (err) console.warn(`[Infolap] push to ${ip} failed: ${err.message}`);
      });
    }
  }

  // ── Fuente de verdad: participantes actuales ───────────────────────────────
  //
  // Devuelve [{ lane, name, id }] desde la mejor fuente disponible:
  //   1. TimingService.session (manga oficial corriendo)
  //   2. TrainingService (entrenamiento libre activo)
  //   3. [] si no hay nada
  _currentEntries() {
    const TimingService = this._getTimingService();
    if (TimingService?.session?.laneMap) {
      return Object.values(TimingService.session.laneMap).map((l, i) => ({
        lane: l.lane,
        name: l.name || `Carril ${l.lane}`,
        id:   String(i + 1).padStart(3, '0'),
      }));
    }
    const TrainingService = require('./TrainingService');
    if (TrainingService.isActive) {
      return TrainingService.getLanes().map((l, i) => ({
        lane: l.lane,
        name: `Carril ${l.lane}`,
        id:   String(i + 1).padStart(3, '0'),
      }));
    }
    return [];
  }

  _currentMangaNumber() {
    const TimingService = this._getTimingService();
    return TimingService?.session?.manga?.number || 1;
  }

  _getTimingService() {
    if (!this._timingSvc) this._timingSvc = require('./TimingService');
    return this._timingSvc;
  }
}

module.exports = new InfolapServerClass();
