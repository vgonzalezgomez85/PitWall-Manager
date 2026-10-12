/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// ── Consistencia de ritmo (métrica compartida) ──────────────────────────────
// % de vueltas limpias que caen dentro de ±WINDOW de la mediana de SU MANGA.
// Sustituye al antiguo CV (100 − CV·100), que daba 96–99 para todo el pelotón
// (no discriminaba) y era frágil: una vuelta de tráfico desmadraba la media+DE.
//
// Por qué así (validado con las carreras reales del club — RESISLEMANS 1,
// 24H Llinars, 24h Modena — y la Llinars simulada):
//   · POR MANGA: la mediana y la banda se calculan dentro de cada stint, así
//     que un coche/carril distinto en otra manga no cuenta como "inconsistencia".
//   · BANDA ±1.5%: robusta por construcción (una vuelta loca no entra y ya
//     está — no hace falta filtrar incidentes por MAD) e interpretable:
//     "X% de tus vueltas dentro del ±1.5% de tu ritmo de esa manga".
//   · LA DE (σ* robusta, 1.4826·MAD) se mantiene como cifra de apoyo en ms
//     ("±0,13 s"): es lo que un piloto entiende, pero sin romperse con un lío.
//
// Las vueltas que llegan aquí ya vienen limpias por el llamante: sin warmup,
// sin salidas/pits (is_exit), sin fantasmas y sin estimadas, y ≥ min_lap_ms.

// Media ventana de la banda sobre la mediana del stint (fracción, no %).
const CONSISTENCY_WINDOW = 0.015;

// Una manga con menos vueltas que esto no cuenta (con 2 no hay dispersión).
const MIN_STINT_LAPS = 3;

// Mínimo de vueltas válidas (entre todas las mangas que cuentan) para dar valor.
const MIN_CONSISTENCY_LAPS = 3;

// Umbrales de nivel sobre el % de la banda (mayor = más consistente).
// Calibrados con las carreras de referencia: reparten un pelotón real de club
// (~15-20% excelente, ~40% buena, ~25-30% irregular, resto errática) y dejan
// los extremos para quien de verdad destaca o se sale del ritmo. Ojo: pistas
// cortas (Modena, 10 s/vuelta) tienden a valores más bajos que las largas.
const CONSISTENCY_LEVELS = [
  { min: 90, level: 'excelente' },
  { min: 75, level: 'buena'     },
  { min: 60, level: 'irregular' },
  { min: -Infinity, level: 'erratica' },
];
function consistencyLevel(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  for (const b of CONSISTENCY_LEVELS) if (pct >= b.min) return b.level;
  return 'erratica';
}

// Mediana de un array numérico (no muta el original).
function median(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// stints: iterable de arrays de tiempos (ms), un array por MANGA. Devuelve
// { pct, stdMs, medMs, level, n, stints } o null si no hay muestra suficiente.
//   pct    = % de vueltas dentro de ±WINDOW·mediana de su manga (1 decimal)
//   stdMs  = σ* robusta (1.4826·MAD) por manga, media ponderada por vueltas
//   medMs  = mediana de todas las vueltas contadas (tiempo típico)
//   n      = vueltas contadas · stints = mangas que cuentan
function stintConsistency(stints, { window = CONSISTENCY_WINDOW, minStintLaps = MIN_STINT_LAPS } = {}) {
  let inBand = 0, n = 0, stintsCounted = 0;
  let stdSum = 0;
  const all = [];
  for (const laps of stints || []) {
    if (!laps || laps.length < minStintLaps) continue;
    const med = median(laps);
    if (med == null || med <= 0) continue;
    stintsCounted++;
    const devs = [];
    for (const t of laps) {
      devs.push(Math.abs(t - med));
      if (Math.abs(t - med) <= window * med) inBand++;
    }
    stdSum += 1.4826 * median(devs) * laps.length;
    n += laps.length;
    for (const t of laps) all.push(t);
  }
  if (!stintsCounted || n < MIN_CONSISTENCY_LAPS) return null;
  const pct = Math.round(inBand / n * 1000) / 10;
  return {
    pct,
    stdMs: Math.round(stdSum / n),
    medMs: Math.round(median(all)),
    level: consistencyLevel(pct),
    n,
    stints: stintsCounted,
  };
}

module.exports = {
  CONSISTENCY_WINDOW,
  CONSISTENCY_LEVELS,
  consistencyLevel,
  median,
  MIN_STINT_LAPS,
  MIN_CONSISTENCY_LAPS,
  stintConsistency,
};
