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

  static create({ race_id, tanda_id, name, lane, color }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO teams (race_id, tanda_id, name, lane, color)
      VALUES (?, ?, ?, ?, ?)
    `).run(race_id, tanda_id ?? null, name, lane ?? 0, color || '#e63946');
    return lastInsertRowid;
  }

  static updateLane(id, lane) {
    db.prepare('UPDATE teams SET lane = ? WHERE id = ?').run(lane, id);
  }
}

module.exports = Team;
