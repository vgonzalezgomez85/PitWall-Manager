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
// El snapshot del cliente Lap costaba ~266 ms POR EQUIPO Y REFRESCO sobre las
// 160.000 vueltas de una 24 h (agregado 95 + proyección 100 + pit stops 35 +
// última vuelta 36), y los 22 equipos recalculaban exactamente lo mismo. Ahora se
// calcula una vez por carrera y se reparte.
//
// Una caché que devuelve un valor distinto del que devolvía el cálculo directo es
// peor que la lentitud: el piloto ve una posición que no es la suya. Así que lo
// que se prueba aquí es la EQUIVALENCIA contra una reimplementación literal de las
// consultas viejas, equipo a equipo, y la INVALIDACIÓN.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db            = require('../src/config/database');
const Lap           = require('../src/models/Lap');
const TimingService = require('../src/services/TimingService');
const LapController = require('../src/controllers/LapController');

after(limpiarBdTemporal);

beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'teams', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
  TimingService.session = null;
  TimingService.invalidateStandingsCaches();
  LapController._resetCaches();
});

// ── La vía vieja, tal cual era ───────────────────────────────────────────────
//
// Copia literal de las consultas que hacía `_buildTeamSnapshot` antes de la
// caché: un escaneo completo de la carrera por equipo y refresco. Es el patrón
// oro contra el que se compara la vía rápida.

function snapshotViejo(race, team) {
  const name = team.name;
  const agg = Lap.aggregateByRace(race.id);
  const byName = {};
  agg.forEach(r => {
    let g = byName[r.entity_name];
    if (!g) g = byName[r.entity_name] = {
      name: r.entity_name, color: r.color, total_laps: 0, total_time_ms: 0,
      best_lap_ms: null, exit_count: 0, mangas_raced: 0, _avgNum: 0, _avgDen: 0,
    };
    g.total_laps    += r.total_laps || 0;
    g.total_time_ms += r.total_time_ms || 0;
    g.exit_count    += r.exit_count || 0;
    g.mangas_raced  += r.mangas_raced || 0;
    if (r.best_lap_ms != null && (g.best_lap_ms == null || r.best_lap_ms < g.best_lap_ms)) g.best_lap_ms = r.best_lap_ms;
    if (r.avg_lap_ms != null) { g._avgNum += r.avg_lap_ms * (r.total_laps || 0); g._avgDen += (r.total_laps || 0); }
    if (!g.color && r.color) g.color = r.color;
  });
  const groups = Object.values(byName).map(g => ({
    name: g.name, color: g.color, total_laps: g.total_laps, total_time_ms: g.total_time_ms,
    best_lap_ms: g.best_lap_ms, exit_count: g.exit_count, mangas_raced: g.mangas_raced,
    avg_lap_ms: g._avgDen > 0 ? g._avgNum / g._avgDen : null,
  }));
  groups.sort((a, b) => (b.total_laps - a.total_laps) || ((a.total_time_ms || 0) - (b.total_time_ms || 0)));
  const idx = groups.findIndex(g => g.name === name);
  const row = idx >= 0 ? groups[idx] : null;
  const leader = groups[0] || null;
  const ahead  = idx > 0 ? groups[idx - 1] : null;

  const pitStops = db.prepare(`
    SELECT COALESCE(SUM(l.is_pit_stop), 0) AS pits
    FROM laps l JOIN teams t ON t.id = l.team_id
    WHERE l.race_id = ? AND t.name = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
  `).get(race.id, name).pits;

  const lastRow = db.prepare(`
    SELECT l.lap_time_ms FROM laps l JOIN teams t ON t.id = l.team_id
    WHERE l.race_id = ? AND t.name = ? AND l.is_ghost = 0 AND l.is_warmup = 0 AND l.lap_number > 0
    ORDER BY l.id DESC LIMIT 1
  `).get(race.id, name);

  return {
    teamsTotal: db.prepare('SELECT COUNT(DISTINCT name) AS c FROM teams WHERE race_id = ?').get(race.id).c,
    leader: leader ? { name: leader.name, totalLaps: leader.total_laps } : null,
    timing: {
      position:       row ? idx + 1 : null,
      totalLaps:      row ? row.total_laps : 0,
      gapLaps:        (row && leader) ? (leader.total_laps - row.total_laps) : 0,
      gapToAheadLaps: (row && ahead) ? (ahead.total_laps - row.total_laps) : null,
      bestLapMs:      row ? row.best_lap_ms : null,
      avgLapMs:       row && row.avg_lap_ms != null ? Math.round(row.avg_lap_ms) : null,
      lastLapMs:      lastRow ? lastRow.lap_time_ms : null,
      totalTimeMs:    row ? row.total_time_ms : null,
      mangasRaced:    row ? row.mangas_raced : 0,
      pitStops,
      exitCount:      row ? row.exit_count : 0,
    },
  };
}

/** Lo comparable entre las dos vías (`updatedAt` es Date.now()). */
const comparable = (s) => ({ teamsTotal: s.teamsTotal, leader: s.leader, timing: s.timing });

const _paquete = (race) => LapController._bundleOf(race.id);
const RACE_BUNDLE_TTL_MS_TEST = LapController._BUNDLE_TTL_MS;

// ── Fixture ──────────────────────────────────────────────────────────────────

function crearCarrera({ lanes = 3 } = {}) {
  return db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('lap', 'club', 'team', 'active', ?, '[1,2,3]', '[3]', 10, 0, 0, 0, 0)
  `).run(lanes).lastInsertRowid;
}

/**
 * Carrera de resistencia con los casos que el snapshot distingue: warmup, ghost,
 * salidas, pit stops, un equipo que descansa una manga y otro que llega tarde.
 *
 * Con equipos DUPLICADOS POR TANDA: una fila de `teams` por equipo y tanda, con
 * el mismo nombre y distinto id, que es como quedan las carreras con varias
 * tandas. Las vueltas cuelgan de la fila de su tanda, así que agrupar por
 * team_id daría 0 vueltas: es el caso que obliga a agrupar por NOMBRE, y el que
 * rompería en silencio si alguien "simplifica" el agrupado.
 */
function carreraResistencia() {
  const raceId = crearCarrera();
  const nombres = ['Alfa', 'Beta', 'Gamma'];
  const tandas = [1, 2].map(n =>
    db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, n).lastInsertRowid);

  // Una fila de equipo por (nombre, tanda) — ids distintos, mismo nombre.
  const filas = {};
  tandas.forEach((tandaId) => {
    nombres.forEach((n, i) => {
      const id = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, 0, ?)')
        .run(raceId, tandaId, n, '#0' + i + '0000').lastInsertRowid;
      (filas[n] = filas[n] || []).push(id);
    });
  });

  const mangas = [];
  tandas.forEach((tandaId, ti) => {
    [1, 2].forEach(n => {
      mangas.push({
        id: db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)').run(tandaId, raceId, n).lastInsertRowid,
        tanda: ti,
      });
    });
  });

  let n = 0;
  const mk = (mangaId, teamId, ms, extra = {}) => Lap.create({
    race_id: raceId, manga_id: mangaId, team_id: teamId, driver_id: null,
    lane: 1, lap_number: ++n, lap_time_ms: ms, elapsed_ms: n * ms, ...extra,
  });

  mangas.forEach((m, mi) => {
    nombres.forEach((nombre, ti) => {
      const teamId = filas[nombre][m.tanda];
      // Gamma descansa la 2ª manga: ni carril ni vueltas.
      const descansa = (nombre === 'Gamma' && mi === 1);
      db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?, ?, ?, ?, ?)')
        .run(m.id, ti + 1, teamId, descansa ? 1 : 0, descansa ? 0 : 0.1 * (mi + 1) * (ti + 1));
      if (descansa) return;

      mk(m.id, teamId, 9000 + ti * 100, { lap_number: 1, is_warmup: 1 });  // fuera de la media
      mk(m.id, teamId, 8500 + ti * 50);                                     // vuelta buena
      mk(m.id, teamId, 11000, { is_pit_stop: 1 });                          // parada en boxes
      mk(m.id, teamId, 12000, { is_exit: 1 });                              // salida de pista
      mk(m.id, teamId, 100, { is_ghost: 1 });                               // fantasma: se ignora
      if (mi === 0 && ti === 0) mk(m.id, teamId, 8200);                     // mejor vuelta
    });
  });

  const equipos = nombres.map(nombre => ({
    id: filas[nombre][0], name: nombre, race_id: raceId, color: null,
  }));
  return { race: { id: raceId, name: 'lap', status: 'active' }, equipos, mangas, filas };
}

// ── Equivalencia ─────────────────────────────────────────────────────────────

test('el snapshot cacheado da lo MISMO que el cálculo directo, equipo a equipo', () => {
  const { race, equipos } = carreraResistencia();
  for (const team of equipos) {
    assert.deepEqual(
      comparable(LapController._buildTeamSnapshot(race, team)),
      comparable(snapshotViejo(race, team)),
      `el equipo ${team.name} debe ver exactamente lo mismo que con la vía lenta`);
  }
});

test('los equipos duplicados por tanda siguen sumando sus vueltas de TODAS las tandas', () => {
  const { race, equipos, filas } = carreraResistencia();
  const alfa = equipos.find(e => e.name === 'Alfa');
  const snap = LapController._buildTeamSnapshot(race, alfa);

  assert.ok(filas['Alfa'].length > 1, 'el fixture tiene a Alfa duplicado por tanda');
  assert.ok(snap.timing.totalLaps > 0, 'agrupar por team_id daría 0 vueltas aquí');

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM laps l JOIN teams t ON t.id = l.team_id
    WHERE l.race_id = ? AND t.name = 'Alfa' AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
  `).get(race.id).c;
  assert.equal(snap.timing.totalLaps, total, 'suma las vueltas de sus dos filas de equipo');
});

test('los pit stops que ahora salen del agregado cuadran con contarlos a mano', () => {
  const { race, equipos } = carreraResistencia();
  for (const team of equipos) {
    const aMano = db.prepare(`
      SELECT COALESCE(SUM(l.is_pit_stop), 0) AS pits FROM laps l JOIN teams t ON t.id = l.team_id
      WHERE l.race_id = ? AND t.name = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
    `).get(race.id, team.name).pits;
    assert.ok(aMano > 0, `${team.name} tiene paradas en el fixture`);
    assert.equal(LapController._buildTeamSnapshot(race, team).timing.pitStops, aMano);
  }
});

test('un equipo que descansó una manga cuenta bien sus mangas y su última vuelta', () => {
  const { race, equipos } = carreraResistencia();
  const gamma = equipos.find(e => e.name === 'Gamma');
  const snap = LapController._buildTeamSnapshot(race, gamma);
  assert.deepEqual(comparable(snap), comparable(snapshotViejo(race, gamma)));
  assert.equal(snap.timing.mangasRaced, 3, 'corrió 3 de las 4 mangas');
});

// ── Invalidación ─────────────────────────────────────────────────────────────

test('un cruce nuevo se ve al instante: la caché no puede servir un valor rancio', () => {
  const { race, equipos, mangas, filas } = carreraResistencia();
  const alfa = equipos.find(e => e.name === 'Alfa');
  const antes = LapController._buildTeamSnapshot(race, alfa).timing.totalLaps;

  Lap.create({
    race_id: race.id, manga_id: mangas[0].id, team_id: filas['Alfa'][0], driver_id: null,
    lane: 1, lap_number: 99, lap_time_ms: 8400, elapsed_ms: 100000,
  });

  assert.equal(LapController._buildTeamSnapshot(race, alfa).timing.totalLaps, antes + 1,
    'el contador de mutaciones de Lap tira el paquete en cuanto entra una vuelta');
});

test('corregir una vuelta se ve al instante', () => {
  const { race, equipos } = carreraResistencia();
  const alfa = equipos.find(e => e.name === 'Alfa');
  LapController._buildTeamSnapshot(race, alfa);

  const id = db.prepare(`SELECT l.id FROM laps l JOIN teams t ON t.id = l.team_id
    WHERE t.name = 'Alfa' AND l.is_ghost = 0 AND l.is_warmup = 0 ORDER BY l.lap_time_ms ASC LIMIT 1`).get().id;
  Lap.updateTime(id, 7000);

  assert.equal(LapController._buildTeamSnapshot(race, alfa).timing.bestLapMs, 7000);
});

test('sin manga en curso el paquete NO caduca: nada se mueve solo', () => {
  const { race, equipos } = carreraResistencia();   // ninguna manga con started_at
  LapController._buildTeamSnapshot(race, equipos[0]);

  let recalculos = 0;
  const original = TimingService.raceAggregate.bind(TimingService);
  TimingService.raceAggregate = (id) => { recalculos++; return original(id); };
  try {
    // Envejecemos el paquete mucho más allá del TTL.
    _paquete(race).ts -= 60_000;
    LapController._buildTeamSnapshot(race, equipos[0]);
  } finally { TimingService.raceAggregate = original; }

  assert.equal(recalculos, 0,
    'entre mangas no entra ni una vuelta: caducar por tiempo era un escaneo de 230 ms por segundo para nada');
});

test('con una manga en curso el paquete SÍ caduca: la proyección cuenta el tiempo', () => {
  const { race, equipos, mangas } = carreraResistencia();
  db.prepare("UPDATE mangas SET status = 'active', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), mangas[mangas.length - 1].id);
  LapController._buildTeamSnapshot(race, equipos[0]);

  let recalculos = 0;
  const original = TimingService.raceAggregate.bind(TimingService);
  TimingService.raceAggregate = (id) => { recalculos++; return original(id); };
  try {
    _paquete(race).ts -= RACE_BUNDLE_TTL_MS_TEST + 10;
    LapController._buildTeamSnapshot(race, equipos[0]);
  } finally { TimingService.raceAggregate = original; }

  assert.equal(recalculos, 1, 'con manga viva el restante se mueve solo: hay que refrescar');
});

test('dentro del TTL y sin mutaciones, el paquete se reparte sin recalcular', () => {
  const { race, equipos } = carreraResistencia();
  LapController._buildTeamSnapshot(race, equipos[0]);

  let recalculos = 0;
  const original = TimingService.raceAggregate.bind(TimingService);
  TimingService.raceAggregate = (id) => { recalculos++; return original(id); };
  try {
    for (const team of equipos) LapController._buildTeamSnapshot(race, team);
  } finally { TimingService.raceAggregate = original; }

  assert.equal(recalculos, 0, 'los 3 equipos comparten el paquete: 0 agregados extra');
});

// ── La fila sintética "null" ─────────────────────────────────────────────────

test('las vueltas de carriles sin equipo no compiten como un equipo más', () => {
  const { race, equipos, mangas } = carreraResistencia();
  // Un carril sin equipo asignado dando muchísimas vueltas: `aggregateByRace` las
  // junta en una fila con entity_id null. Sin filtrar, salía "líder" y falseaba
  // el gap de todo el mundo.
  for (let i = 0; i < 50; i++) {
    Lap.create({
      race_id: race.id, manga_id: mangas[0].id, team_id: null, driver_id: null,
      lane: 8, lap_number: i + 1, lap_time_ms: 5000, elapsed_ms: i * 5000,
    });
  }

  const snap = LapController._buildTeamSnapshot(race, equipos[0]);
  assert.ok(snap.leader, 'hay líder');
  assert.ok(equipos.some(e => e.name === snap.leader.name),
    `el líder debe ser un equipo de verdad, no la fila sintética (salió ${JSON.stringify(snap.leader)})`);
  assert.equal(snap.timing.position, 1, 'Alfa sigue siendo el primero');
  assert.equal(snap.timing.gapLaps, 0, 'y su gap al líder no lo inventa un carril fantasma');
});

// ── La última vuelta ─────────────────────────────────────────────────────────
//
// Ya no se busca con una consulta por equipo (un escaneo de la carrera entera,
// 36 ms cada uno): el agregado trae el ID de la última vuelta de cada entidad y su
// tiempo se resuelve por clave primaria. Como el id viaja en `_aggRaw`, hereda el
// troceado y la caché de las mangas anteriores sin pagar un escaneo extra.

test('la última vuelta es la del id mayor, y viene del agregado', () => {
  const { race, equipos, mangas, filas } = carreraResistencia();
  const alfa = equipos.find(e => e.name === 'Alfa');

  // La vía vieja la buscaba con ORDER BY id DESC LIMIT 1; debe coincidir.
  assert.equal(LapController._buildTeamSnapshot(race, alfa).timing.lastLapMs,
               snapshotViejo(race, alfa).timing.lastLapMs);

  Lap.create({
    race_id: race.id, manga_id: mangas[mangas.length - 1].id, team_id: filas['Alfa'][1],
    driver_id: null, lane: 1, lap_number: 50, lap_time_ms: 7777, elapsed_ms: 500000,
  });
  assert.equal(LapController._buildTeamSnapshot(race, alfa).timing.lastLapMs, 7777,
    'la vuelta más reciente manda');
});

test('la última vuelta ignora warmups y fantasmas, como la vía vieja', () => {
  const { race, equipos, mangas, filas } = carreraResistencia();
  const alfa = equipos.find(e => e.name === 'Alfa');
  const ultima = mangas[mangas.length - 1].id;
  const antes = LapController._buildTeamSnapshot(race, alfa).timing.lastLapMs;

  // Las dos son posteriores a todo, pero ninguna puede ser "la última vuelta".
  Lap.create({ race_id: race.id, manga_id: ultima, team_id: filas['Alfa'][1], driver_id: null,
    lane: 1, lap_number: 60, lap_time_ms: 1111, elapsed_ms: 600000, is_warmup: 1 });
  Lap.create({ race_id: race.id, manga_id: ultima, team_id: filas['Alfa'][1], driver_id: null,
    lane: 1, lap_number: 61, lap_time_ms: 2222, elapsed_ms: 610000, is_ghost: 1 });

  const despues = LapController._buildTeamSnapshot(race, alfa).timing.lastLapMs;
  assert.equal(despues, antes, 'ni la warmup ni el fantasma cuentan');
  assert.equal(despues, snapshotViejo(race, alfa).timing.lastLapMs, 'y coincide con la vía vieja');
});

test('el id de la última vuelta sobrevive a la fusión de mangas del troceado', () => {
  const { race, mangas } = carreraResistencia();
  const viva = mangas[mangas.length - 1].id;
  const directo = Lap.aggregateByRace(race.id);
  const split = Lap.aggregateByRaceSplit(race.id, viva, Lap._aggRaw(race.id, { excludeManga: viva }));
  assert.deepEqual(split, directo, 'incluye last_lap_id: el troceado no puede perder la última vuelta');
});
