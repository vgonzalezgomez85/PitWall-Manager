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
const db = require('../config/database');

class Team {
  static findByRace(raceId) {
    return db.prepare(`
      SELECT t.*, GROUP_CONCAT(d.name, ', ') AS member_names, COUNT(d.id) AS member_count
      FROM teams t
      LEFT JOIN drivers d ON d.team_id = t.id
      WHERE t.race_id = ?
      GROUP BY t.id
      ORDER BY t.tanda_id ASC, t.lane ASC
    `).all(raceId);
  }

  static findByTanda(tandaId) {
    return db.prepare(`
      SELECT t.*, GROUP_CONCAT(d.name, ', ') AS member_names, COUNT(d.id) AS member_count
      FROM teams t
      LEFT JOIN drivers d ON d.team_id = t.id
      WHERE t.tanda_id = ?
      GROUP BY t.id
      ORDER BY t.id ASC
    `).all(tandaId);
  }

  static findByTandaWithMembers(tandaId) {
    const teams = db.prepare('SELECT * FROM teams WHERE tanda_id = ? ORDER BY id ASC').all(tandaId);
    return teams.map(t => ({
      ...t,
      members: db.prepare('SELECT id, name FROM drivers WHERE team_id = ? ORDER BY id ASC').all(t.id)
    }));
  }

  static create({ race_id, tanda_id, name, lane, color, country }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO teams (race_id, tanda_id, name, lane, color, country)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(race_id, tanda_id ?? null, name, lane ?? 0, color || '#e63946', country ?? null);
    return lastInsertRowid;
  }

  static updateLane(id, lane) {
    db.prepare('UPDATE teams SET lane = ? WHERE id = ?').run(lane, id);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  }

  // ── Acceso "Lap" (cliente web del equipo) ──────────────────────────────────
  // Cada equipo de una carrera tiene un PIN de 4 dígitos para entrar a su panel
  // de timing en vivo desde el móvil. No es seguridad fuerte (igual que el resto
  // del acceso de PitWall): evita que un equipo abra por error el panel de otro.

  // Lista equipos de la carrera con su PIN, generando los que falten. Se
  // deduplica por NOMBRE: algunas carreras tienen varias filas por equipo (una
  // "maestra" + una por tanda); para el cliente Lap basta una por nombre (la de
  // menor id, canónica). El timing se agrega por nombre en LapController.
  static withLapPins(raceId) {
    Team.ensureLapPins(raceId);
    return db.prepare(`
      SELECT id, name, color, lap_pin FROM teams
      WHERE race_id = ? AND id IN (SELECT MIN(id) FROM teams WHERE race_id = ? GROUP BY name)
      ORDER BY name ASC
    `).all(raceId, raceId);
  }

  // Asigna un PIN único (dentro de la carrera) a cada equipo que no tenga uno.
  static ensureLapPins(raceId) {
    const teams = db.prepare("SELECT id FROM teams WHERE race_id = ? AND (lap_pin IS NULL OR lap_pin = '')").all(raceId);
    if (teams.length === 0) return;
    const used = new Set(
      db.prepare('SELECT lap_pin FROM teams WHERE race_id = ? AND lap_pin IS NOT NULL').all(raceId).map(r => r.lap_pin)
    );
    const upd = db.prepare('UPDATE teams SET lap_pin = ? WHERE id = ?');
    for (const t of teams) {
      let pin;
      do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(pin));
      used.add(pin);
      upd.run(pin, t.id);
    }
  }

  // Devuelve el equipo si el PIN coincide; null si no.
  static verifyLapPin(raceId, teamId, pin) {
    const t = db.prepare('SELECT * FROM teams WHERE id = ? AND race_id = ?').get(teamId, raceId);
    if (!t) return null;
    return (t.lap_pin && String(pin).trim() === String(t.lap_pin)) ? t : null;
  }

  static regenerateLapPin(raceId, teamId) {
    const used = new Set(
      db.prepare('SELECT lap_pin FROM teams WHERE race_id = ? AND lap_pin IS NOT NULL').all(raceId).map(r => r.lap_pin)
    );
    let pin;
    do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(pin));
    db.prepare('UPDATE teams SET lap_pin = ? WHERE id = ? AND race_id = ?').run(pin, teamId, raceId);
    return pin;
  }
}

module.exports = Team;
