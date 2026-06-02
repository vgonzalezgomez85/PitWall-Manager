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
    const { serial_mode, sim_lanes, sim_avg_ms, serial_frame_gap_ms, debug_mode, infolap_enabled } = req.body;
    const debugOn   = debug_mode      === '1' || debug_mode      === 'on' || debug_mode      === 'true';
    const infolapOn = infolap_enabled === '1' || infolap_enabled === 'on' || infolap_enabled === 'true';

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

    Settings.setMany({
      serial_mode:          serial_mode || 'simulation',
      circuits_serial:      JSON.stringify(circuits),
      sim_lanes:            sim_lanes   || '6',
      sim_avg_ms:           sim_avg_ms  || '12000',
      training_circuit_id:  String(trainingCircuitId),
      serial_frame_gap_ms:  String(fgClean),
      debug_mode:           debugOn ? '1' : '0',
      infolap_enabled:      infolapOn ? '1' : '0',
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

    if (serial_mode === 'serial' && circuits.length > 0) {
      await SerialService.closeAll();
      SerialService.init(); // re-reads frame gap + reconnects
    } else {
      await SerialService.closeAll();
      SerialService.startSimulation(
        parseInt(sim_lanes  || '6',     10),
        parseInt(sim_avg_ms || '12000', 10),
      );
    }

    res.redirect('/settings');
  }
}

module.exports = SettingsController;
