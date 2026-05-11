const db = require('../config/database');

class DriverShift {
  // Get current active driver per lane for a manga
  static currentByManga(mangaId) {
    return db.prepare(`
      SELECT ds.*
      FROM driver_shifts ds
      INNER JOIN (
        SELECT lane, MAX(id) AS max_id
        FROM driver_shifts WHERE manga_id = ?
        GROUP BY lane
      ) latest ON ds.id = latest.max_id
    `).all(mangaId);
  }

  // Register a driver check-in for a lane
  static checkin({ mangaId, raceId, lane, teamId, driverId, driverName }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO driver_shifts (manga_id, race_id, lane, team_id, driver_id, driver_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(mangaId, raceId, lane, teamId || null, driverId || null, driverName);
    return lastInsertRowid;
  }

  // Find driver profile by QR code
  static findProfileByQR(qrCode) {
    return db.prepare('SELECT * FROM driver_profiles WHERE qr_code = ?').get(qrCode);
  }

  // Find which lane a driver_profile is assigned to in a given manga
  // (looks up via teams_catalog_members → teams → manga_lanes)
  static findLaneForProfile(profileId, mangaId) {
    return db.prepare(`
      SELECT ml.lane, ml.team_id, d.id AS driver_id, d.name AS driver_name
      FROM manga_lanes ml
      JOIN teams t ON t.id = ml.team_id
      JOIN drivers d ON d.team_id = t.id
      JOIN teams_catalog_members tcm ON tcm.driver_id = ?
      JOIN teams_catalog tc ON tc.id = (
        SELECT tc2.id FROM teams_catalog tc2
        JOIN teams_catalog_members tcm2 ON tcm2.team_id = tc2.id
        WHERE tcm2.driver_id = ?
        LIMIT 1
      )
      WHERE ml.manga_id = ? AND ml.is_rest = 0
        AND t.name = tc.name
      LIMIT 1
    `).get(profileId, profileId, mangaId);
  }

  // Simpler lookup: given a driver_profile_id, find the race driver + team + lane for this manga
  static findAssignmentByProfile(profileId, mangaId) {
    return db.prepare(`
      SELECT d.id AS driver_id, d.name AS driver_name,
             d.team_id, d.lane,
             ml.lane AS manga_lane
      FROM drivers d
      JOIN manga_lanes ml ON ml.team_id = d.team_id AND ml.manga_id = ?
      JOIN teams_catalog_members tcm ON tcm.name = d.name AND tcm.driver_id = ?
      WHERE ml.is_rest = 0
      LIMIT 1
    `).get(mangaId, profileId);
  }

  static historyByManga(mangaId) {
    return db.prepare(`
      SELECT * FROM driver_shifts WHERE manga_id = ? ORDER BY started_at ASC
    `).all(mangaId);
  }
}

module.exports = DriverShift;
