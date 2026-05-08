const Settings       = require('../models/Settings');
const SerialService  = require('../services/SerialService');
const LicenseService = require('../services/LicenseService');

class SettingsController {

  static async index(req, res) {
    const cfg   = Settings.getAll();
    const ports = await SerialService.listPorts();

    let circuits = [];
    try { circuits = JSON.parse(cfg.circuits_serial || '[]'); } catch {}
    if (circuits.length === 0) circuits = [{ port: '', baud: 4800, lanes: 8 }];

    const multiCircuit = LicenseService.has('multi_circuit');
    if (!multiCircuit && circuits.length > 1) circuits = circuits.slice(0, 1);

    res.render('settings/index', {
      t: req.t,
      cfg,
      ports,
      circuits,
      multiCircuit,
      isSimulating:   SerialService.isSimulating,
      connectedPorts: SerialService.connectedPorts,
      rawLog:         SerialService.getRawLog().slice(-20),
    });
  }

  static async save(req, res) {
    const { serial_mode, sim_lanes, sim_avg_ms } = req.body;

    // Parse multi-circuit config from form arrays
    const portArr  = [].concat(req.body['circuit_port']  || []);
    const baudArr  = [].concat(req.body['circuit_baud']  || []);
    const lanesArr = [].concat(req.body['circuit_lanes'] || []);

    let circuits = portArr
      .map((port, i) => ({
        port:  port.trim(),
        baud:  parseInt(baudArr[i]  || '4800', 10),
        lanes: parseInt(lanesArr[i] || '8',    10),
      }))
      .filter(c => c.port);

    // Pro-only: multi-circuit. Non-Pro may only use one circuit.
    if (!LicenseService.has('multi_circuit') && circuits.length > 1) {
      circuits = circuits.slice(0, 1);
    }

    Settings.setMany({
      serial_mode:     serial_mode || 'simulation',
      circuits_serial: JSON.stringify(circuits),
      sim_lanes:       sim_lanes   || '6',
      sim_avg_ms:      sim_avg_ms  || '12000',
    });

    if (serial_mode === 'serial' && circuits.length > 0) {
      SerialService.connectMultiple(circuits).catch(err => {
        console.error('[Settings] Serial connect error:', err.message);
      });
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
