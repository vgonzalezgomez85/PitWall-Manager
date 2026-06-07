const Settings       = require('../models/Settings');
const SerialService  = require('../services/SerialService');
const LicenseService = require('../services/LicenseService');
const DebugLogger    = require('../services/DebugLogger');
const Circuit        = require('../models/Circuit');

class SettingsController {

  static async _scanPorts() {
    const fs = require('fs');
    const ports = await SerialService.listPorts();
    const out = ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || null }));
    if (process.platform !== 'win32') {
      try {
        const entries = fs.readdirSync('/dev')
          .filter(n => /^ttys\d{3,}$|^tty\.(usbserial|usbmodem|SLAB|wchusbserial)/i.test(n))
          .map(n => '/dev/' + n)
          .filter(p => !out.find(o => o.path === p));
        for (const path of entries) out.push({ path, manufacturer: 'pty/usb-serial' });
      } catch {}
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  static async index(req, res) {
    const cfg   = Settings.getAll();
    const ports = await SettingsController._scanPorts();

    let circuits = [];
    try { circuits = JSON.parse(cfg.circuits_serial || '[]'); } catch {}
    if (circuits.length === 0) circuits = [{ port: '', baud: 57600, lanes: 8, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' }];

    const multiCircuit = LicenseService.has('multi_circuit');
    if (!multiCircuit && circuits.length > 1) circuits = circuits.slice(0, 1);

    res.render('settings/index', {
      t: req.t,
      cfg,
      ports,
      circuits,
      multiCircuit,
      allCircuits:    Circuit.findAll(),
      isSimulating:   SerialService.isSimulating,
      connectedPorts: SerialService.connectedPorts,
      rawLog:         SerialService.getRawLog().slice(-20),
    });
  }

  static async listPorts(req, res) {
    res.json({ ports: await SettingsController._scanPorts() });
  }

  static async save(req, res) {
    const { serial_mode, sim_lanes, sim_avg_ms, serial_frame_gap_ms, debug_mode, infolap_enabled,
            access_restrict_enabled, access_allowlist } = req.body;
    const debugOn   = debug_mode      === '1' || debug_mode      === 'on' || debug_mode      === 'true';
    const infolapOn = infolap_enabled === '1' || infolap_enabled === 'on' || infolap_enabled === 'true';
    const accessOn  = access_restrict_enabled === '1' || access_restrict_enabled === 'on' || access_restrict_enabled === 'true';
    // Allowlist: IPs/CIDR separadas por coma, salto de línea o ';'
    const allowlist = String(access_allowlist || '')
      .split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

    // Parse multi-circuit config from form arrays
    const portArr  = [].concat(req.body['circuit_port']  || []);
    const baudArr  = [].concat(req.body['circuit_baud']  || []);
    const lanesArr = [].concat(req.body['circuit_lanes'] || []);
    const refArr   = [].concat(req.body['circuit_ref']   || []);
    const dbArr    = [].concat(req.body['circuit_databits'] || []);
    const parArr   = [].concat(req.body['circuit_parity']   || []);
    const sbArr    = [].concat(req.body['circuit_stopbits'] || []);
    const flowArr  = [].concat(req.body['circuit_flow']     || []);

    let circuits = portArr
      .map((port, i) => {
        const refId = parseInt(refArr[i], 10);
        let lanes = parseInt(lanesArr[i] || '8', 10);
        let circuit_id = null;
        // If a saved circuit is referenced, override lanes with its lanes_count
        if (refId) {
          const ref = Circuit.findById(refId);
          if (ref) { lanes = ref.lanes_count; circuit_id = ref.id; }
        }
        return {
          port:  port.trim(),
          baud:  parseInt(baudArr[i] || '57600', 10),
          dataBits:    parseInt(dbArr[i] || '8', 10),
          parity:      parArr[i]  || 'none',
          stopBits:    parseInt(sbArr[i] || '1', 10),
          flowControl: flowArr[i] || 'none',
          lanes,
          ...(circuit_id ? { circuit_id } : {}),
        };
      })
      .filter(c => c.port);

    // Pro-only: multi-circuit. Non-Pro may only use one circuit.
    if (!LicenseService.has('multi_circuit') && circuits.length > 1) {
      circuits = circuits.slice(0, 1);
    }

    // Training circuit is derived from the first DS-300 that references a saved
    // circuit. Falls back to '' (none) if no DS-300 has one assigned.
    const trainingCircuitId = (circuits.find(c => c.circuit_id) || {}).circuit_id || '';

    // Clamp parser tuning: invalid values fall back to default 75
    const fg = parseInt(serial_frame_gap_ms, 10);
    const fgClean = (Number.isFinite(fg) && fg >= 10 && fg <= 500) ? fg : 75;

    // BART source: TCP bridge (emulator or BLE→TCP). Stored as a single circuit
    // entry with type:'bart' so SerialService.connectMultiple builds a
    // BartConnection. Lanes still numbered globally like the DS-300 path.
    const bartTransport = req.body.bart_transport === 'ble' ? 'ble' : 'tcp';
    const bartHost  = String(req.body.bart_host || '127.0.0.1').trim() || '127.0.0.1';
    const bartPort  = parseInt(req.body.bart_port  || '9300', 10) || 9300;
    const bartName  = String(req.body.bart_name || 'BART_MST').trim() || 'BART_MST';
    const bartLanes = parseInt(req.body.bart_lanes || '4', 10) || 4;
    const bm = parseInt(req.body.bart_minlap, 10);
    const bartMinlap = (Number.isFinite(bm) && bm >= 0 && bm <= 65535) ? bm : 2000;
    if (serial_mode === 'bart') {
      circuits = [{ type: 'bart', transport: bartTransport, host: bartHost, port: bartPort, name: bartName, lanes: bartLanes, minlap: bartMinlap }];
    }

    Settings.setMany({
      serial_mode:          serial_mode || 'simulation',
      circuits_serial:      JSON.stringify(circuits),
      bart_transport:       bartTransport,
      bart_host:            bartHost,
      bart_port:            String(bartPort),
      bart_name:            bartName,
      bart_lanes:           String(bartLanes),
      bart_minlap:          String(bartMinlap),
      sim_lanes:            sim_lanes   || '6',
      sim_avg_ms:           sim_avg_ms  || '12000',
      training_circuit_id:  String(trainingCircuitId),
      serial_frame_gap_ms:  String(fgClean),
      debug_mode:           debugOn ? '1' : '0',
      infolap_enabled:      infolapOn ? '1' : '0',
      access_restrict_enabled: accessOn ? '1' : '0',
      access_allowlist:        JSON.stringify(allowlist),
    });
    DebugLogger.setEnabled(debugOn);

    // Aplica toggle Infolap en caliente: arranca/para el UDP server sin
    // necesidad de reiniciar el proceso. (El texto en Settings dice que
    // requiere reinicio para curarse en salud, pero esto va igual.)
    try {
      const InfolapServer = require('../services/InfolapServer');
      if (infolapOn && !InfolapServer.isRunning)  InfolapServer.start();
      if (!infolapOn && InfolapServer.isRunning)  InfolapServer.stop();
    } catch (e) { console.warn('[Settings] Infolap toggle failed:', e.message); }

    if ((serial_mode === 'serial' || serial_mode === 'bart') && circuits.length > 0) {
      await SerialService.closeAll();
      SerialService.init(); // re-reads frame gap + reconnects (DS-300 or BART)
    } else {
      await SerialService.closeAll();
      SerialService.startSimulation(
        parseInt(sim_lanes  || '6',     10),
        parseInt(sim_avg_ms || '12000', 10),
      );
    }

    // Confirmación visible (flash): así el usuario SABE que se aplicó y con qué
    // fuente/transporte (antes no había feedback → "parece que no aplica").
    const isEs = (req.session && req.session.lang) !== 'en';
    let src;
    if (serial_mode === 'bart') {
      src = bartTransport === 'ble'
        ? (isEs ? `BART (BLE) — buscando "${bartName}"…` : `BART (BLE) — searching "${bartName}"…`)
        : (isEs ? `BART (TCP ${bartHost}:${bartPort})` : `BART (TCP ${bartHost}:${bartPort})`);
    } else if (serial_mode === 'serial') {
      src = isEs ? `DS-300 (${circuits.length} circuito${circuits.length === 1 ? '' : 's'})` : `DS-300 (${circuits.length} circuit${circuits.length === 1 ? '' : 's'})`;
    } else {
      src = isEs ? 'Simulación' : 'Simulation';
    }
    req.session.flash = { type: 'success', text: (isEs ? 'Configuración aplicada · Fuente: ' : 'Settings applied · Source: ') + src };

    res.redirect('/settings');
  }
}

module.exports = SettingsController;
