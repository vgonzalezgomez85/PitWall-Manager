// Vista de control de pilotos por QR (Fase 2 del feature de turnos).
//
// /control/shifts → vista live para el operador con lector QR USB.
//   - Auto-detecta la manga "actual" (championship + pending|active).
//   - Si no hay ninguna, muestra estado vacío con auto-refresh por socket.
//   - El POST de scan va al endpoint estándar:
//       POST /races/:raceId/mangas/:mangaId/checkin
//     ya implementado en SessionController.driverCheckin.

const Race          = require('../models/Race');
const Manga         = require('../models/Manga');
const DriverShift   = require('../models/DriverShift');
const TimingService = require('../services/TimingService');
const db            = require('../config/database');

class ControlController {

  // Detecta la manga "actual" para escaneo: prioridad TimingService activo,
  // luego cualquier manga active/pending de una carrera championship activa.
  static _detectCurrentManga() {
    // 1) Manga viva en TimingService
    if (TimingService.session && TimingService.session.race && TimingService.session.race.type === 'championship') {
      return {
        manga: TimingService.session.manga,
        race:  TimingService.session.race,
        liveStatus: TimingService.isPaused ? 'paused' : 'running',
      };
    }

    // 2) Buscar en BD: race championship + status='active', manga active o pending
    const row = db.prepare(`
      SELECT m.id AS manga_id, m.number AS manga_number, m.status AS manga_status,
             m.tanda_id, r.id AS race_id, r.name AS race_name, r.type, r.format,
             r.manga_duration_minutes, r.driver_min_total_ms, r.driver_max_total_ms,
             r.driver_change_lockout_ms
      FROM mangas m
      JOIN races r ON r.id = m.race_id
      WHERE r.type = 'championship'
        AND r.format = 'team'
        AND r.status = 'active'
        AND m.status IN ('active', 'pending')
      ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.id ASC
      LIMIT 1
    `).get();

    if (!row) return null;

    return {
      manga: { id: row.manga_id, number: row.manga_number, status: row.manga_status, tanda_id: row.tanda_id, race_id: row.race_id },
      race:  {
        id: row.race_id, name: row.race_name, type: row.type, format: row.format,
        manga_duration_minutes: row.manga_duration_minutes,
        driver_min_total_ms: row.driver_min_total_ms,
        driver_max_total_ms: row.driver_max_total_ms,
        driver_change_lockout_ms: row.driver_change_lockout_ms,
      },
      liveStatus: row.manga_status === 'active' ? 'unknown' : 'standby',
    };
  }

  // GET /control/shifts
  static live(req, res) {
    const current = ControlController._detectCurrentManga();
    if (!current) {
      return res.render('control/shifts-live', {
        t: req.t,
        current:  null,
        lanes:    [],
        shifts:   [],
        summary:  [],
        history:  [],
      });
    }
    const { manga, race, liveStatus } = current;

    // Carriles de la manga (sin descansos)
    const lanes = Manga.getLanes(manga.id).filter(l => !l.is_rest);

    // Shifts abiertos por carril (lo que está sonando ahora mismo)
    const openShifts = DriverShift.findAllOpenByManga(manga.id);
    const openByLane = {};
    openShifts.forEach(s => { openByLane[s.lane] = s; });

    // Snapshot in-memory de TimingService (driving_ms al segundo, no de BD)
    const liveActive = TimingService.activeMangaId === manga.id
      ? TimingService.getActiveShifts()
      : {};

    // Histórico completo de la manga para construir lane history (cuántos shifts
    // por carril, lista en cards laterales)
    const history = DriverShift.historyByManga(manga.id);

    // Resumen por piloto a nivel CARRERA (suma de todas las mangas previas + esta)
    const summary = DriverShift.raceSummary(race.id);

    res.render('control/shifts-live', {
      t: req.t,
      current: { manga, race, liveStatus },
      lanes,
      openByLane,
      liveActive,   // { lane → { shiftId, drivingMs } }
      history,
      summary,
    });
  }

  // GET /races/:id/shifts — vista histórica por carrera
  static raceHistory(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (race.type !== 'championship') {
      return res.render('control/race-shifts', { t: req.t, race, notChampionship: true, mangas: [], summary: [] });
    }

    // Resumen por piloto a nivel CARRERA
    const summary = DriverShift.raceSummary(race.id);

    // Para cada manga de la carrera, sus shifts (cronología)
    const mangas = db.prepare(`
      SELECT m.id, m.number, m.status, m.tanda_id, t.number AS tanda_number
      FROM mangas m
      LEFT JOIN tandas t ON t.id = m.tanda_id
      WHERE m.race_id = ?
      ORDER BY m.id ASC
    `).all(race.id);

    mangas.forEach(m => {
      m.shifts = DriverShift.historyByManga(m.id);
    });

    res.render('control/race-shifts', { t: req.t, race, notChampionship: false, mangas, summary });
  }
}

module.exports = ControlController;
