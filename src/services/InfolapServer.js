// Servidor compatible con el protocolo Infolap (Tic Tac Slot legacy), para
// que la app Android Infolap pueda conectarse a PitWall y recibir vueltas
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
    this._txSocket = null;   // socket de ENVÍO con puerto efímero (como el Gestor real)
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

    // Socket de ENVÍO separado, en puerto efímero (fijo durante la sesión),
    // igual que el "Gestor de Carreras" real de Tic Tac: las respuestas de
    // discovery y el push NO salen del :4441 de escucha sino de este puerto.
    // (Verificado en capturas: el Gestor real responde desde un puerto efímero,
    // nunca desde 4441; la app parece engancharse a ese (IP,puerto).)
    const tx = dgram.createSocket('udp4');
    tx.on('error', (err) => console.error('[Infolap] tx socket error:', err.message));
    tx.bind(() => { try { console.log(`[Infolap] tx desde puerto ${tx.address().port}`); } catch {} });
    this._txSocket = tx;

    // Sin ciclo de reenvío: el push es EVENT-DRIVEN. Al recibir un cruce con
    // tiempo, actualizamos el estado y empujamos ESE carril una sola vez.
    const SerialService = require('./SerialService');
    this._lapHandler = ({ lane, lapTimeMs }) => {
      if (lapTimeMs == null) return;
      const st = this._lanesState.get(lane) || {};
      st.lastLapMs = lapTimeMs;
      this._lanesState.set(lane, st);
      this._pushLane(lane);   // 1 vuelta = 1 paquete (a todos los clientes)
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
    if (this._txSocket) {
      try { this._txSocket.close(); } catch {}
      this._txSocket = null;
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

  // Clientes Infolap (móvil) conectados, EXCLUYENDO localhost.
  remoteClientCount() {
    let n = 0;
    for (const ip of this._clients.keys()) {
      if (ip !== '127.0.0.1' && ip !== '::1' && !String(ip).startsWith('::ffff:127.')) n++;
    }
    return n;
  }

  // ── Discovery ──────────────────────────────────────────────────────────────
  _onProbe(ip) {
    const wasNew = !this._clients.has(ip);
    this._clients.set(ip, { lastSeen: Date.now() });

    // Respondemos el discovery a cada probe.
    const entries = this._currentEntries();
    if (entries.length === 0) return;
    const resp = codec.buildDiscoveryResponse(entries);
    this._txSocket.send(resp, 0, resp.length, PORT_PUSH, ip);

    // Cliente nuevo: le enviamos un primer-reporte de CADA carril (con su estado
    // actual; centinela si aún sin vuelta) para que los registre. Solo a él.
    if (wasNew) {
      console.log(`[Infolap] new client ${ip}`);
      for (const e of entries) this._pushLane(e.lane, ip);
      try { require('./SocketService')._emitConnections(); } catch {}
    }
  }

  // ── Push de UN carril ───────────────────────────────────────────────────────
  // Event-driven: se envía un paquete de ese carril (a todos los clientes, o a
  // uno solo si se pasa `onlyIp`). Se llama al recibir cada cruce → 1 vuelta =
  // 1 paquete = la app la canta UNA vez. (Antes un ciclo reenviaba el mismo
  // tiempo cada ~800ms → la app lo cantaba 2-3 veces.)
  _pushLane(lane, onlyIp = null) {
    if (!this._txSocket) return;
    if (!onlyIp && this._clients.size === 0) return;

    const entries = this._currentEntries();
    const e = entries.find(x => x.lane === lane);
    if (!e) return;   // ese carril no pertenece a la sesión actual

    const state = this._lanesState.get(lane) || {};
    const firstReport = state.lastLapMs == null;

    const pkt = codec.buildPacket({
      seq:         this._packetSeq,
      lane,
      name:        e.name,
      lapMs:       state.lastLapMs ?? null,
      firstReport,
      mangaNum:    this._currentMangaNumber(),
      altFlag:     this._altFlag,
    });

    this._altFlag = (this._altFlag === ' ') ? 'F' : ' ';
    this._packetSeq++;
    if (this._packetSeq > 999) this._packetSeq = 1;

    const targets = onlyIp ? [onlyIp] : [...this._clients.keys()];
    for (const ip of targets) {
      this._txSocket.send(pkt, 0, pkt.length, PORT_PUSH, ip, (err) => {
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
    // 1. Manga oficial CORRIENDO.
    if (TimingService?.session?.laneMap) {
      return Object.values(TimingService.session.laneMap).map((l, i) => ({
        lane: l.lane,
        name: l.name || `Carril ${l.lane}`,
        id:   String(i + 1).padStart(3, '0'),
      }));
    }
    // 2. Manga ARMADA (pendiente del GO): permite que el móvil conecte y elija
    //    carril/equipo ANTES de dar el GO.
    const pend = TimingService?._pendingSetup;
    if (pend?.lanes?.length) {
      return pend.lanes
        .filter(ml => !ml.is_rest)
        .map((ml, i) => ({
          lane: ml.lane,
          name: ml.team_name || ml.driver_name || `Carril ${ml.lane}`,
          id:   String(i + 1).padStart(3, '0'),
        }));
    }
    // 3. Training ACTIVO o en STANDBY (preparado, esperando GO).
    const TrainingService = require('./TrainingService');
    if (TrainingService.isReady) {
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
