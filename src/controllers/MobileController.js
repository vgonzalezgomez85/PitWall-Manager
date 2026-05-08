const TimingService  = require('../services/TimingService');
const TrainingService = require('../services/TrainingService');
const db = require('../config/database');

const MobileController = {
  // GET /api/mobile/session
  session(req, res) {
    // ── Race manga running ───────────────────────────────────────────────────
    if (TimingService.isRunning) {
      const { laneMap, race, manga, startTime } = TimingService.session;
      const participants = Object.values(laneMap).map(l => ({
        lane:  l.lane,
        name:  l.name,
        color: l.color,
      }));
      return res.json({
        type:       'race',
        name:       race.name,
        mangaId:    manga.id,
        mangaNum:   manga.number,
        elapsedMs:  Date.now() - startTime,
        durationMs: (race.manga_duration_minutes || 5) * 60_000,
        participants,
      });
    }

    // ── Pending manga (DS hardware mode) ────────────────────────────────────
    if (TimingService._pendingSetup) {
      const { manga, race, lanes } = TimingService._pendingSetup;
      const participants = lanes
        .filter(l => !l.is_rest)
        .map(l => ({
          lane:  l.lane,
          name:  l.team_name || l.driver_name || `Lane ${l.lane}`,
          color: l.team_color || '#8b949e',
        }));
      return res.json({
        type:       'race',
        name:       race.name,
        mangaId:    manga.id,
        mangaNum:   manga.number,
        elapsedMs:  0,
        durationMs: (race.manga_duration_minutes || 5) * 60_000,
        participants,
      });
    }

    // ── Training active ──────────────────────────────────────────────────────
    if (TrainingService.isActive) {
      const lanes = TrainingService.getLanes();
      const participants = lanes.map(l => ({
        lane:  l.lane,
        name:  `Carril ${l.lane}`,
        color: l.color || '#22c55e',
      }));
      return res.json({
        type:         'training',
        name:         'Entrenamiento',
        participants,
      });
    }

    // ── Active pole session ──────────────────────────────────────────────────
    const poleSession = db
      .prepare(`SELECT ps.*, r.name as race_name
                FROM pole_sessions ps
                JOIN races r ON r.id = ps.race_id
                WHERE ps.status = 'in_progress'
                LIMIT 1`)
      .get();
    if (poleSession) {
      const entries = db
        .prepare('SELECT * FROM pole_entries WHERE pole_session_id = ? ORDER BY order_idx')
        .all(poleSession.id);
      const participants = entries.map((e, i) => ({
        lane:      poleSession.lane,
        entryId:   e.id,
        orderIdx:  e.order_idx ?? i,
        name:      e.entity_name,
        color:     '#f59e0b',
      }));
      return res.json({
        type:         'pole',
        name:         poleSession.race_name,
        poleSessionId: poleSession.id,
        participants,
      });
    }

    return res.json({ type: 'none' });
  },
};

module.exports = MobileController;
