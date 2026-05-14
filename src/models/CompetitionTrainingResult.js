const db = require('../config/database');

class CompetitionTrainingResult {
  static save(sessionId, heatNumber, lane, participantName, bestLapMs, avgLapMs, lapCount, teamId = null, driverId = null) {
    const stmt = db.prepare(`
      INSERT INTO competition_training_results
        (session_id, heat_number, lane, participant_name, team_id, driver_id, best_lap_ms, avg_lap_ms, lap_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(sessionId, heatNumber, lane, participantName, teamId, driverId, bestLapMs, avgLapMs, lapCount);
  }

  static findBySession(sessionId) {
    const stmt = db.prepare(`
      SELECT * FROM competition_training_results
      WHERE session_id = ?
      ORDER BY heat_number, lane
    `);
    return stmt.all(sessionId);
  }

  static getHeatsForSession(sessionId) {
    const stmt = db.prepare(`
      SELECT DISTINCT heat_number FROM competition_training_results
      WHERE session_id = ?
      ORDER BY heat_number
    `);
    return stmt.all(sessionId).map(r => r.heat_number);
  }

  static clearSession(sessionId) {
    const stmt = db.prepare(`
      DELETE FROM competition_training_results WHERE session_id = ?
    `);
    return stmt.run(sessionId);
  }

  static clearAll() {
    const stmt = db.prepare(`
      DELETE FROM competition_training_results
    `);
    return stmt.run();
  }

  static getLatestByParticipant(sessionId, participantName) {
    const stmt = db.prepare(`
      SELECT * FROM competition_training_results
      WHERE session_id = ? AND participant_name = ?
      ORDER BY heat_number DESC, created_at DESC
      LIMIT 1
    `);
    return stmt.get(sessionId, participantName);
  }
}

module.exports = CompetitionTrainingResult;
