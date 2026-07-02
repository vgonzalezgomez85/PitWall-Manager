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

    // Acumulado de TODA la carrera, agrupado por NOMBRE de equipo. En algunas
    // carreras los equipos están duplicados (varias filas en `teams` con el
    // mismo nombre y distinto id: una "maestra" sin tanda + una por tanda), y
    // las vueltas se asignan a las filas por tanda. Si buscáramos por team_id
    // exacto veríamos 0 vueltas. Agrupando por nombre, cada equipo ve su total
    // real. Para Modena (una fila por equipo) el agrupado es idéntico.
    const name = team.name;
    const agg = Lap.aggregateByRace(race.id);
    const byName = {};
    agg.forEach(r => {
      let g = byName[r.entity_name];
      if (!g) g = byName[r.entity_name] = {
        name: r.entity_name, color: r.color, total_laps: 0, total_time_ms: 0,
        best_lap_ms: null, exit_count: 0, mangas_raced: 0, _avgNum: 0, _avgDen: 0,
      };
      g.total_laps    += r.total_laps || 0;
      g.total_time_ms += r.total_time_ms || 0;
      g.exit_count    += r.exit_count || 0;
      g.mangas_raced  += r.mangas_raced || 0;
      if (r.best_lap_ms != null && (g.best_lap_ms == null || r.best_lap_ms < g.best_lap_ms)) g.best_lap_ms = r.best_lap_ms;
      if (r.avg_lap_ms != null) { g._avgNum += r.avg_lap_ms * (r.total_laps || 0); g._avgDen += (r.total_laps || 0); }
      if (!g.color && r.color) g.color = r.color;
    });
    const groups = Object.values(byName).map(g => ({
      name: g.name, color: g.color, total_laps: g.total_laps, total_time_ms: g.total_time_ms,
      best_lap_ms: g.best_lap_ms, exit_count: g.exit_count, mangas_raced: g.mangas_raced,
      avg_lap_ms: g._avgDen > 0 ? g._avgNum / g._avgDen : null,
    }));
    groups.sort((a, b) => (b.total_laps - a.total_laps) || ((a.total_time_ms || 0) - (b.total_time_ms || 0)));
    const idx = groups.findIndex(g => g.name === name);
    const row = idx >= 0 ? groups[idx] : null;
    const leader = groups[0] || null;
    const ahead  = idx > 0 ? groups[idx - 1] : null;

    // Pit stops acumulados por NOMBRE de equipo.
    const pitStops = db.prepare(`
      SELECT COALESCE(SUM(l.is_pit_stop), 0) AS pits
      FROM laps l JOIN teams t ON t.id = l.team_id
      WHERE l.race_id = ? AND t.name = ? AND l.is_ghost = 0 AND l.manga_id IS NOT NULL
    `).get(race.id, name).pits;

    // Última vuelta válida registrada, por NOMBRE (fallback si no hay manga viva).
    const lastRow = db.prepare(`
      SELECT l.lap_time_ms FROM laps l JOIN teams t ON t.id = l.team_id
      WHERE l.race_id = ? AND t.name = ? AND l.is_ghost = 0 AND l.is_warmup = 0 AND l.lap_number > 0
      ORDER BY l.id DESC LIMIT 1
    `).get(race.id, name);

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
      }
    }

    // Proyección ÚNICA (media-based, desde BD): la MISMA que directo, Le Mans,
    // panel y live-stats. Fuera del guard de sesión viva → funciona también tras
    // reinicio. Casamos por entityId (nombres pueden repetirse por tanda).
    try {
      const pr = TimingService.buildRaceProjection(race.id)
        .find(p => p.entityType === 'team' && p.entityId === team.id);
      if (pr) {
        projection = {
          position:       pr.position,
          projectedTotal: pr.projectedTotal,
          gapV:           pr.gapV,
          avgToCatch:     pr.avgToCatch,
        };
      }
    } catch (e) { /* sin proyección si falla la consulta */ }

    const teamsTotal = db.prepare('SELECT COUNT(DISTINCT name) AS c FROM teams WHERE race_id = ?').get(race.id).c;

    return {
      ok: true,
      updatedAt: Date.now(),
      race: { id: race.id, name: race.name, status: race.status },
      team: { id: team.id, name: team.name, color: row && row.color ? row.color : team.color },
      teamsTotal,
      leader: leader ? { name: leader.name, totalLaps: leader.total_laps } : null,
      timing,
      live,
      projection,
    };
  },

  // ── Hoja de PINs para repartir a los equipos (organización) ────────────────
  // GET /lap/:raceId/pins  (pública: alcanzable desde la red del evento)
  pinsPage(req, res) {
    const race = Race.findById(req.params.raceId);
    if (!race) return res.status(404).render('lap/error', { message: 'Carrera no encontrada.', layout: false });
    const teams = Team.withLapPins(race.id);
    res.render('lap/pins', {
      race: { id: race.id, name: race.name, format: race.format, status: race.status },
      teams,
      isEndurance: isEnduranceRace(race),
      layout: false,
    });
  },

  // POST /lap/:raceId/pins/:teamId/regenerate — nuevo PIN para un equipo
  regeneratePin(req, res) {
    Team.regenerateLapPin(Number(req.params.raceId), Number(req.params.teamId));
    res.redirect(`/lap/${req.params.raceId}/pins`);
  },
};

module.exports = LapController;
