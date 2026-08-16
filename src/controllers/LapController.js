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
// LapController — cliente web "Lap" para carreras de resistencia (equipos).
//
// Permite que cada equipo siga su propio timing en vivo desde el navegador del
// móvil, sin instalar nada: entra en /lap, elige su carrera y equipo, mete el
// PIN de 4 dígitos y ve su panel. Solo lectura (V1): no manda acciones.
//
// La data viva sale de lo que ya existe: TimingService.raceAggregate (acumulado
// de toda la carrera, sobrevive entre mangas) + TimingService.getStandings (estado
// de la manga en curso y proyección). El front refresca vía socket.io (view=lap).

const Race          = require('../models/Race');
const Team          = require('../models/Team');
const Lap           = require('../models/Lap');
const TireChange        = require('../models/TireChange');
const PoleSession       = require('../models/PoleSession');
const PoleTimingService = require('../services/PoleTimingService');
const db            = require('../config/database');

// ── Caché del paquete POR CARRERA ────────────────────────────────────────────
//
// El snapshot de un equipo costaba ~266 ms sobre las 160.000 vueltas de una 24 h
// (agregado 95 + proyección 100 + pit stops 35 + última vuelta 36). Y de esos
// 266 ms, TODOS eran idénticos para los 22 equipos: la clasificación de la
// carrera, la proyección y los pit stops no dependen de quién pregunte. Lo único
// propio de cada equipo es cuál es SU fila.
//
// Con 22 móviles refrescando cada 5 s —y un rebote extra por cada cruce— eso eran
// ~11 s de CPU por cada segundo de reloj en un proceso de un solo hilo. Y como
// better-sqlite3 es síncrono, ese bloqueo no era solo lentitud: supera de largo
// los 75 ms de FRAME_GAP_MS del serie, así que podía partir una trama del DS y
// perder un cruce de verdad.
//
// Aquí se calcula UNA vez por carrera y se reparte a todos. La invalidación es la
// misma idea que en el motor y no depende de que nadie se acuerde: cualquier
// escritura sobre `laps` (contador de mutaciones) lo tira, y además caduca al
// segundo porque la proyección depende del reloj, no solo de las vueltas. Un
// segundo de frescura no lo puede ver nadie: el `tick` que refresca la pantalla
// del piloto ya es de 1 s.
//
// Lo que NO entra aquí: el estado vivo (getStandings). Con las cachés del motor
// calientes es un bucle en memoria sobre los carriles, así que sale más barato
// pedirlo en cada petición que cachearlo, y el reloj de la manga va al ms.
const RACE_BUNDLE_TTL_MS = 1000;
const BUNDLE_MAX_RACES   = 8;
const _bundles = new Map();   // raceId → paquete

// El coste de raceAggregate() crece con las vueltas acumuladas de TODA la
// carrera (no solo la manga activa) — perfilado con --prof bajo una carrera de
// 48 mangas / 24 carriles + 30 espectadores Lap web: este cálculo por sí solo
// se comió el 69% de la CPU total. Con muchas mangas ya corridas, un TTL fijo
// de 1s obliga a repetir ese cálculo, cada vez más caro, una vez por segundo
// sin parar. Con la manga avanzada nadie nota unos segundos más de retraso en
// el snapshot del equipo — así que se recorta cuánto se recalcula.
function bundleTtlFor(mangaNumber) {
  if (mangaNumber > 30) return 10000;
  if (mangaNumber > 15) return 6000;
  if (mangaNumber > 5)  return 3000;
  return RACE_BUNDLE_TTL_MS;
}

function _cachePut(cache, raceId, valor) {
  cache.delete(raceId);            // reinsertar = renovar su puesto en el orden
  cache.set(raceId, valor);
  while (cache.size > BUNDLE_MAX_RACES) cache.delete(cache.keys().next().value);
}

function isEnduranceRace(race) {
  // No hay un flag "resistencia" en el esquema: la resistencia en PitWall es una
  // carrera por EQUIPOS (mangas/tandas con rotación de carriles). El cliente Lap
  // se ofrece solo para esas.
  return race && race.format === 'team';
}

const LapController = {
  isEnduranceRace,

  /** Tira la caché por carrera. Para los tests; en producción caduca sola. */
  _resetCaches() { _bundles.clear(); },

  // Ganchos para los tests: el paquete cacheado de una carrera y su TTL.
  _bundleOf(raceId) { return _bundles.get(raceId); },
  get _BUNDLE_TTL_MS() { return RACE_BUNDLE_TTL_MS; },

  // GET /lap — elegir carrera (equipos, activas o pendientes)
  index(req, res) {
    const lang = req.session?.lang || 'es';
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
    res.render('lap/index', { t: req.t, lang, races });
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

  // ── Paquete por carrera: lo que es igual para todos los equipos ────────────
  _raceBundle(race) {
    const TimingService = require('../services/TimingService');
    const ahora = Date.now();
    const mut   = Lap.mutationCount;

    // El TTL solo hace falta con una manga EN CURSO, que es cuando la proyección
    // se mueve sola: cuenta el tiempo que queda. Entre mangas —y en una carrera
    // acabada— no se inserta ni una vuelta, así que el paquete solo puede quedarse
    // rancio si alguien corrige algo, y de eso ya avisa el contador de mutaciones.
    // Sin esta distinción, un equipo con el móvil abierto entre mangas forzaba un
    // escaneo completo de la carrera (230 ms) cada segundo, para nada.
    const viva = TimingService.activeMangaOf(race.id);
    const c = _bundles.get(race.id);
    if (c && c.mut === mut && (!viva || (ahora - c.ts) < bundleTtlFor(viva.number))) return c;

    // Acumulado de TODA la carrera, agrupado por NOMBRE de equipo. En algunas
    // carreras los equipos están duplicados (varias filas en `teams` con el
    // mismo nombre y distinto id: una "maestra" sin tanda + una por tanda), y
    // las vueltas se asignan a las filas por tanda. Si buscáramos por team_id
    // exacto veríamos 0 vueltas. Agrupando por nombre, cada equipo ve su total
    // real. Para Modena (una fila por equipo) el agrupado es idéntico.
    //
    // Se descartan las entidades nulas: son las vueltas de carriles sin equipo
    // asignado, que `aggregateByRace` junta en una fila sintética. Sin filtrar,
    // esa fila competía como un equipo más y podía salir "líder", falseando el
    // gap de todos. El resto de vistas ya la quitan.
    const byName = {};
    TimingService.raceAggregate(race.id).forEach(r => {
      if (r.entity_id == null) return;
      let g = byName[r.entity_name];
      if (!g) g = byName[r.entity_name] = {
        name: r.entity_name, color: r.color, total_laps: 0, total_time_ms: 0,
        best_lap_ms: null, exit_count: 0, mangas_raced: 0, pit_stops: 0,
        last_lap_id: null, _avgNum: 0, _avgDen: 0,
      };
      g.total_laps    += r.total_laps || 0;
      g.total_time_ms += r.total_time_ms || 0;
      g.exit_count    += r.exit_count || 0;
      g.mangas_raced  += r.mangas_raced || 0;
      g.pit_stops     += r.pit_stops || 0;
      if (r.best_lap_ms != null && (g.best_lap_ms == null || r.best_lap_ms < g.best_lap_ms)) g.best_lap_ms = r.best_lap_ms;
      if (r.last_lap_id != null && (g.last_lap_id == null || r.last_lap_id > g.last_lap_id)) g.last_lap_id = r.last_lap_id;
      if (r.avg_lap_ms != null) { g._avgNum += r.avg_lap_ms * (r.total_laps || 0); g._avgDen += (r.total_laps || 0); }
      if (!g.color && r.color) g.color = r.color;
    });
    // El tiempo de la última vuelta, por clave primaria: un puñado de lookups que
    // no se notan, en vez de un escaneo de la carrera por equipo y refresco.
    const tiempoDeVuelta = db.prepare('SELECT lap_time_ms FROM laps WHERE id = ?');
    const groups = Object.values(byName).map(g => ({
      name: g.name, color: g.color, total_laps: g.total_laps, total_time_ms: g.total_time_ms,
      best_lap_ms: g.best_lap_ms, exit_count: g.exit_count, mangas_raced: g.mangas_raced,
      pit_stops: g.pit_stops,
      last_lap_ms: g.last_lap_id != null ? (tiempoDeVuelta.get(g.last_lap_id) || {}).lap_time_ms ?? null : null,
      avg_lap_ms: g._avgDen > 0 ? g._avgNum / g._avgDen : null,
    }));
    groups.sort((a, b) => (b.total_laps - a.total_laps) || ((a.total_time_ms || 0) - (b.total_time_ms || 0)));
    const idxByName = new Map(groups.map((g, i) => [g.name, i]));

    // Proyección ÚNICA (media-based, desde BD): la MISMA que directo, Le Mans,
    // panel y live-stats. Cacheada por el motor con su propio TTL.
    const projByEntityId = new Map();
    try {
      TimingService._cachedProjection(race.id).forEach(p => {
        if (p.entityType === 'team') projByEntityId.set(p.entityId, p);
      });
    } catch (e) { /* sin proyección si falla la consulta */ }

    const teamsTotal = db.prepare('SELECT COUNT(DISTINCT name) AS c FROM teams WHERE race_id = ?').get(race.id).c;

    const bundle = { ts: ahora, mut, groups, idxByName, projByEntityId, teamsTotal };
    _cachePut(_bundles, race.id, bundle);
    return bundle;
  },

  // ── Construcción del snapshot de timing de un equipo ───────────────────────
  _buildTeamSnapshot(race, team) {
    const TimingService = require('../services/TimingService');

    const name   = team.name;
    const b      = LapController._raceBundle(race);
    const groups = b.groups;
    const idx    = b.idxByName.has(name) ? b.idxByName.get(name) : -1;
    const row    = idx >= 0 ? groups[idx] : null;
    const leader = groups[0] || null;
    const ahead  = idx > 0 ? groups[idx - 1] : null;

    const timing = {
      position:       row ? idx + 1 : null,
      totalLaps:      row ? row.total_laps : 0,
      gapLaps:        (row && leader) ? (leader.total_laps - row.total_laps) : 0,
      gapToAheadLaps: (row && ahead) ? (ahead.total_laps - row.total_laps) : null,
      bestLapMs:      row ? row.best_lap_ms : null,
      avgLapMs:       row && row.avg_lap_ms != null ? Math.round(row.avg_lap_ms) : null,
      lastLapMs:      row ? row.last_lap_ms : null,
      totalTimeMs:    row ? row.total_time_ms : null,
      mangasRaced:    row ? row.mangas_raced : 0,
      pitStops:       row ? row.pit_stops : 0,
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
    const pr = b.projByEntityId.get(team.id);
    if (pr) {
      projection = {
        position:       pr.position,
        projectedTotal: pr.projectedTotal,
        gapV:           pr.gapV,
        avgToCatch:     pr.avgToCatch,
      };
    }

    const teamsTotal = b.teamsTotal;

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
      poleResult:  LapController._buildPoleResult(race, team),
      poleLive:    LapController._buildPoleLive(race, team),
      tireControl: LapController._buildTireControl(race, team),
    };
  },

  // Control de neumáticos REAL de la carrera (organización, kiosco) para este
  // equipo — null si la carrera no lo lleva (tire_pairs_per_team=0). Es la
  // fuente de verdad: cuando existe, sustituye a la configuración manual del
  // widget de estrategia del propio cliente Lap (que sirve de respaldo si no
  // hay control real). Mismo id canónico que el resto (menor id por nombre).
  _buildTireControl(race, team) {
    const summary = TireChange.summaryByRace(race.id);
    if (!summary.allowance) return null;
    const row = summary.teams.find(t => t.name === team.name);
    if (!row) return null;
    return { allowance: summary.allowance, used: row.used, available: row.available };
  },

  // Resultado de la pole (si la carrera la tuvo y ya terminó) que le tocó a
  // este equipo. Los pole_entries no llevan team_id — se empareja por NOMBRE,
  // igual que el resto del cliente Lap.
  _buildPoleResult(race, team) {
    if (!race.has_pole) return null;
    const session = PoleSession.findByRace(race.id);
    if (!session || session.status !== 'done') return null;
    const sorted = PoleSession.getEntriesSorted(session.id);
    const idx = sorted.findIndex(e => e.entity_name === team.name);
    if (idx < 0) return null;
    return { position: idx + 1, totalEntries: sorted.length, lapTimeMs: sorted[idx].lap_time_ms };
  },

  // Estado EN VIVO de la pole (mientras se está corriendo, antes de asignar
  // carriles): el equipo "maestro" ya existe desde que se creó la carrera —
  // RaceController.create los crea con su PIN de Lap por adelantado, sin
  // esperar a que la pole termine — así que el equipo puede entrar a Lap y
  // seguir su turno mientras la pole está en marcha. El resto de la sesión se
  // sigue por los mismos eventos de socket que pinta pole-timing.ejs
  // (pole:standby/started/tick/lap/finished), que ya son un broadcast global.
  _buildPoleLive(race, team) {
    if (!race.has_pole) return null;
    const session = PoleSession.findByRace(race.id);
    if (!session || session.status !== 'in_progress') return null;
    const entries = PoleSession.getEntriesOrdered(session.id);
    const myIdx = entries.findIndex(e => e.entity_name === team.name);
    if (myIdx < 0) return null;
    const current = entries[session.current_idx] || null;
    const myTurn  = !!current && current.entity_name === team.name;
    const standings = PoleSession.getEntriesSorted(session.id)
      .filter(e => e.lap_time_ms != null)
      .map((e, i) => ({ name: e.entity_name, position: i + 1, lapTimeMs: e.lap_time_ms }));
    return {
      myTurn,
      myPosition:    myIdx + 1,
      totalEntries:  entries.length,
      currentName:   current ? current.entity_name : null,
      myLapTimeMs:   entries[myIdx].lap_time_ms,
      // Para que un refresco de página A MITAD del propio intento (F5, o
      // simplemente abrir el panel un poco tarde) arranque ya en el estado
      // correcto en vez de esperar al próximo pole:standby/started — esos
      // eventos ya pasaron y no se repiten.
      myTurnRunning: myTurn && PoleTimingService.isRunning,
      standings,
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
