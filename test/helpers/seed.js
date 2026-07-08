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
// Fixture mínimo para los tests de turnos de piloto: la cadena completa que
// necesita DriverShift.raceSummary() —
//   driver_profiles → teams_catalog(+members) → race → tanda → manga →
//   teams → drivers → manga_lanes
// Usa el singleton de BD, así que el test debe haber llamado antes a
// usarBdTemporal().

const db = require('../../src/config/database');

/** Crea un piloto del catálogo. */
function crearPerfil(nombre, { categoria = 'bronce', qr = null } = {}) {
  return db.prepare(
    'INSERT INTO driver_profiles (name, category, qr_code) VALUES (?, ?, ?)'
  ).run(nombre, categoria, qr).lastInsertRowid;
}

/** Equipo del catálogo con sus miembros (perfiles). */
function crearEquipoCatalogo(nombre, perfiles) {
  const teamId = db.prepare('INSERT INTO teams_catalog (name) VALUES (?)').run(nombre).lastInsertRowid;
  perfiles.forEach((p, i) => {
    db.prepare(
      'INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES (?, ?, ?, ?)'
    ).run(teamId, p.id, p.nombre, i);
  });
  return teamId;
}

/**
 * Carrera de campeonato por equipos con una manga y N carriles ocupados.
 * `equipos`: [{ nombre, pilotos: [{id, nombre}] }] — un equipo por carril.
 *
 * OJO: el nombre del equipo de carrera debe coincidir con el del equipo del
 * catálogo (`teams.name = teams_catalog.name`), que es como PitWall encadena
 * turno → perfil de piloto.
 *
 * Devuelve { raceId, tandaId, mangaId, teams: [{id, lane, drivers:[{id,name}]}] }.
 */
function crearCarreraConManga(equipos, reglas = {}) {
  const {
    circuitsConfig = [equipos.length],
    minMs = 0, maxMs = 0, maxRuns = 0, lockoutMs = 120000,
  } = reglas;

  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, lanes_count, lane_sequence, circuits_config,
                       driver_min_total_ms, driver_max_total_ms, driver_max_runs, driver_change_lockout_ms)
    VALUES (?, 'championship', 'team', ?, ?, ?, ?, ?, ?, ?)
  `).run('Test 24h', equipos.length, JSON.stringify(equipos.map((_, i) => i + 1)),
         JSON.stringify(circuitsConfig), minMs, maxMs, maxRuns, lockoutMs).lastInsertRowid;

  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)')
    .run(tandaId, raceId).lastInsertRowid;

  const teams = equipos.map((eq, i) => {
    const lane = i + 1;
    const teamId = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)')
      .run(raceId, tandaId, eq.nombre).lastInsertRowid;
    // Los `drivers` de la carrera se casan con el catálogo POR NOMBRE.
    const drivers = eq.pilotos.map(p => ({
      id: db.prepare('INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, ?)')
        .run(raceId, tandaId, teamId, p.nombre).lastInsertRowid,
      name: p.nombre,
    }));
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, ?, ?, 0)')
      .run(mangaId, lane, teamId);
    return { id: teamId, lane, drivers };
  });

  return { raceId, tandaId, mangaId, teams };
}

module.exports = { crearPerfil, crearEquipoCatalogo, crearCarreraConManga };
