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
// Pilotos dentro de cada equipo (resistencias). PURO.
//
// Las vueltas de un equipo no llevan piloto: quién conducía lo dicen los turnos
// del fichaje QR (driver_shifts). Cada vuelta va al último turno del mismo
// (manga, equipo) que había empezado cuando se cruzó la meta, comparando
// RELOJ con RELOJ (hora real del cruce frente a started_at_ms): así no influyen
// las pausas, que sí descuadran el transcurrido de la manga. Sin turno, o antes
// del primero de la manga (fichaje tardío), la vuelta queda «sin fichar».
// No se usa el carril: en la 24 h real de Llinars el turno quedó apuntado a veces
// en el carril de la manga siguiente; el equipo sí es fiable y en resistencia
// corre un solo carril por manga.
//
// Mismas reglas que el total del equipo (Lap.aggregateByRace), para que las
// vueltas de los pilotos sumen exactamente las del equipo:
//   · vueltas: todas las no fantasma (salidas y pit-stops incluidos);
//   · mejor: sin salidas, sin cruce de salida, desde la vuelta 2 y sin repuestas;
//   · media: sin cruce de salida (con salidas/pits, como la media del equipo);
//   · consistencia: la de la Comparativa (sin salidas, desde la vuelta 2, ≥ Pt).
const { robustConsistency, MIN_CONSISTENCY_LAPS } = require('./consistency');

// Margen del cruce: la hora de la vuelta se guarda al segundo y la del turno al ms.
const TS_SLACK_MS = 999;

// Quién conducía cada vuelta de un equipo. Devuelve (lap) → nombre | null.
// La usan esta pestaña y la Progresión, para que no puedan dar pilotos distintos.
function makeDriverResolver(shifts) {
  const cells = new Map();   // `manga|team` → turnos activados, por hora de inicio
  for (const s of shifts) {
    if (s.team_id == null || !s.driver_name || s.started_at_ms == null) continue;
    const k = `${s.manga_id}|${s.team_id}`;
    let list = cells.get(k);
    if (!list) { list = []; cells.set(k, list); }
    list.push(s);
  }
  for (const list of cells.values()) list.sort((x, y) => x.started_at_ms - y.started_at_ms);

  return (l) => {
    if (l.driver_name) return l.driver_name;
    const list = cells.get(`${l.manga_id}|${l.team_id}`);
    if (!list) return null;
    if (l.ts_ms == null) return list[0].driver_name;
    // Antes del primer fichaje (alguien fichó tarde) no conducía nadie «oficialmente»:
    // esas vueltas quedan sin fichar, igual que su tiempo no cuenta al volante.
    let pick = null;
    for (const s of list) { if (s.started_at_ms <= l.ts_ms + TS_SLACK_MS) pick = s; else break; }
    return pick ? pick.driver_name : null;
  };
}

// CURRENT_TIMESTAMP de SQLite: UTC sin zona. Sin la «Z», JS la leería como hora local.
function sqliteUtcMs(ts) {
  return ts ? Date.parse(String(ts).replace(' ', 'T') + 'Z') : null;
}

/**
 * @param {object}   p
 * @param {object[]} p.laps    {manga_id, team_id, lap_number, lap_time_ms, ts_ms,
 *                              is_exit, is_pit_stop, is_warmup, is_estimated, driver_name?}
 * @param {object[]} p.shifts  {manga_id, team_id, driver_name, started_at_ms, driving_ms}
 * @param {number}   [p.minLapMs]  Pt de la carrera (para la consistencia)
 * @returns {{ teams: Map<number, {drivers: object[], unassigned: object|null}>,
 *             mangasWithShifts: number, mangasRaced: number }}
 */
function buildDriverStats({ laps, shifts, minLapMs = 0 }) {
  const resolve = makeDriverResolver(shifts);
  const acc   = new Map();   // team → Map(driverName|'' → acumulador)
  const mangasWithShifts = new Set();

  const bucket = (teamId, name) => {
    let team = acc.get(teamId);
    if (!team) { team = new Map(); acc.set(teamId, team); }
    let a = team.get(name);
    if (!a) {
      a = { name, drivingMs: 0, mangas: new Set(), laps: 0, bestMs: null,
            sumMs: 0, nAvg: 0, clean: [], exits: 0, pits: 0 };
      team.set(name, a);
    }
    return a;
  };

  for (const s of shifts) {
    if (s.team_id == null || !s.driver_name) continue;
    const a = bucket(s.team_id, s.driver_name);
    a.drivingMs += s.driving_ms || 0;
    if ((s.driving_ms || 0) > 0) a.mangas.add(s.manga_id);
    if (s.started_at_ms != null) mangasWithShifts.add(s.manga_id);
  }

  const mangasRaced = new Set();
  for (const l of laps) {
    if (l.team_id == null) continue;
    mangasRaced.add(l.manga_id);
    const name = resolve(l) || '';
    const a = bucket(l.team_id, name);
    a.laps++;
    if (l.is_exit) a.exits++;
    if (l.is_pit_stop) a.pits++;
    if (!l.is_warmup) { a.sumMs += l.lap_time_ms; a.nAvg++; }
    const bestable = !l.is_exit && !l.is_warmup && !l.is_estimated && l.lap_number > 1;
    if (bestable && (a.bestMs == null || l.lap_time_ms < a.bestMs)) a.bestMs = l.lap_time_ms;
    if (!l.is_exit && !l.is_warmup && l.lap_number > 1 && l.lap_time_ms >= minLapMs) a.clean.push(l.lap_time_ms);
  }

  const teams = new Map();
  for (const [teamId, byName] of acc) {
    const out = { drivers: [], unassigned: null };
    for (const a of byName.values()) {
      const c = robustConsistency(a.clean, MIN_CONSISTENCY_LAPS);
      const row = {
        name:        a.name,
        drivingMs:   a.drivingMs,
        mangas:      a.mangas.size,
        laps:        a.laps,
        lapsPerHour: a.drivingMs > 0 ? a.laps / (a.drivingMs / 3600000) : null,
        bestMs:      a.bestMs,
        avgMs:       a.nAvg ? a.sumMs / a.nAvg : null,
        consistency: c ? c.pct : null,
        consistencyLevel: c ? c.level : null,
        exits:       a.exits,
        pits:        a.pits,
      };
      if (a.name === '') { if (row.laps > 0) out.unassigned = row; }
      else out.drivers.push(row);
    }
    out.drivers.sort((x, y) => (y.drivingMs - x.drivingMs) || (y.laps - x.laps) || x.name.localeCompare(y.name));
    teams.set(teamId, out);
  }
  return { teams, mangasWithShifts: mangasWithShifts.size, mangasRaced: mangasRaced.size };
}

module.exports = { buildDriverStats, makeDriverResolver, sqliteUtcMs };
