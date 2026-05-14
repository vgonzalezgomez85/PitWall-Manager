const Circuit  = require('../models/Circuit');
const Category = require('../models/Category');

function parseCategoryTimes(body, categories) {
  const out = {};
  for (const cat of categories) {
    const raw = body[`category_min_lap_s_${cat.id}`];
    const s = parseFloat(raw);
    out[cat.id] = (!isNaN(s) && s > 0) ? Math.round(s * 1000) : 0;
  }
  return out;
}

class CircuitController {

  static index(req, res) {
    const circuits = Circuit.findAll().map(c => ({
      ...c,
      category_times: Circuit.getCategoryTimes(c.id),
    }));
    res.render('circuits/index', { t: req.t, circuits });
  }

  static newForm(req, res) {
    const categories = Category.findAll();
    res.render('circuits/form', { t: req.t, circuit: null, errors: [], body: {}, categories, categoryTimes: {} });
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

    const categories = Category.findAll();
    if (errors.length) return res.render('circuits/form', { t: req.t, circuit: null, errors, body: req.body, categories, categoryTimes: parseCategoryTimes(req.body, categories) });

    const newId = Circuit.create({
      name: trimName,
      circuits_count: numCircuits,
      circuits_config: circuitLanes,
      lanes_count: totalLanes,
      min_lap_ms: minLapMs,
      description: (description || '').trim() || null,
    });
    Circuit.setCategoryTimes(newId, parseCategoryTimes(req.body, categories));
    res.redirect('/circuits');
  }

  static editForm(req, res) {
    const circuit = Circuit.findById(req.params.id);
    if (!circuit) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    const config = Circuit.getConfig(circuit);
    const categories = Category.findAll();
    const existing = Circuit.getCategoryTimes(circuit.id);
    const categoryTimes = {};
    existing.forEach(e => { categoryTimes[e.category_id] = e.min_lap_ms; });
    const body = {
      name: circuit.name,
      description: circuit.description || '',
      circuits_count: circuit.circuits_count,
      min_lap_s: circuit.min_lap_ms > 0 ? (circuit.min_lap_ms / 1000).toFixed(2) : '',
    };
    for (let i = 0; i < config.length; i++) body[`circuit_lanes_${i + 1}`] = config[i];
    for (const cat of categories) {
      if (categoryTimes[cat.id]) body[`category_min_lap_s_${cat.id}`] = (categoryTimes[cat.id] / 1000).toFixed(2);
    }
    res.render('circuits/form', { t: req.t, circuit, errors: [], body, categories, categoryTimes });
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

    const categories = Category.findAll();
    if (errors.length) return res.render('circuits/form', { t: req.t, circuit, errors, body: req.body, categories, categoryTimes: parseCategoryTimes(req.body, categories) });

    Circuit.update(req.params.id, {
      name: trimName,
      circuits_count: numCircuits,
      circuits_config: circuitLanes,
      lanes_count: totalLanes,
      min_lap_ms: minLapMs,
      description: (description || '').trim() || null,
    });
    Circuit.setCategoryTimes(parseInt(req.params.id, 10), parseCategoryTimes(req.body, categories));
    res.redirect('/circuits');
  }

  static delete(req, res) {
    Circuit.delete(req.params.id);
    res.redirect('/circuits');
  }
}

module.exports = CircuitController;
