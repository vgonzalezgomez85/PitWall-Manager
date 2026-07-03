// ── LinkComparator ───────────────────────────────────────────────────────────
// Cotejo diagnóstico DS ↔ BART: dos sistemas de detección cronometrando los
// MISMOS carriles en paralelo (BART es nuevo y se valida contra el DS-300).
//
// Clave física (Víctor): los puentes de detección pueden NO estar en el mismo
// punto → los INSTANTES de cruce difieren por un desfase ~constante por carril
// (tiempo de viaje puente→puente). La vuelta de salida es el caso extremo
// (DS ~2s, BART ~8s) y NO es error. Lo invariante es el TIEMPO DE VUELTA.
//
// Estrategia unificada por carril:
//   1) (opcional) excluir la vuelta de salida.
//   2) estimar el desfase θ que MAXIMIZA emparejamientos (mediana de residuos).
//   3) emparejar por cercanía tras restar θ (dos punteros, tolerancia = jitter).
//   4) clasificar: emparejado (Δresidual = jitter real de BART),
//      solo-DS = BART se comió el cruce (miss), solo-BART = fantasma.
//
// Modo:
//   'same'      → puentes casi co-ubicados: θ pequeño (≤ ~1s, hueco físico real
//                 porque dos sensores no coexisten en el punto exacto); INCLUYE
//                 la salida. Busca θ en ±maxOffset (por defecto ~1.5s).
//   'different' → puentes separados: θ grande (fracción de vuelta); EXCLUYE la
//                 salida; busca θ en [−maxOffset, +maxOffset] amplio.
//   'auto'      → estima θ (excluyendo salida); si |θ| pequeño ⇒ trata como
//                 'same' (reincluye salida), si no ⇒ 'different'.

const DEFAULTS = {
  mode: 'auto',
  sameMaxOffsetMs: 1500,     // ventana de búsqueda de θ en modo "mismo punto"
  diffMaxOffsetMs: 30000,    // ventana amplia para puentes separados (< 1 vuelta larga)
  residualToleranceMs: 400,  // tras restar θ, cuánto puede desviarse y seguir siendo "el mismo cruce"
  autoThresholdMs: 1500,     // |θ| por debajo del cual "auto" decide "mismo punto"
  jitterFlagMs: 120,         // |residual| por encima del cual se marca ⚠ la vuelta
};

// Empareja dos secuencias ordenadas por elapsed tras aplicar θ a DS (dos punteros).
function matchAt(ds, bart, theta, tol) {
  const matched = [], misses = [], phantoms = [];
  let i = 0, j = 0;
  while (i < ds.length && j < bart.length) {
    const dt = ds[i].elapsedMs + theta;
    const bt = bart[j].elapsedMs;
    if (Math.abs(dt - bt) <= tol) { matched.push({ ds: ds[i], bart: bart[j] }); i++; j++; }
    else if (dt < bt) { misses.push(ds[i]); i++; }
    else { phantoms.push(bart[j]); j++; }
  }
  while (i < ds.length)   { misses.push(ds[i]);   i++; }
  while (j < bart.length) { phantoms.push(bart[j]); j++; }
  return { matched, misses, phantoms };
}

// Estima θ que maximiza emparejamientos; devuelve la mediana de residuos del mejor.
function estimateOffset(ds, bart, maxOffsetMs, tol) {
  if (!ds.length || !bart.length) return 0;
  const cands = new Set([0]);
  for (const d of ds) {
    for (const b of bart) {
      const diff = b.elapsedMs - d.elapsedMs;
      if (Math.abs(diff) <= maxOffsetMs) cands.add(diff);
    }
  }
  let best = null;
  for (const theta of cands) {
    const m = matchAt(ds, bart, theta, tol);
    const totalResid = m.matched.reduce((s, x) => s + Math.abs(x.bart.elapsedMs - x.ds.elapsedMs - theta), 0);
    const score = m.matched.length;
    if (!best || score > best.score || (score === best.score && totalResid < best.totalResid)) {
      best = { theta, score, totalResid, matched: m.matched };
    }
  }
  if (best && best.matched.length) {
    const resids = best.matched.map(x => x.bart.elapsedMs - x.ds.elapsedMs).sort((a, b) => a - b);
    return resids[Math.floor(resids.length / 2)];   // mediana → robusto a outliers
  }
  return best ? best.theta : 0;
}

function isOutLap(c) { return c.isWarmup || c.lapNumber === 1 || c.lapNumber === 0; }

// Compara UN carril. ds/bart = arrays de cruces {elapsedMs, lapMs, lapNumber, isGhost, isWarmup}.
function compareLane(dsAll, bartAll, opts) {
  const o = { ...DEFAULTS, ...opts };
  const sortByElapsed = a => [...a].sort((x, y) => x.elapsedMs - y.elapsedMs);
  let ds = sortByElapsed(dsAll), bart = sortByElapsed(bartAll);

  // Decidir modo efectivo + inclusión de la salida
  let mode = o.mode;
  let maxOffset = mode === 'same' ? o.sameMaxOffsetMs : o.diffMaxOffsetMs;
  if (mode === 'auto') {
    // estima θ excluyendo la salida (seguro), luego decide
    const dsNo = ds.filter(c => !isOutLap(c)), bartNo = bart.filter(c => !isOutLap(c));
    const thetaGuess = estimateOffset(dsNo, bartNo, o.diffMaxOffsetMs, o.residualToleranceMs);
    mode = Math.abs(thetaGuess) <= o.autoThresholdMs ? 'same' : 'different';
    maxOffset = mode === 'same' ? o.sameMaxOffsetMs : o.diffMaxOffsetMs;
  }
  const includeOutLap = (mode === 'same');
  if (!includeOutLap) { ds = ds.filter(c => !isOutLap(c)); bart = bart.filter(c => !isOutLap(c)); }

  const theta = estimateOffset(ds, bart, maxOffset, o.residualToleranceMs);
  const res = matchAt(ds, bart, theta, o.residualToleranceMs);

  const matched = res.matched.map(p => {
    const residualMs = p.bart.elapsedMs - p.ds.elapsedMs - theta;
    const lapDeltaMs = (p.bart.lapMs != null && p.ds.lapMs != null) ? p.bart.lapMs - p.ds.lapMs : null;
    return {
      dsElapsedMs: p.ds.elapsedMs, bartElapsedMs: p.bart.elapsedMs,
      dsLapMs: p.ds.lapMs, bartLapMs: p.bart.lapMs,
      residualMs, lapDeltaMs,
      flag: Math.abs(residualMs) > o.jitterFlagMs ? 'jitter' : 'ok',
      dsGhost: !!p.ds.isGhost, bartGhost: !!p.bart.isGhost,
    };
  });

  const resids = matched.map(m => Math.abs(m.residualMs));
  const residMean = resids.length ? resids.reduce((a, b) => a + b, 0) / resids.length : null;
  const residMax  = resids.length ? Math.max(...resids) : null;
  const residRms  = resids.length ? Math.sqrt(resids.reduce((a, b) => a + b * b, 0) / resids.length) : null;

  return {
    mode, includeOutLap,
    offsetMs: theta,
    dsCount: ds.length, bartCount: bart.length,
    matchedCount: matched.length,
    missCount: res.misses.length,        // DS lo vio, BART no → BART se comió el cruce
    phantomCount: res.phantoms.length,   // BART lo vio, DS no → fantasma
    residualMeanMs: residMean, residualMaxMs: residMax, residualRmsMs: residRms,
    jitterFlagged: matched.filter(m => m.flag === 'jitter').length,
    matched,
    misses:   res.misses.map(c => ({ elapsedMs: c.elapsedMs, lapMs: c.lapMs, isGhost: !!c.isGhost })),
    phantoms: res.phantoms.map(c => ({ elapsedMs: c.elapsedMs, lapMs: c.lapMs, isGhost: !!c.isGhost })),
  };
}

// Compara una manga entera. dsLaps/bartLaps = arrays planos con `lane`.
// Devuelve por carril + agregado global.
function compare(dsLaps, bartLaps, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const byLane = (arr) => {
    const m = new Map();
    for (const r of arr) {
      const lane = r.lane;
      if (!m.has(lane)) m.set(lane, []);
      m.get(lane).push({
        elapsedMs: r.elapsedMs ?? r.elapsed_ms,
        lapMs: r.lapMs ?? r.lap_time_ms,
        lapNumber: r.lapNumber ?? r.lap_number,
        isGhost: !!(r.isGhost ?? r.is_ghost),
        isWarmup: !!(r.isWarmup ?? r.is_warmup),
        team: r.team ?? r.team_name ?? null,
      });
    }
    return m;
  };
  const dsMap = byLane(dsLaps), bartMap = byLane(bartLaps);
  const lanes = [...new Set([...dsMap.keys(), ...bartMap.keys()])].sort((a, b) => a - b);

  const perLane = lanes.map(lane => {
    const r = compareLane(dsMap.get(lane) || [], bartMap.get(lane) || [], o);
    const team = (dsMap.get(lane)?.[0]?.team) || (bartMap.get(lane)?.[0]?.team) || null;
    return { lane, team, ...r };
  });

  // Agregado global (veredicto de BART)
  const sum = (f) => perLane.reduce((a, l) => a + (f(l) || 0), 0);
  const totalMatched = sum(l => l.matchedCount);
  const totalDs = sum(l => l.dsCount);
  const allResids = perLane.flatMap(l => l.matched.map(m => Math.abs(m.residualMs)));
  const aggregate = {
    lanes: perLane.length,
    totalDsCrossings: totalDs,
    totalBartCrossings: sum(l => l.bartCount),
    totalMatched,
    totalMisses: sum(l => l.missCount),
    totalPhantoms: sum(l => l.phantomCount),
    missRate: totalDs ? sum(l => l.missCount) / totalDs : 0,
    residualMeanMs: allResids.length ? allResids.reduce((a, b) => a + b, 0) / allResids.length : null,
    residualMaxMs: allResids.length ? Math.max(...allResids) : null,
    jitterFlagged: sum(l => l.jitterFlagged),
  };

  return { opts: o, aggregate, perLane };
}

module.exports = { compare, compareLane, estimateOffset, matchAt, DEFAULTS };
