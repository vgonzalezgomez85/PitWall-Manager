const db = require('../config/database');

class Driver {
  static findByRace(raceId) {
    return db.prepare(`
      SELECT d.*, t.name AS team_name, t.color AS team_color
      FROM drivers d
      LEFT JOIN teams t ON t.id = d.team_id
      WHERE d.race_id = ?
      ORDER BY d.tanda_id ASC, d.lane ASC, d.id ASC
    `).all(raceId);
  }

  static findByTanda(tandaId) {
    return db.prepare(`
      SELECT d.*, t.name AS team_name, t.color AS team_color
      FROM drivers d
      LEFT JOIN teams t ON t.id = d.team_id
      WHERE d.tanda_id = ?
      ORDER BY d.id ASC
    `).all(tandaId);
  }

  static create({ race_id, tanda_id, team_id, name, lane, car_number }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO drivers (race_id, tanda_id, team_id, name, lane, car_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(race_id, tanda_id ?? null, team_id ?? null, name, lane ?? null, car_number ?? null);
    return lastInsertRowid;
  }

  static createMany(drivers) {
    const stmt = db.prepare(`
      INSERT INTO drivers (race_id, tanda_id, team_id, name, lane, car_number)
      VALUES (@race_id, @tanda_id, @team_id, @name, @lane, @car_number)
    `);
    db.transaction((list) => { for (const d of list) stmt.run(d); })(drivers);
  }
}

module.exports = Driver;
