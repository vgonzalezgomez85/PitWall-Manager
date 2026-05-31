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

// Default slot-racing rotation: odds ascending + evens descending
// (e.g. 6 lanes → [1,3,5,6,4,2]; 12 lanes → [1,3,5,7,9,11,12,10,8,6,4,2]).
function defaultLaneSequence(n) {
  const odds = [], evens = [];
  for (let i = 1; i <= n; i++) (i % 2 ? odds : evens).push(i);
  return [...odds, ...evens.reverse()];
}

// Parse a comma-separated lane sequence like "1,3,5,6,4,2" or "1,3,5,0,6,4,2".
// 0 means "explicit rest slot". Returns array. Falls back to slot-rotation
// default when empty or malformed. Lanes must be in [0..totalLanes].
// Parse track minimap fields from body. Imagen como data URL base64;
// outline como JSON `[[x,y], ...]` con coords relativas 0..1.
// Si `track_image_b64` no llega y existe un circuito previo, se conserva
// la imagen existente (evita perderla al editar otros campos).
function parseTrackFields(body, prevCircuit) {
  let img = (body.track_image_b64 || '').trim();
  if (!img && prevCircuit) img = prevCircuit.track_image_b64 || '';
  if (img === '__CLEAR__') img = '';   // permite borrar explícitamente

  let outline = [];
  try {
    const parsed = JSON.parse(body.track_outline_json || '[]');
    if (Array.isArray(parsed)) {
      outline = parsed
        .filter(p => Array.isArray(p) && p.length === 2
                  && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([x, y]) => [
          Math.max(0, Math.min(1, +x)),
          Math.max(0, Math.min(1, +y)),
        ]);
    }
  } catch {}
  return { trackImageB64: img || null, trackOutlineJson: outline };
}

function parseLaneSequence(raw, totalLanes) {
  const fallback = defaultLaneSequence(totalLanes);
  if (!raw || typeof raw !== 'string') return fallback;
  const seq = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);
  if (seq.length === 0) return fallback;
  const nonRest = seq.filter(n => n > 0);
  if (nonRest.length === 0) return fallback;
  if (nonRest.some(n => n > totalLanes)) return fallback;
  if (new Set(nonRest).size !== nonRest.length) return fallback;
  return seq;
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

    const laneSequence = parseLaneSequence(req.body.lane_sequence, totalLanes);
    const { trackImageB64, trackOutlineJson } = parseTrackFields(req.body);

    const newId = Circuit.create({
      name: trimName,
      circuits_count: numCircuits,
      circuits_config: circuitLanes,
      lanes_count: totalLanes,
      min_lap_ms: minLapMs,
      description: (description || '').trim() || null,
      lane_sequence: laneSequence,
      track_image_b64: trackImageB64,
      track_outline_json: trackOutlineJson,
      track_direction: (req.body.track_direction === 'ccw') ? 'ccw' : 'cw',
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
      lane_sequence: Circuit.getLaneSequence(circuit).join(','),
      track_direction: circuit.track_direction || 'cw',
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

    const laneSequence = parseLaneSequence(req.body.lane_sequence, totalLanes);
    const { trackImageB64, trackOutlineJson } = parseTrackFields(req.body, circuit);

    Circuit.update(req.params.id, {
      name: trimName,
      circuits_count: numCircuits,
      circuits_config: circuitLanes,
      lanes_count: totalLanes,
      min_lap_ms: minLapMs,
      description: (description || '').trim() || null,
      lane_sequence: laneSequence,
      track_image_b64: trackImageB64,
      track_outline_json: trackOutlineJson,
      track_direction: (req.body.track_direction === 'ccw') ? 'ccw' : 'cw',
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
