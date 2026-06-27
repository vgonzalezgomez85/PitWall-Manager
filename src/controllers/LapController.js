// LapController — cliente web "Lap" para carreras de resistencia (equipos).
//
// Permite que cada equipo siga su propio timing en vivo desde el navegador del
// móvil, sin instalar nada: entra en /lap, elige su carrera y equipo, mete el
// PIN de 4 dígitos y ve su panel. Solo lectura (V1): no manda acciones.
//
// La data viva sale de lo que ya existe: Lap.aggregateByRace (acumulado de toda
// la carrera, sobrevive entre mangas) + TimingService.getStandings (estado de la
// manga en curso y proyección). El front refresca vía socket.io (view=lap).

const Race          = require('../models/Race');
const Team          = require('../models/Team');
const Lap           = require('../models/Lap');
const db            = require('../config/database');

function isEnduranceRace(race) {
  // No hay un flag "resistencia" en el esquema: la resistencia en PitWall es una
  // carrera por EQUIPOS (mangas/tandas con rotación de carriles). El cliente Lap
  // se ofrece solo para esas.
  return race && race.format === 'team';
}

const LapController = {
  isEnduranceRace,

  // GET /lap — elegir carrera (equipos, activas o pendientes)
  index(req, res) {
    const rows = db.prepare(`
      SELECT id, name, status, lanes_count, created_at, started_at
      FROM races
      WHERE format = 'team' AND status IN ('active','pending')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
    `).all();
    const races = rows.map(r => ({
      id: r.id, name: r.name, status: r.status,
      teamsCount: db.prepare('SELECT COUNT(*) AS c FROM teams WHERE race_id = ?').get(r.id).c,
    }));
    res.render('lap/index', { races, layout: false });
  },

  // GET /lap/:raceId — elegir equipo + PIN
  selectRace(req, res) {
    const race = Race.findById(req.params.raceId);
    if (!race || !isEnduranceRace(race)) {
      return res.status(404).render('lap/error', { message: 'Carrera no encontrada o no es de resistencia.', layout: false });
    }
    const teams = Team.withLapPins(race.id).map(t => ({ id: t.id, name: t.name, color: t.color }));
    res.render('lap/race', {
      race: { id: race.id, name: race.name, status: race.status },
      teams,
      error: req.query.error === '1' ? 'PIN incorrecto. Inténtalo de nuevo.' : null,
      layout: false,
    });
  },

  // POST /lap/:raceId/login — { teamId, pin }
  login(req, res) {
    const raceId = Number(req.params.raceId);
    const teamId = Number(req.body.teamId);
    const pin    = String(req.body.pin || '').trim();
    const race = Race.findById(raceId);
    if (!race || !isEnduranceRace(race)) {
      return res.status(404).render('lap/error', { message: 'Carrera no encontrada.', layout: false });
    }
    const team = Team.verifyLapPin(raceId, teamId, pin);
    if (!team) {
      return res.redirect(`/lap/${raceId}?error=1`);
    }
    req.session.lap = { raceId, teamId };
    res.redirect(`/lap/${raceId}/team/${teamId}`);
  },

  // Comprueba que la sesión tiene acceso concedido a (raceId, teamId).
  _hasAccess(req, raceId, teamId) {
    const a = req.session && req.session.lap;
    return !!a && Number(a.raceId) === Number(raceId) && Number(a.teamId) === Number(teamId);
  },

  // GET /lap/:raceId/team/:teamId — panel de timing del equipo
  teamView(req, res) {
    const raceId = Number(req.params.raceId);
    const teamId = Number(req.params.teamId);
    if (!LapController._hasAccess(req, raceId, teamId)) {
      return res.redirect(`/lap/${raceId}`);
    }
    const race = Race.findById(raceId);
    const team = Team.findById(teamId);
    if (!race || !team || !isEnduranceRace(race) || team.race_id !== raceId) {
      return res.status(404).render('lap/error', { message: 'Equipo no encontrado.', layout: false });
    }
    const snapshot = LapController._buildTeamSnapshot(race, team);
    res.render('lap/team', {
      race: { id: race.id, name: race.name, status: race.status },
      team: { id: team.id, name: team.name, color: team.color },
      snapshot,
      layout: false,
    });
  },

  // GET /api/lap/:raceId/team/:teamId — snapshot JSON (lo consume el front al refrescar)
  teamSnapshot(req, res) {
    const raceId = Number(req.params.raceId);
    const teamId = Number(req.params.teamId);
    if (!LapController._hasAccess(req, raceId, teamId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const race = Race.findById(raceId);
    const team = Team.findById(teamId);
    if (!race || !team || team.race_id !== raceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json(LapController._buildTeamSnapshot(race, team));
  },

  // ── Construcción del snapshot de timing de un equipo ───────────────────────
  _buildTeamSnapshot(race, team) {
    const TimingService = require('../services/TimingService');

    // Acumulado de TODA la carrera (sobrevive entre mangas y a la rotación de
    // carriles). Ordenado por vueltas → la posición general es el índice.
    const agg = Lap.aggregateByRace(race.id);
    const idx = agg.findIndex(r => r.entity_type === 'team' && r.entity_id === team.id);
    const row = idx >= 0 ? agg[idx] : null;
    const leader = agg[0] || null;
    const ahead  = idx > 0 ? agg[idx - 1] : null;

    // Pit stops acumulados (suma por carril de la carrera).
    const perLane = Lap.perLaneByEntity(race.id, team.id, 'team');
    const pitStops = perLane.reduce((s, l) => s + (l.pit_stop_count || 0), 0);

    // Última vuelta válida registrada (fallback si no hay manga en vivo).
    const lastRow = db.prepare(`
      SELECT lap_time_ms FROM laps
      WHERE race_id = ? AND team_id = ? AND is_ghost = 0 AND is_warmup = 0 AND lap_number > 0
      ORDER BY id DESC LIMIT 1
    `).get(race.id, team.id);

    const timing = {
      position:       row ? idx + 1 : null,
      totalLaps:      row ? row.total_laps : 0,
      gapLaps:        (row && leader) ? (leader.total_laps - row.total_laps) : 0,
      gapToAheadLaps: (row && ahead) ? (ahead.total_laps - row.total_laps) : null,
      bestLapMs:      row ? row.best_lap_ms : null,
      avgLapMs:       row && row.avg_lap_ms != null ? Math.round(row.avg_lap_ms) : null,
      lastLapMs:      lastRow ? lastRow.lap_time_ms : null,
      totalTimeMs:    row ? row.total_time_ms : null,
      mangasRaced:    row ? row.mangas_raced : 0,
      pitStops,
      exitCount:      row ? row.exit_count : 0,
    };

    // Estado EN VIVO (solo si hay una manga corriendo de ESTA carrera).
    let live = { running: false, onTrack: false, mangaNumber: null, lane: null, elapsedMs: null, remainingMs: null };
    let projection = null;
    if (TimingService.activeRaceId === race.id) {
      const st = TimingService.getStandings();
      if (st) {
        live.running = true;
        live.elapsedMs   = st.elapsedMs;
        live.remainingMs = st.remainingMs;
        const m = db.prepare('SELECT number FROM mangas WHERE id = ?').get(st.mangaId);
        live.mangaNumber = m ? m.number : null;

        // Fila de la manga en curso (los nombres de equipo son únicos por carrera).
        const sr = (st.standings || []).find(s => s.name === team.name);
        if (sr) {
          live.onTrack = true;
          live.lane = sr.lane;
          if (sr.lastLapMs != null) timing.lastLapMs = sr.lastLapMs;
        }
        // Proyección por entidad (posición estimada al final + vueltas proyectadas).
        const pr = (st.projection || []).find(p => p.entityType === 'team' && p.entityId === team.id);
        if (pr) {
          projection = {
            position:       pr.position,
            projectedTotal: pr.projectedTotal,
            gapV:           pr.gapV,
            avgToCatch:     pr.avgToCatch,
          };
        }
      }
    }

    const teamsTotal = db.prepare('SELECT COUNT(*) AS c FROM teams WHERE race_id = ?').get(race.id).c;

    return {
      ok: true,
      updatedAt: Date.now(),
      race: { id: race.id, name: race.name, status: race.status },
      team: { id: team.id, name: team.name, color: team.color },
      teamsTotal,
      leader: leader ? { name: leader.entity_name, totalLaps: leader.total_laps } : null,
      timing,
      live,
      projection,
    };
  },

  // ── Admin: hoja de PINs para repartir a los equipos ────────────────────────
  // GET /races/:id/lap-pins  (acceso admin vía restrictAccess)
  pinsPage(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('lap/error', { message: 'Carrera no encontrada.', layout: false });
    const teams = Team.withLapPins(race.id);
    res.render('lap/pins', {
      race: { id: race.id, name: race.name, format: race.format, status: race.status },
      teams,
      isEndurance: isEnduranceRace(race),
      layout: false,
    });
  },

  // POST /races/:id/lap-pins/:teamId/regenerate — nuevo PIN para un equipo
  regeneratePin(req, res) {
    Team.regenerateLapPin(Number(req.params.id), Number(req.params.teamId));
    res.redirect(`/races/${req.params.id}/lap-pins`);
  },
};

module.exports = LapController;
