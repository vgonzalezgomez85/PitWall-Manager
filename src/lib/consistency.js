// ── Consistencia de carrera (métrica compartida) ────────────────────────────
// Métrica de consistencia definitiva de PitWall (coincide con TicTac): CV
// clásico con desviación típica MUESTRAL (n−1) sobre la muestra ya filtrada de
// incidentes. Extraída aquí desde LiveStatsController para reutilizarla también
// en la página de Resultados. Comportamiento IDÉNTICO: no cambiar fórmula ni
// umbrales sin verificar contra datos reales (24h Modena / tramas DS-300).

// Umbrales de nivel de consistencia sobre el CV clásico (fracción, no %).
// Calibrados con la 24h Modena (ver informe): sobre CV por manga filtrado,
// reparten el pelotón real (~59% excelente, ~35% buena, ~5% irregular) y
// siguen teniendo sentido para carreras de club, más ruidosas.
//   cvR < 1.5%          → 'excelente'
//   1.5% ≤ cvR < 2.5%   → 'buena'
//   2.5% ≤ cvR < 4.0%   → 'irregular'
//   cvR ≥ 4.0%          → 'erratica'
const CONSISTENCY_LEVELS = [
  { max: 0.015, level: 'excelente' },
  { max: 0.025, level: 'buena'     },
  { max: 0.040, level: 'irregular' },
  { max: Infinity, level: 'erratica' },
];
function consistencyLevel(cv) {
  if (cv == null || !Number.isFinite(cv)) return null;
  for (const b of CONSISTENCY_LEVELS) if (cv < b.max) return b.level;
  return 'erratica';
}

// Mediana de un array numérico (no muta el original).
function median(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Filtra vueltas-incidente (salidas no marcadas, cruces perdidos, tráfico
// puntual) ANTES de aplicar el CV clásico. Estimador ROBUSTO por MAD:
//   MAD  = mediana(|tᵢ − mediana|)
//   σ*   = 1.4826 · MAD   (aprox. de la desviación típica robusta)
//   descarta |tᵢ − mediana| > 3.5·σ*   (≈ 3.5σ, cola muy improbable)
//   refuerzo: descarta tᵢ > mediana·1.5 (una vuelta a >150% del ritmo NO es
//             ritmo real: es un incidente aunque MAD sea grande).
// El filtro NO cambia la fórmula: solo saca la muestra sucia; sobre lo que
// queda se aplica el CV clásico de TicTac (misma cifra en datos limpios).
function filterIncidentLaps(times) {
  if (!times || times.length < 2) return times || [];
  const med = median(times);
  if (med == null || med <= 0) return times;
  const mad = median(times.map(t => Math.abs(t - med)));
  const robustStd = 1.4826 * mad;
  const madThreshold = 3.5 * robustStd;   // 0 si MAD=0 (muestra idéntica)
  const hardCap = med * 1.5;
  return times.filter(t => {
    if (t > hardCap) return false;
    if (madThreshold > 0 && Math.abs(t - med) > madThreshold) return false;
    return true;
  });
}

// Métrica de consistencia definitiva (coincide con TicTac): CV clásico con
// desviación típica MUESTRAL (n−1), aplicado sobre la muestra ya filtrada de
// incidentes. Devuelve { pct, stdMs, meanMs, cv, level, n } o null si, tras el
// filtrado, quedan menos de `minN` vueltas (fiabilidad insuficiente).
//   media = Σt/n
//   var   = Σ(t−media)² / (n−1)     ← MUESTRAL
//   DE    = √var
//   CV    = DE / media
//   consistencia% = clamp(100 − CV·100, 0, 100)
// Opción { filterIncidents }: por defecto true (variante SIN salidas/pits, ritmo
// puro → descarta incidentes por MAD). Con false NO se filtra: se usa la muestra
// tal cual (variante CON salidas/pits → regularidad REAL del stint, cuentan pits
// e incidentes no marcados). Misma fórmula CV muestral y mismo `consistencyLevel`.
// Mínimo de vueltas (tras filtrar) para mostrar consistencia. 3 es el suelo
// razonable: con menos no hay dispersión que medir. Ojo: de las vueltas de una
// manga se descartan la 1ª cruzada y la de calentamiento, así que 3 elegibles ≈
// 5 vueltas dadas. Con menos → null ("—") hasta acumular más.
const MIN_CONSISTENCY_LAPS = 3;
function robustConsistency(times, minN = MIN_CONSISTENCY_LAPS, { filterIncidents = true } = {}) {
  const clean = filterIncidents ? filterIncidentLaps(times) : (times || []);
  const n = clean.length;
  if (n < minN) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return null;
  const variance = n > 1
    ? clean.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)
    : 0;
  const std = Math.sqrt(variance);
  const cv  = std / mean;
  // pct con 1 decimal (p.ej. 97.6): coincide con TicTac (97.57 → 97.6) y sigue
  // renderizándose bien con `+ '%'` en la vista. clamp [0,100].
  return {
    pct:    Math.max(0, Math.min(100, Math.round((100 - cv * 100) * 10) / 10)),
    stdMs:  Math.round(std),
    meanMs: Math.round(mean),
    cv,
    level:  consistencyLevel(cv),
    n,
  };
}

module.exports = {
  CONSISTENCY_LEVELS,
  consistencyLevel,
  median,
  filterIncidentLaps,
  MIN_CONSISTENCY_LAPS,
  robustConsistency,
};
