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
             r.driver_change_lockout_ms, r.driver_max_runs
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
        driver_max_runs: row.driver_max_runs,
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
        rosterByLane: {},
        restingTeams: [],
        mangaDurationMs: 0,
      });
    }
    const { manga, race, liveStatus } = current;

    // Carriles de la manga: los que corren (sin descanso) y los que descansan.
    const allLanes = Manga.getLanes(manga.id);
    const lanes = allLanes.filter(l => !l.is_rest);

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

    // Resumen por piloto a nivel CARRERA. Incluimos a TODOS los pilotos de la
    // carrera (no solo a quien ya tiene turnos), para que en standby/pre-arme la
    // lista salga completa con 0:00 y se vaya actualizando al correr.
    const shiftSummary = DriverShift.raceSummary(race.id);
    const byProfileId = {};
    shiftSummary.forEach(r => { byProfileId[r.profile_id] = r; });
    const allPilots = db.prepare(`
      SELECT DISTINCT dp.id AS profile_id, dp.name AS profile_name, dp.category AS profile_category
      FROM drivers d
      JOIN teams_catalog_members tcm ON tcm.name = d.name
      JOIN driver_profiles dp        ON dp.id = tcm.driver_id
      WHERE d.race_id = ?
    `).all(race.id);
    const summary = allPilots.map(p => {
      const r = byProfileId[p.profile_id];
      return {
        profile_id:       p.profile_id,
        profile_name:     p.profile_name,
        profile_category: p.profile_category,
        total_ms:         r ? r.total_ms : 0,
        runs_count:       r ? r.runs_count : 0,
      };
    }).sort((a, b) => (b.total_ms - a.total_ms) || a.profile_name.localeCompare(b.profile_name));

    // Roster de un equipo: todos sus pilotos con su tiempo total y nº de turnos
    // en la carrera. Reusa `summary` (por nombre); los que aún no han corrido
    // salen a 0. Sustituye al antiguo historial de la card.
    const summaryByName = {};
    summary.forEach(r => { summaryByName[r.profile_name] = r; });
    const rosterForTeam = (teamId) => {
      if (!teamId) return [];
      const members = db.prepare('SELECT id, name FROM drivers WHERE team_id = ? ORDER BY name ASC').all(teamId);
      return members.map(m => {
        const s = summaryByName[m.name];
        return {
          driver_id: m.id,
          name:     m.name,
          total_ms: s ? s.total_ms : 0,
          runs:     s ? s.runs_count : 0,
          category: s ? s.profile_category : null,
        };
      });
    };
    const rosterByLane = {};
    lanes.forEach(l => { rosterByLane[l.lane] = rosterForTeam(l.team_id); });

    // Equipos que descansan esta manga (is_rest=1, lane=0). El nº de descanso
    // se deriva ordenando alfabéticamente, como en el directo: "Descanso n/N".
    const resting = allLanes.filter(l => l.is_rest)
      .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
    const restingTeams = resting.map((l, i) => ({
      team_id:   l.team_id,
      team_name: l.team_name || l.driver_name || '—',
      restPos:   i + 1,
      restTotal: resting.length,
      roster:    rosterForTeam(l.team_id),
    }));

    // Duración de manga (ms) para precargar la corrección manual de tiempo.
    const durRow = db.prepare('SELECT actual_duration_ms FROM mangas WHERE id = ?').get(manga.id);
    const mangaDurationMs = (durRow && durRow.actual_duration_ms > 0)
      ? durRow.actual_duration_ms
      : (race.manga_duration_minutes || 0) * 60000;

    res.render('control/shifts-live', {
      t: req.t,
      current: { manga, race, liveStatus },
      lanes,
      openByLane,
      liveActive,   // { lane → { shiftId, drivingMs } }
      history,
      summary,
      rosterByLane,
      restingTeams,
      mangaDurationMs,
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
