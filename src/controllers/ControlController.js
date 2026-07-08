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
const { evaluate }  = require('../utils/shiftCompliance');
const { fmtHmsFijo } = require('../utils/duration');

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
    const summary = DriverShift.raceSummaryAllPilots(race.id);

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

    // Resumen por piloto a nivel CARRERA, con TODOS los inscritos: quien nunca
    // fichó sale a 0:00 y bajo mínimo, en vez de desaparecer del histórico.
    const summary = DriverShift.raceSummaryAllPilots(race.id);

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

  // ── Informe final de turnos ───────────────────────────────────────────────
  // El documento con el que se resuelve una reclamación: quién condujo cuánto,
  // en cuántos turnos, y qué reglas incumplió. Con la carrera terminada el
  // MÍNIMO ya se juzga (final: true), a diferencia de la vista en directo.

  /** Datos comunes al informe en sus tres formatos. */
  static _reportData(raceId) {
    const race = Race.findById(raceId);
    if (!race || race.type !== 'championship') return null;

    const reglas = {
      minMs:   race.driver_min_total_ms || 0,
      maxMs:   race.driver_max_total_ms || 0,
      maxRuns: race.driver_max_runs || 0,
      final:   true,
    };
    const summary = DriverShift.raceSummaryAllPilots(race.id).map(r => ({
      ...r,
      compliance: evaluate({ totalMs: r.total_ms, runs: r.runs_count }, reglas),
    }));

    const infracciones = summary.filter(r => r.compliance.status === 'bad');
    const manuales     = summary.reduce((n, r) => n + (r.manual_count || 0), 0);

    // Cronología por manga, para justificar cada total.
    const mangas = db.prepare(`
      SELECT m.id, m.number, m.status, m.tanda_id, t.number AS tanda_number
      FROM mangas m
      LEFT JOIN tandas t ON t.id = m.tanda_id
      WHERE m.race_id = ?
      ORDER BY m.id ASC
    `).all(race.id);
    mangas.forEach(m => { m.shifts = DriverShift.historyByManga(m.id); });

    return { race, reglas, summary, mangas, infracciones, manuales };
  }

  // GET /races/:id/shifts/report
  static shiftsReport(req, res) {
    const data = ControlController._reportData(req.params.id);
    if (!data) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    return ControlController._sendReport(req, res, data);
  }

  // GET /races/:id/shifts/report.html — descarga AUTOCONTENIDA (CSS embebido,
  // sin JS ni assets del servidor), para adjuntar a una reclamación.
  static shiftsReportHtml(req, res) {
    req._exportMode = true;
    return ControlController.shiftsReport(req, res);
  }

  static _sendReport(req, res, data) {
    const locals = { t: req.t, ...data };
    if (!req._exportMode) return res.render('control/shifts-report', locals);

    res.render('control/shifts-report', { ...locals, hideNavbar: true }, (err, html) => {
      if (err) { console.error('[shifts-report] render error:', err.message); return res.status(500).send('Export error'); }
      const SessionController = require('./SessionController');
      const out = SessionController._inlineForExport(html);
      const slug = String(data.race.name || 'carrera').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="turnos-${slug}.html"`);
      res.send(out);
    });
  }

  // GET /races/:id/shifts/report.xlsx
  static async shiftsReportExcel(req, res) {
    const data = ControlController._reportData(req.params.id);
    if (!data) return res.status(404).send('Not found');
    const { race, reglas, summary } = data;

    const ExcelJS = require('exceljs');
    const isEs = (req.query.lang || 'es') === 'es';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PitWall';
    const ws = wb.addWorksheet(isEs ? 'Turnos' : 'Shifts');

    const COL = { header: 'FF161B22', headerFg: 'FFFFFFFF', border: 'FFD0D7DE',
                  bad: 'FFFDECEC', warn: 'FFFFFBE6', band: 'FFF6F8FA' };
    const thinBorder = {
      top:    { style: 'thin', color: { argb: COL.border } },
      left:   { style: 'thin', color: { argb: COL.border } },
      bottom: { style: 'thin', color: { argb: COL.border } },
      right:  { style: 'thin', color: { argb: COL.border } },
    };

    ws.mergeCells('A1:G1');
    const titulo = ws.getCell('A1');
    titulo.value = `${race.name} — ${isEs ? 'Informe de turnos de piloto' : 'Driver shift report'}`;
    titulo.font = { bold: true, size: 14 };
    ws.getRow(1).height = 22;

    ws.mergeCells('A2:G2');
    const sub = ws.getCell('A2');
    const lim = [];
    if (reglas.minMs)   lim.push(`${isEs ? 'mín' : 'min'} ${fmtHmsFijo(reglas.minMs)}`);
    if (reglas.maxMs)   lim.push(`${isEs ? 'máx' : 'max'} ${fmtHmsFijo(reglas.maxMs)}`);
    if (reglas.maxRuns) lim.push(`${isEs ? 'máx turnos' : 'max stints'} ${reglas.maxRuns}`);
    sub.value = lim.length ? (isEs ? 'Límites: ' : 'Limits: ') + lim.join(' · ')
                           : (isEs ? 'Sin límites configurados' : 'No limits configured');
    sub.font = { italic: true, color: { argb: 'FF6E7681' } };

    const cabecera = isEs
      ? ['Piloto', 'Categoría', 'Tiempo total', 'Turnos', 'Máx turnos', 'Correcciones manuales', 'Estado']
      : ['Driver', 'Category', 'Total time', 'Stints', 'Max stints', 'Manual fixes', 'Status'];
    const filaCab = ws.addRow([]);            // fila 3 vacía de separación
    filaCab.height = 6;
    const head = ws.addRow(cabecera);
    head.eachCell(c => {
      c.font = { bold: true, color: { argb: COL.headerFg } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.header } };
      c.border = thinBorder;
      c.alignment = { horizontal: 'center' };
    });

    const etiqueta = (c) => {
      if (c.overMax)  return isEs ? 'PASADO DE TIEMPO' : 'OVER TIME';
      if (c.overRuns) return isEs ? 'PASADO DE TURNOS' : 'OVER STINTS';
      if (c.underMin) return isEs ? 'BAJO MÍNIMO'      : 'UNDER MIN';
      if (c.nearMax)  return isEs ? 'Al 90% del máximo' : 'At 90% of max';
      if (c.nearRuns) return isEs ? 'Último turno'      : 'Last stint';
      return 'OK';
    };

    summary.forEach(r => {
      const c = r.compliance;
      const row = ws.addRow([
        r.profile_name,
        r.profile_category || '',
        fmtHmsFijo(r.total_ms),
        r.runs_count,
        reglas.maxRuns || '',
        r.manual_count || 0,
        etiqueta(c),
      ]);
      const fondo = c.status === 'bad' ? COL.bad : c.status === 'warn' ? COL.warn : null;
      row.eachCell(cell => {
        cell.border = thinBorder;
        if (fondo) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fondo } };
      });
      row.getCell(3).alignment = { horizontal: 'right' };
      row.getCell(4).alignment = { horizontal: 'center' };
      if (c.status === 'bad') row.getCell(7).font = { bold: true };
    });

    ws.columns = [{ width: 28 }, { width: 12 }, { width: 14 }, { width: 9 },
                  { width: 12 }, { width: 20 }, { width: 22 }];

    const slug = String(race.name || 'carrera').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="turnos-${slug}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }
}

module.exports = ControlController;
