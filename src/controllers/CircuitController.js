const Circuit = require('../models/Circuit');

class CircuitController {

  static index(req, res) {
    const circuits = Circuit.findAll();
    res.render('circuits/index', { t: req.t, circuits });
  }

  static newForm(req, res) {
    res.render('circuits/form', { t: req.t, circuit: null, errors: [], body: {} });
  }

  static create(req, res) {
    const { name, description } = req.body;
    const errors = [];

    const trimName = (name || '').trim();
    if (trimName.length < 2) errors.push('name_required');

    const numCircuits = Math.max(1, Math.min(6, parseInt(req.body.circuits_count, 10) || 1));
    const circuitLanes = [];
    for (let i = 1; i <= numCircuits; i++) {
      const n = parseInt(req.body[`circuit_lanes_${i}`], 10);
      if (isNaN(n) || n < 2 || n > 8) { errors.push('lanes_invalid'); break; }
      circuitLanes.push(n);
    }
    const totalLanes = circuitLanes.reduce((a, b) => a + b, 0);
    if (!errors.includes('lanes_invalid') && (totalLanes < 2 || totalLanes > 32)) errors.push('lanes_invalid');

    const minLapS = parseFloat(req.body.min_lap_s);
    const minLapMs = (!isNaN(minLapS) && minLapS > 0) ? Math.round(minLapS * 1000) : 0;

    if (errors.length) return res.render('circuits/form', { t: req.t, circuit: null, errors, body: req.body });

    Circuit.create({
      name: trimName,
      circuits_count: numCircuits,
      circuits_config: circuitLanes,
      lanes_count: totalLanes,
      min_lap_ms: minLapMs,
      description: (description || '').trim() || null,
    });
    res.redirect('/circuits');
  }

  static editForm(req, res) {
    const circuit = Circuit.findById(req.params.id);
    if (!circuit) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    const config = Circuit.getConfig(circuit);
    const body = {
      name: circuit.name,
      description: circuit.description || '',
      circuits_count: circuit.circuits_count,
      min_lap_s: circuit.min_lap_ms > 0 ? (circuit.min_lap_ms / 1000).toFixed(2) : '',
    };
    for (let i = 0; i < config.length; i++) body[`circuit_lanes_${i + 1}`] = config[i];
    res.render('circuits/form', { t: req.t, circuit, errors: [], body });
  }

  static update(req, res) {
    const circuit = Circuit.findById(req.params.id);
    if (!circuit) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const { name, description } = req.body;
    const errors = [];

    const trimName = (name || '').trim();
    if (trimName.length < 2) errors.push('name_required');

    const numCircuits = Math.max(1, Math.min(6, parseInt(req.body.circuits_count, 10) || 1));
    const circuitLanes = [];
    for (let i = 1; i <= numCircuits; i++) {
      const n = parseInt(req.body[`circuit_lanes_${i}`], 10);
      if (isNaN(n) || n < 2 || n > 8) { errors.push('lanes_invalid'); break; }
      circuitLanes.push(n);
    }
    const totalLanes = circuitLanes.reduce((a, b) => a + b, 0);
    if (!errors.includes('lanes_invalid') && (totalLanes < 2 || totalLanes > 32)) errors.push('lanes_invalid');

    const minLapS = parseFloat(req.body.min_lap_s);
    const minLapMs = (!isNaN(minLapS) && minLapS > 0) ? Math.round(minLapS * 1000) : 0;

    if (errors.length) return res.render('circuits/form', { t: req.t, circuit, errors, body: req.body });

    Circuit.update(req.params.id, {
      name: trimName,
      circuits_count: numCircuits,
      circuits_config: circuitLanes,
      lanes_count: totalLanes,
      min_lap_ms: minLapMs,
      description: (description || '').trim() || null,
    });
    res.redirect('/circuits');
  }

  static delete(req, res) {
    Circuit.delete(req.params.id);
    res.redirect('/circuits');
  }
}

module.exports = CircuitController;
