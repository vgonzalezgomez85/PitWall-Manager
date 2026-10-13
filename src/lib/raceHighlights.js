'use strict';

// Destacados de Resultados: conclusiones de una línea sacadas de datos que ya
// existen. PURO (sin BD) para poder probarlo.
//
// A propósito NO hay «vueltas lideradas», «cambios de líder» ni «remontada»
// por posición en carrera: en una sprint por tandas quien aún no ha corrido va
// al fondo y sube de golpe, así que medirían el orden de las tandas, no a los
// pilotos. La remontada solo se mide contra la parrilla de la pole.
//
// entities: en orden de clasificación final
//   [{ key, name, consistency, consistencyStdMs, exitCount,
//      perLane: [{ lane, avgClean, cleanLaps }] }]
// laps: cronológicos por entidad (tanda, manga, vuelta)
//   [{ key, mangaId, tanda, manga, lane, isExit, isPitStop }]
// pole: [{ name, pos }] o null

const MIN_LANE_LAPS = 5;
const MAX_NAMES = 3;

function buildRaceHighlights({ entities = [], laps = [], pole = null, multiTanda = false } = {}) {
  const finalPos = new Map(entities.map((e, i) => [e.key, i + 1]));
  const nameOf   = new Map(entities.map(e => [e.key, e.name]));
  const byFinal  = (a, b) => (finalPos.get(a.key) || Infinity) - (finalPos.get(b.key) || Infinity);

  let mostConsistent = null;
  for (const e of entities) {
    if (e.consistency == null) continue;
    if (!mostConsistent
        || e.consistency > mostConsistent.pct
        || (e.consistency === mostConsistent.pct
            && (e.consistencyStdMs ?? Infinity) < (mostConsistent.stdMs ?? Infinity))) {
      mostConsistent = { key: e.key, name: e.name, pct: e.consistency, stdMs: e.consistencyStdMs };
    }
  }

  const kingByLane = new Map();
  for (const e of entities) {
    for (const pl of e.perLane || []) {
      if (pl.avgClean == null || (pl.cleanLaps || 0) < MIN_LANE_LAPS) continue;
      const cur = kingByLane.get(pl.lane);
      if (!cur || pl.avgClean < cur.avgMs) kingByLane.set(pl.lane, { lane: pl.lane, key: e.key, name: e.name, avgMs: pl.avgClean });
    }
  }
  const laneKings = [...kingByLane.values()].sort((a, b) => a.lane - b.lane);

  const perManga = new Map();
  const streakOf = new Map();
  for (const l of laps) {
    if (!nameOf.has(l.key)) continue;
    const mk = `${l.key}|${l.mangaId}`;
    let m = perManga.get(mk);
    if (!m) { m = { key: l.key, tanda: l.tanda, manga: l.manga, lane: l.lane, laps: 0 }; perManga.set(mk, m); }
    m.laps++;

    // El pit-stop es una parada, no un error: ni suma ni rompe la racha.
    let s = streakOf.get(l.key);
    if (!s) { s = { cur: 0, best: 0 }; streakOf.set(l.key, s); }
    if (l.isPitStop) continue;
    if (l.isExit) { s.cur = 0; continue; }
    s.cur++;
    if (s.cur > s.best) s.best = s.cur;
  }

  let bestManga = null;
  for (const m of perManga.values()) {
    if (!bestManga || m.laps > bestManga.laps || (m.laps === bestManga.laps && byFinal(m, bestManga) < 0)) bestManga = m;
  }
  if (bestManga) bestManga = { ...bestManga, name: nameOf.get(bestManga.key), multiTanda };

  let longestStreak = null;
  for (const [key, s] of streakOf) {
    if (s.best === 0) continue;
    const c = { key, laps: s.best };
    if (!longestStreak || c.laps > longestStreak.laps || (c.laps === longestStreak.laps && byFinal(c, longestStreak) < 0)) longestStreak = c;
  }
  if (longestStreak) longestStreak.name = nameOf.get(longestStreak.key);

  let fewestExits = null;
  const withExits = entities.filter(e => e.exitCount != null);
  if (withExits.length) {
    const min = Math.min(...withExits.map(e => e.exitCount));
    const names = withExits.filter(e => e.exitCount === min).map(e => e.name);
    fewestExits = { count: min, names: names.slice(0, MAX_NAMES), more: Math.max(0, names.length - MAX_NAMES) };
  }

  let poleGain = null;
  if (pole && pole.length) {
    const polePosByName = new Map(pole.filter(p => p.pos != null).map(p => [p.name, p.pos]));
    for (const e of entities) {
      const from = polePosByName.get(e.name);
      if (from == null) continue;
      const to = finalPos.get(e.key);
      const gain = from - to;
      if (gain > 0 && (!poleGain || gain > poleGain.gain)) poleGain = { key: e.key, name: e.name, from, to, gain };
    }
  }

  const empty = !mostConsistent && !laneKings.length && !bestManga && !longestStreak && !fewestExits && !poleGain;
  return empty ? null : { mostConsistent, laneKings, bestManga, longestStreak, fewestExits, poleGain, minLaneLaps: MIN_LANE_LAPS };
}

module.exports = { buildRaceHighlights, MIN_LANE_LAPS };
