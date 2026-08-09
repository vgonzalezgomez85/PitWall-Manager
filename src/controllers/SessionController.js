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
const Race           = require('../models/Race');
const Manga          = require('../models/Manga');
const Tanda          = require('../models/Tanda');
const Lap            = require('../models/Lap');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
const DriverShift    = require('../models/DriverShift');
const SocketService  = require('../services/SocketService');
const SerialService  = require('../services/SerialService');
const TimingService  = require('../services/TimingService');
const ExcelJS        = require('exceljs');
const { robustConsistency, MIN_CONSISTENCY_LAPS } = require('../lib/consistency');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

class SessionController {

  // Devuelve la duración EFECTIVA de una manga en ms:
  //   - Si TimingService está gestionando esta manga ahora mismo, usa su
  //     `session.durationMs` (refleja la trama race_go del DS-300).
  //   - En su defecto, usa `race.manga_duration_minutes` de BD. Este valor
  //     es habitualmente el placeholder 99 que pone el wizard porque la
  //     duración real la marca el DS-300 al pulsar GO, así que la proyección
  //     basada en este fallback será inflada si no se ha corregido.
  //
  // Pendiente: idealmente cada manga debería persistir su duración real en
  // BD cuando arranca, para que las vistas históricas/post-carrera también
  // calculen bien la proyección. De momento solo el live (mientras está
  // activo) usa la duración real.
  static _getEffectiveMangaDurationMs(race, manga) {
    if (TimingService.activeMangaId === manga.id && TimingService.session?.durationMs > 0) {
      return TimingService.session.durationMs;
    }
    // Duración real persistida del DS (GO) — correcta también en mangas
    // terminadas o tras recargar, a diferencia del placeholder de la BD.
    if (manga.actual_duration_ms > 0) return manga.actual_duration_ms;
    return (race.manga_duration_minutes || 0) * 60000;
  }

  // POST /races/:id/mangas/:mangaId/start
  static start(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);

    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (manga.race_id !== race.id) return res.status(400).render('error', { t: req.t, code: 400, message: 'Bad request' });

    if (manga.status !== 'pending') return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);

    if (TimingService.isRunning) {
      return res.status(409).render('error', {
        t: req.t, code: 409,
        message: `Another manga is already running (ID ${TimingService.activeMangaId})`
      });
    }

    const lanes   = Manga.getLanes(manga.id);
    const tanda   = Tanda.findById(manga.tanda_id);
    const teams   = Team.findByTanda(manga.tanda_id);
    const drivers = Driver.findByTanda(manga.tanda_id);

    // En simulación/BART SlotTime inicia la carrera, así que el usuario puede
    // fijar la duración al dar GO (en DS-300 la manda la caja). Si llega, se usa
    // para esta manga y se recuerda en la carrera para el próximo GO.
    const durMin = parseInt(req.body.duration_minutes, 10);
    let durationMs = null;
    if (Number.isFinite(durMin) && durMin > 0) {
      durationMs = durMin * 60000;
      race.manga_duration_minutes = durMin;
      try { require('../config/database').prepare('UPDATE races SET manga_duration_minutes=? WHERE id=?').run(durMin, race.id); } catch {}
    }

    const softwareGo = SerialService.isBart || SerialService.isSimulating;

    const doStart = () => {
      TimingService.startManga(manga, race, lanes, teams, drivers, durationMs);
      // BART/sim: un único GO arranca TODOS los circuitos (no hay caja DS por
      // circuito). En DS-300 cada caja manda su GO.
      if (softwareGo) TimingService.startAllCircuits(durationMs);
      Tanda.updateStatus(tanda.id, 'active');
    };

    // BART/sim: el GO lo da SlotTime, así que lanzamos el semáforo F1 (3s) y
    // arrancamos al ponerse verde — mismo flujo que la trama GO del DS-300.
    // El botón es AJAX para que la animación no se pierda en una recarga.
    const SEMAPHORE_MS = 3000;
    if (softwareGo && req.body.semaphore !== '0') {
      SocketService.emit('race:semaphore');
      setTimeout(doStart, SEMAPHORE_MS);
      if (req.xhr || (req.get('accept') || '').includes('application/json')) {
        return res.json({ ok: true, semaphore: true });
      }
      return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
    }

    doStart();
    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/pause  — pausa manual (simulación/BART)
  static pause(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (TimingService.activeMangaId === manga.id) TimingService.pauseManga();
    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/resume  — reanuda manual (simulación/BART)
  static resume(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (TimingService.activeMangaId !== manga.id) return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);

    // Igual que el GO: en BART/sim mostramos el semáforo de reanudación (3s) y
    // reanudamos al ponerse verde — mismo flujo que la trama de resume del DS-300.
    const softwareGo = SerialService.isBart || SerialService.isSimulating;
    const SEMAPHORE_MS = 3000;
    if (softwareGo && req.body.semaphore !== '0') {
      SocketService.emit('race:semaphore');
      setTimeout(() => TimingService.resumeManga(), SEMAPHORE_MS);
      if (req.xhr || (req.get('accept') || '').includes('application/json')) {
        return res.json({ ok: true, semaphore: true });
      }
      return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
    }

    TimingService.resumeManga();
    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/stop
  // Manual stop: cancels the manga, wipes laps, resets to pending for restart.
  static stop(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    // Con sesión viva o con la manga colgada tras un reinicio del servidor, el
    // resultado debe ser el MISMO stop forzado: vueltas fuera, manga a pending,
    // tiempo de esta manga descartado y pilotos conservados, ya pre-armados.
    TimingService.cancelMangaById(manga.id, race);

    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // POST /races/:id/mangas/:mangaId/repeat
  // Resets a finished manga to pending so it can be run again.
  static repeat(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    if (manga.status !== 'finished') return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);

    // Can't repeat while another manga is running
    if (TimingService.isRunning) {
      req.session.flash = {
        type: 'error',
        text: req.session?.lang === 'en'
          ? 'Cannot repeat: another heat is currently running.'
          : 'No se puede repetir: hay otra manga en marcha.',
      };
      return res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
    }

    // Wipe laps and reset manga to pending
    Lap.deleteByManga(manga.id);
    Manga.updateStatus(manga.id, 'pending');

    // If tanda was finished, reactivate it
    const tanda = Tanda.findById(manga.tanda_id);
    if (tanda?.status === 'finished') Tanda.updateStatus(tanda.id, 'active');

    // Clear the tanda boundary so the hardware GO is accepted again.
    TimingService.clearTandaBoundary();

    res.redirect(`/races/${race.id}/mangas/${manga.id}/live`);
  }

  // GET /races/:id/mangas/:mangaId/live
  static live(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const laps     = Lap.findByManga(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;
    // Proyección de carrera COMPLETA (todas las tandas/mangas), siempre —
    // no solo cuando esta manga es la activa. Es la MISMA función que usa el
    // pop-up "Clasificación General" (panel/standings), así las tarjetas de
    // una manga ya finalizada (visor histórico) muestran el mismo orden P.x
    // y Gap V que el pop-up, en vez de recalcular una proyección aproximada
    // solo con los datos de esta manga. Si la manga está activa, reutiliza la
    // ya calculada dentro de getStandings() (misma función) para no duplicar.
    const projection = isActive ? standings.projection : TimingService.buildRaceProjection(race.id);

    // Previous-manga lap totals per lane (for "race total" display)
    const prevLapsByLane = {};
    lanes.forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    // Pre-register this manga so DS hardware GO button can start it
    if (manga.status === 'pending' && !TimingService.isRunning) {
      const teams   = Team.findByTanda(manga.tanda_id);
      const drivers = Driver.findByTanda(manga.tanda_id);
      // If the in-memory tanda boundary was set by a previous race/tanda
      // that has no finished mangas in this race's current tanda, clear it
      // so the hardware GO is accepted again.
      const db = require('../config/database');
      const hasFinishedInTanda = db.prepare(
        `SELECT 1 FROM mangas WHERE tanda_id = ? AND status = 'finished' LIMIT 1`
      ).get(manga.tanda_id);
      if (!hasFinishedInTanda) TimingService.clearTandaBoundary();
      TimingService.setPendingManga(manga, race, lanes, teams, drivers);
    }

    const totalMangas = Manga.findByTanda(manga.tanda_id).length;
    const totalTandas = Tanda.findByRace(race.id).length;
    // Duración total de la CARRERA (todas las mangas de todas las tandas) —
    // usado por la clasificación estimada con la fórmula:
    //   projectedTotal = totalRaceMs / lapAvgMs
    const totalRaceMangas = require('../config/database').prepare(
      'SELECT COUNT(*) c FROM mangas m JOIN tandas t ON t.id = m.tanda_id WHERE t.race_id = ?'
    ).get(race.id).c;
    // Duración EFECTIVA por manga: si el TimingService está gestionando
    // esta manga ahora mismo, usar su durationMs (refleja el valor que el
    // DS-300 envió en el race_go). En su defecto, fallback al valor de BD
    // (manga_duration_minutes, normalmente el placeholder por defecto 99
    // que no es realista — ver memoria "Log duración manga engañoso").
    const effectiveMangaDurationMs = SessionController._getEffectiveMangaDurationMs(race, manga);
    const totalRaceMs = totalRaceMangas * effectiveMangaDurationMs;

    // Team-race extras: members per lane + current active drivers
    let teamMembersByLane = {};
    let activeDriversByLane = {};
    if (race.format === 'team') {
      const db = require('../config/database');
      lanes.filter(l => !l.is_rest && l.team_id).forEach(l => {
        teamMembersByLane[l.lane] = db.prepare(
          'SELECT id, name FROM drivers WHERE team_id = ? ORDER BY name ASC'
        ).all(l.team_id);
      });
      const shifts = DriverShift.currentByManga(manga.id);
      shifts.forEach(s => { activeDriversByLane[s.lane] = s.driver_name; });
    }

    // Race-wide best lap per lane (for non-active or page reload)
    const raceBestLapsArr = Lap.raceBestByLane(race.id);
    const raceBestLaps = {};
    raceBestLapsArr.forEach(r => { raceBestLaps[r.lane] = { bestLapMs: r.bestLapMs, entityName: r.entityName, categoria: r.entityCategoria || null }; });

    // Next tanda button: show whenever this tanda is finished (regardless of manga state)
    let nextTanda = null;
    if (tanda?.status === 'finished') {
      nextTanda = Tanda.findNextPending(race.id, tanda.number) || null;
    }

    // Next-manga lane assignments per current lane (for "→ Pista X" hint on cards
    // once the current manga finishes). Looks first inside the same tanda, then
    // falls back to the first manga of the next pending tanda.
    const nextLaneByLane = {};
    let nextMangaInfo = null;
    {
      const sameTandaMangas = Manga.findByTanda(manga.tanda_id) || [];
      let next = sameTandaMangas.find(m => m.number > manga.number && m.status !== 'finished');
      if (!next && tanda) {
        const nt = Tanda.findNextPending(race.id, tanda.number);
        if (nt) {
          const ntMangas = Manga.findByTanda(nt.id) || [];
          next = ntMangas.find(m => m.status !== 'finished') || null;
          if (next) nextMangaInfo = { tandaNumber: nt.number, mangaNumber: next.number, sameTanda: false };
        }
      } else if (next) {
        nextMangaInfo = { tandaNumber: tanda.number, mangaNumber: next.number, sameTanda: true };
      }
      if (next) {
        const nextLanes = Manga.getLanes(next.id) || [];
        // Number resting entities in next manga (1..N) so we can show
        // "→ Descanso n/N" on each card.
        const nextRest = nextLanes.filter(nl => nl.is_rest)
          .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
        const nextRestTotal = nextRest.length;
        const nextRestPosByKey = {};
        nextRest.forEach((nl, i) => {
          const key = nl.team_id ? `t${nl.team_id}` : `d${nl.driver_id}`;
          nextRestPosByKey[key] = i + 1;
        });
        // Same alphabetical numbering for CURRENT rest entities (so cardId matches client)
        const curRest = lanes.filter(l => l.is_rest)
          .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
        const curRestPosByKey = {};
        curRest.forEach((cl, i) => {
          const key = cl.team_id ? `t${cl.team_id}` : `d${cl.driver_id}`;
          curRestPosByKey[key] = i + 1;
        });

        lanes.forEach(l => {
          if (!l.team_id && !l.driver_id) return;
          const match = nextLanes.find(nl =>
            (l.team_id   && nl.team_id   === l.team_id) ||
            (l.driver_id && nl.driver_id === l.driver_id)
          );
          if (!match) return;
          const myKey  = l.team_id ? `t${l.team_id}` : `d${l.driver_id}`;
          const cardId = l.is_rest ? `r${curRestPosByKey[myKey] || 0}` : String(l.lane);
          const value  = match.is_rest
            ? { rest: true, pos: nextRestPosByKey[myKey] || 0, total: nextRestTotal }
            : { lane: match.lane };
          nextLaneByLane[cardId] = value;
        });
      }
    }

    // All-race participant totals + remaining pending mangas (for full-race projection).
    // Includes ALL entities assigned to any manga of the race (even tandas not started yet).
    const allParticipants = Lap.aggregateByRace(race.id);
    const db = require('../config/database');
    const isTeamRace = race.format === 'team';
    const idCol = isTeamRace ? 'ml.team_id' : 'ml.driver_id';
    const nameJoin = isTeamRace
      ? 'JOIN teams e ON e.id = ml.team_id'
      : 'JOIN drivers e ON e.id = ml.driver_id';
    const colorCol = isTeamRace ? 'e.color' : 'NULL';

    const allAssigned = db.prepare(`
      SELECT ${idCol} AS entity_id, e.name AS entity_name, ${colorCol} AS color,
             SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending_mangas,
             COUNT(*) AS planned_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      ${nameJoin}
      WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      GROUP BY entity_id
    `).all(race.id);

    const apMap = new Map(allParticipants.map(p => [p.entity_id, p]));
    allAssigned.forEach(a => {
      let p = apMap.get(a.entity_id);
      if (!p) {
        p = {
          entity_id: a.entity_id, entity_name: a.entity_name,
          entity_type: isTeamRace ? 'team' : 'driver',
          color: a.color,
          total_laps: 0, best_lap_ms: null, avg_lap_ms: null,
          total_time_ms: 0, mangas_raced: 0, exit_count: 0,
        };
        allParticipants.push(p);
        apMap.set(a.entity_id, p);
      }
      p.remaining_mangas = a.pending_mangas || 0;
      p.planned_mangas   = a.planned_mangas || 0;
    });

    // FINAL por POSICIÓN (no por estado): una entidad ha acabado cuando no le
    // queda ninguna manga por CORRER después de la manga actual. Funciona tanto
    // en vivo (mangas futuras 'pending') como revisando una carrera ya cerrada
    // (todas 'finished'): lo que importa es la posición, no el estado.
    const racesAfterRows = db.prepare(`
      SELECT DISTINCT CASE WHEN ml.team_id IS NOT NULL THEN 't'||ml.team_id ELSE 'd'||ml.driver_id END AS ekey
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE m.race_id = ? AND ml.is_rest = 0
        AND (ml.team_id IS NOT NULL OR ml.driver_id IS NOT NULL)
        AND ( t.number > ? OR (t.number = ? AND m.number > ?) )
    `).all(race.id, tanda.number, tanda.number, manga.number);
    const racesAfter = new Set(racesAfterRows.map(r => r.ekey));
    allParticipants.forEach(p => {
      if (p.entity_id == null || typeof p.entity_id === 'string') { p.finished_race = false; return; }
      const k = `${p.entity_type === 'team' ? 't' : 'd'}${p.entity_id}`;
      p.finished_race = !racesAfter.has(k);
    });

    // Carrera ACABADA: esta es la última manga de la carrera (no hay ninguna
    // después, por posición) y ya ha finalizado. Cuando es así, la columna PRÓX
    // muestra FINAL para todos (nadie tiene próxima manga). Por posición, así no
    // se dispara al revisar mangas intermedias de una carrera ya cerrada.
    const hasMangaAfter = db.prepare(`
      SELECT 1 FROM mangas m JOIN tandas t ON t.id = m.tanda_id
      WHERE m.race_id = ? AND ( t.number > ? OR (t.number = ? AND m.number > ?) ) LIMIT 1
    `).get(race.id, tanda.number, tanda.number, manga.number);
    const raceOver = !hasMangaAfter && (manga.status === 'finished' || manga.status === 'cancelled');

    const hasBestLaps  = true;
    const hasQrCheckin = true;

    const isSimulating = SerialService.isSimulating;
    const isBart       = SerialService.isBart;
    const isPaused     = TimingService.isPaused && isActive;
    res.render('races/live', { t: req.t, race, manga, tanda, lanes, laps, isActive, standings, projection, prevLapsByLane, totalMangas, totalTandas, totalRaceMs, effectiveMangaDurationMs, teamMembersByLane, activeDriversByLane, raceBestLaps, hasBestLaps, hasQrCheckin, nextTanda, allParticipants, nextLaneByLane, nextMangaInfo, raceOver, isSimulating, isBart, isPaused });
  }

  // GET /races/:id/mangas/:mangaId/panel/:type  (standalone popup)
  static panel(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const laps     = Lap.findByManga(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;
    const isPaused  = TimingService.isPaused && isActive;

    // All-race participants (includes pending tandas) — see live() for details
    const allParticipants = Lap.aggregateByRace(race.id);
    const db = require('../config/database');
    const isTeamRace = race.format === 'team';
    const idCol = isTeamRace ? 'ml.team_id' : 'ml.driver_id';
    const nameJoin = isTeamRace
      ? 'JOIN teams e ON e.id = ml.team_id'
      : 'JOIN drivers e ON e.id = ml.driver_id';
    const colorCol = isTeamRace ? 'e.color' : 'NULL';
    const allAssigned = db.prepare(`
      SELECT ${idCol} AS entity_id, e.name AS entity_name, ${colorCol} AS color,
             SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending_mangas,
             COUNT(*) AS planned_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      ${nameJoin}
      WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      GROUP BY entity_id
    `).all(race.id);
    const apMap = new Map(allParticipants.map(p => [p.entity_id, p]));
    allAssigned.forEach(a => {
      let p = apMap.get(a.entity_id);
      if (!p) {
        p = {
          entity_id: a.entity_id, entity_name: a.entity_name,
          entity_type: isTeamRace ? 'team' : 'driver', color: a.color,
          total_laps: 0, best_lap_ms: null, avg_lap_ms: null,
          total_time_ms: 0, mangas_raced: 0, exit_count: 0,
        };
        allParticipants.push(p);
        apMap.set(a.entity_id, p);
      }
      p.remaining_mangas = a.pending_mangas || 0;
      p.planned_mangas   = a.planned_mangas || 0;
    });

    // ── Carriles SIN entidad asignada (datos de test / pruebas) ───────────
    // El query anterior excluye filas con team_id/driver_id = NULL, lo que
    // colapsa cualquier dato de prueba en una sola "fila null". Para que el
    // popup muestre algo útil, añadimos un participante sintético por LANE
    // basándonos en manga_lanes con entidad nula. Las stats salen de laps.
    const lanesWithoutEntity = db.prepare(`
      SELECT ml.lane,
             COUNT(DISTINCT m.id) AS planned_mangas,
             SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending_mangas
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      WHERE m.race_id = ?
        AND ml.is_rest = 0
        AND ml.team_id IS NULL AND ml.driver_id IS NULL
      GROUP BY ml.lane
    `).all(race.id);

    const lapStatsByLane = db.prepare(`
      SELECT lane,
             COUNT(*)                                             AS total_laps,
             MIN(CASE WHEN is_exit = 0 AND is_warmup = 0
                      THEN lap_time_ms END)                       AS best_lap_ms,
             AVG(CASE WHEN is_warmup = 0 THEN lap_time_ms END)    AS avg_lap_ms,
             COUNT(DISTINCT manga_id)                             AS mangas_raced
      FROM laps
      WHERE race_id = ? AND is_ghost = 0
        AND team_id IS NULL AND driver_id IS NULL
      GROUP BY lane
    `).all(race.id);
    const lapByLane = new Map(lapStatsByLane.map(r => [r.lane, r]));

    lanesWithoutEntity.forEach(l => {
      const stats = lapByLane.get(l.lane) || {};
      allParticipants.push({
        entity_id:        `lane_${l.lane}`,
        entity_name:      `Pista ${l.lane}`,
        entity_type:      isTeamRace ? 'team' : 'driver',
        color:            null,
        total_laps:       stats.total_laps  || 0,
        best_lap_ms:      stats.best_lap_ms ?? null,
        avg_lap_ms:       stats.avg_lap_ms  ?? null,
        total_time_ms:    0,
        mangas_raced:     stats.mangas_raced || 0,
        exit_count:       0,
        planned_mangas:   l.planned_mangas  || 0,
        remaining_mangas: l.pending_mangas  || 0,
      });
    });

    // Quita la fila "null" sintética que sale de aggregateByRace cuando hay
    // laps sin team_id ni driver_id: ya están representadas por las "Pista N"
    for (let i = allParticipants.length - 1; i >= 0; i--) {
      if (allParticipants[i].entity_id == null) allParticipants.splice(i, 1);
    }

    // Previous race-wide laps per lane (excludes this manga) — same data the
    // live view uses to project totals; the panel needs it to match exactly.
    const prevLapsByLane = {};
    lanes.filter(l => !l.is_rest && (l.team_id || l.driver_id)).forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    // Mejor vuelta por carril (race-wide) — necesario para el panel fastest
    const raceBestLapsArr = Lap.raceBestByLane(race.id);
    const raceBestLaps = {};
    raceBestLapsArr.forEach(r => { raceBestLaps[r.lane] = { bestLapMs: r.bestLapMs, entityName: r.entityName, categoria: r.entityCategoria || null }; });

    // Minimapa: para el panel `track` necesitamos el trazado del circuito
    // (imagen base64 + polilínea) y, por carril, la última vuelta para
    // calcular la posición inicial al abrir la ventana.
    let circuit = null, trackOutline = [], lastLapByLane = {}, circuitsLayout = [];
    if (req.params.type === 'track') {
      const Circuit = require('../models/Circuit');
      circuit = race.circuit_id ? Circuit.findById(race.circuit_id) : null;
      if (circuit) trackOutline = Circuit.getTrackOutline(circuit);

      // Reparto de carriles por circuito (circuits_config = [6] o [6,6,6,6]) +
      // orientación guardada por circuito (girado 90° / espejo) para el minimapa
      // en rejilla. La orientación se persiste en settings por circuito.
      const Settings = require('../models/Settings');
      let cfg;
      try { cfg = JSON.parse((circuit && circuit.circuits_config) || race.circuits_config || '[]'); }
      catch { cfg = []; }
      if (!Array.isArray(cfg) || cfg.length === 0) cfg = [race.lanes_count || 1];
      let savedOrient = [];
      try { savedOrient = JSON.parse(Settings.get(`minimap_orient:c${circuit ? circuit.id : 0}`, '[]')) || []; }
      catch { savedOrient = []; }
      let laneStart = 1;
      circuitsLayout = cfg.map((cnt, i) => {
        const o = savedOrient[i] || {};
        const item = { index: i, laneStart, laneCount: cnt,
                       rot: [0,90,180,270].includes(+o.rot) ? +o.rot : 0,
                       flip: !!o.flip };
        laneStart += cnt;
        return item;
      });

      const db = require('../config/database');
      // Última vuelta no-fantasma por carril en esta manga
      const rows = db.prepare(`
        SELECT l.lane, l.lap_time_ms, l.timestamp
        FROM laps l
        INNER JOIN (
          SELECT lane, MAX(id) AS maxId FROM laps
          WHERE manga_id = ? AND is_ghost = 0
          GROUP BY lane
        ) m ON m.lane = l.lane AND m.maxId = l.id
        WHERE l.manga_id = ?
      `).all(manga.id, manga.id);
      rows.forEach(r => {
        lastLapByLane[r.lane] = {
          lapTimeMs:    r.lap_time_ms,
          timestampMs:  r.timestamp ? Date.parse(r.timestamp + 'Z') || Date.parse(r.timestamp) : null,
        };
      });
    }

    let view;
    if (req.params.type === 'fastest')      view = 'races/live-panel-fastest';
    else if (req.params.type === 'track')   view = 'races/live-panel-track';
    else                                    view = 'races/live-panel';

    const effectiveMangaDurationMs = SessionController._getEffectiveMangaDurationMs(race, manga);
    // Totales para la cabecera: "Tanda X/total · Manga Y/total".
    const totalTandas        = Tanda.findByRace(race.id).length;
    const totalMangasInTanda = Manga.findByTanda(manga.tanda_id).length;

    // Proyección ÚNICA (media-based, desde BD) para el arranque del panel —
    // misma función que Le Mans y live-stats. En vivo, el socket 'standings'
    // trae getStandings().projection (que ES esta misma función).
    const projection = TimingService.buildRaceProjection(race.id);

    res.render(view, {
      t: req.t, race, manga, tanda, lanes, laps, isActive, standings, isPaused,
      allParticipants, prevLapsByLane, raceBestLaps,
      circuit, trackOutline, lastLapByLane, circuitsLayout,
      effectiveMangaDurationMs, totalTandas, totalMangasInTanda, projection,
    });
  }

  // POST /races/:id/circuit-orientation
  // Guarda la orientación (rot 0/90/180/270 + espejo) por circuito del minimapa.
  // Body: { orientations: [{ rot, flip }, ...] }. Se persiste por circuito.
  static saveCircuitOrientation(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'not_found' });
    const arr = Array.isArray(req.body?.orientations) ? req.body.orientations : [];
    const clean = arr.map(o => ({
      rot:  [0,90,180,270].includes(+o?.rot) ? +o.rot : 0,
      flip: !!o?.flip,
    }));
    require('../models/Settings').set(`minimap_orient:c${race.circuit_id || 0}`, JSON.stringify(clean));
    res.json({ ok: true });
  }

  // GET /races/:id/mangas/:mangaId/tv  (fullscreen TV projection)
  static tv(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const tanda    = Tanda.findById(manga.tanda_id);
    const lanes    = Manga.getLanes(manga.id);
    const isActive = TimingService.activeMangaId === manga.id;
    const standings = isActive ? TimingService.getStandings() : null;

    const prevLapsByLane = {};
    lanes.filter(l => !l.is_rest).forEach(l => {
      prevLapsByLane[l.lane] = Lap.raceCountByEntity(race.id, manga.id, l.team_id, l.driver_id);
    });

    res.render('races/tv', { t: req.t, race, manga, tanda, lanes, isActive, standings, prevLapsByLane });
  }

  // GET /races/:id/lemans  (Le Mans-style live classification board)
  static lemans(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const db   = require('../config/database');
    const lang = req.session?.lang || 'es';

    // Aggregate laps per unique team name across entire race, enriched with catalog metadata
    const teamRows = db.prepare(`
      SELECT
        t.id,
        t.name,
        t.color AS color,
        COUNT(CASE WHEN l.is_ghost=0 AND l.lap_number>0 THEN 1 END) AS total_laps,
        MIN(CASE WHEN l.is_ghost=0 AND l.is_exit=0 AND l.is_warmup=0 AND l.lap_number>1
                  AND l.lap_time_ms >= (SELECT COALESCE(min_lap_ms, 0) FROM races WHERE id = t.race_id)
                 THEN l.lap_time_ms END) AS best_lap_ms,
        -- Media SIMPLE de tiempos de vuelta, sin fantasmas ni warmup (= TicTac).
        AVG(CASE WHEN l.is_ghost=0 AND l.is_warmup=0 THEN l.lap_time_ms END) AS avg_lap_ms,
        MAX(tc.categoria)  AS categoria,
        MAX(tc.coche)      AS coche,
        MAX(tc.car_photo)  AS car_photo,
        MAX(tc.country)    AS country
      FROM teams t
      LEFT JOIN laps l ON l.team_id = t.id
      LEFT JOIN teams_catalog tc ON tc.name = t.name
      WHERE t.race_id = ?
      GROUP BY t.id
      ORDER BY total_laps DESC, best_lap_ms ASC
    `).all(race.id);

    // Laps from completed mangas only (for delta tracking in client)
    const prevLapRows = db.prepare(`
      SELECT l.team_id AS id, COUNT(*) AS prev_laps
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      WHERE l.race_id = ? AND l.is_ghost=0 AND l.lap_number>0
        AND m.status = 'finished'
      GROUP BY l.team_id
    `).all(race.id);
    const prevLapMap = {};
    prevLapRows.forEach(r => { prevLapMap[r.id] = r.prev_laps; });

    // Most recent active driver per team (across all driver_shifts for this race)
    const shiftRows = db.prepare(`
      SELECT ds.team_id, ds.driver_name
      FROM driver_shifts ds
      JOIN teams t ON t.id = ds.team_id
      WHERE t.race_id = ?
      ORDER BY ds.id DESC
    `).all(race.id);
    const driverMap = {};
    shiftRows.forEach(d => { if (!driverMap[d.team_id]) driverMap[d.team_id] = d.driver_name; });

    // Manga activa: la verdad en memoria de TimingService (la BD puede ir
    // desfasada). Mapeo carril → team_id para las actualizaciones en vivo.
    let activeMangaId = TimingService.activeMangaId || null;
    let laneToTeam    = {};
    if (activeMangaId) {
      db.prepare(`
        SELECT ml.lane, ml.team_id
        FROM manga_lanes ml
        WHERE ml.manga_id = ? AND ml.is_rest = 0 AND ml.team_id IS NOT NULL
      `).all(activeMangaId).forEach(r => { laneToTeam[r.lane] = r.team_id; });
    }

    // ── Proyección ÚNICA (media-based, desde BD) ─────────────────────────────
    // La MISMA que consume el panel/directo y live-stats. Indexada por entidad.
    const projList = TimingService.buildRaceProjection(race.id);
    const projById = new Map(projList.map(p => [p.entityId, p]));

    // Duración efectiva de manga (real del DS, no el placeholder), solo para el
    // countdown de cabecera de la vista.
    const durManga = db.prepare(
      "SELECT * FROM mangas WHERE race_id=? AND (status='active' OR actual_duration_ms>0) ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, id DESC LIMIT 1"
    ).get(race.id) || { id: -1, actual_duration_ms: 0 };
    const effectiveMangaDurationMs = SessionController._getEffectiveMangaDurationMs(race, durManga);

    // Tiempo restante de la manga activa (solo para el reloj de cabecera).
    const liveStand = (TimingService.activeMangaId === activeMangaId) ? TimingService.getStandings() : null;
    const currentRemainingMs = (liveStand && liveStand.remainingMs > 0) ? liveStand.remainingMs : 0;
    const onTrackTeams = Object.values(laneToTeam);   // ahora son team_id
    const teamToLane = {};
    Object.entries(laneToTeam).forEach(([lane, id]) => { teamToLane[id] = parseInt(lane, 10); });

    // Cabecera: manga X/total + estado de carrera.
    const totalMangas = db.prepare('SELECT COUNT(*) AS n FROM mangas WHERE race_id = ?').get(race.id).n;
    let mangaNumber = null;
    if (activeMangaId) {
      const am = db.prepare('SELECT number FROM mangas WHERE id = ?').get(activeMangaId);
      mangaNumber = am?.number ?? null;
    }
    const raceStatus = TimingService.isRunning ? 'running'
                     : TimingService.isPaused ? 'paused'
                     : 'finished';

    // Metadatos de catálogo por equipo (foto, coche, categoría…) indexados.
    const metaById = new Map(teamRows.map(t => [t.id, t]));
    const maxLaps  = Math.max(0, ...teamRows.map(t => t.total_laps));

    // El ORDEN y los números de proyección vienen de la función ÚNICA. Cada fila
    // solo enriquece con metadatos de catálogo/carril; la vista NO recalcula.
    const standings = projList.map((p, i) => {
      const t = metaById.get(p.entityId) || {};
      return {
        position:        i + 1,
        id:              p.entityId,
        name:            p.name,
        color:           t.color ?? null,
        totalLaps:       p.totalLaps,
        prevLaps:        prevLapMap[p.entityId] ?? 0,
        bestLapMs:       p.bestLapMs,
        avgLapMs:        p.avgLapMs,
        // Proyección ÚNICA (media-based) ya calculada en el servidor.
        projectedRaw:    p.projectedRaw,
        projected:       p.projectedTotal != null ? Math.round(p.projectedTotal) : null,
        gapV:            p.gapV,
        gapSec:          p.gapSec,
        avgToCatch:      p.avgToCatch,
        // Posición fraccionaria al terminar (coma de la última manga): la usa el
        // cliente para que la distancia/gap no colapse a vueltas enteras.
        lastMangaComa:   p.lastMangaComa ?? 0,
        provisional:     p.provisional || false,
        futureRemMs:     p.futureRemMs,   // tiempo de mangas futuras (sin la activa)
        onTrack:         p.onTrack || onTrackTeams.includes(p.entityId),
        currentLane:     teamToLane[p.entityId] ?? null,
        gap:             maxLaps - p.totalLaps,
        currentDriver:   driverMap[p.entityId] ?? null,
        categoria:       t.categoria  ?? null,
        coche:           t.coche      ?? null,
        car_photo:       t.car_photo  ?? null,
        country:         t.country    ?? null,
      };
    });

    const isActive = TimingService.activeMangaId != null;

    res.render('races/lemans', {
      t: req.t, race, lang, standings,
      activeMangaId, laneToTeam, isActive,
      effectiveMangaDurationMs, currentRemainingMs,
      mangaNumber, totalMangas, raceStatus,
    });
  }

  // GET /races/:id/results
  static results(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    const laneSequence = Race.getLaneSequence(race);
    const aggregate    = Lap.aggregateByRace(race.id);

    // Add per-lane breakdown for each entity
    const results = aggregate.map(row => ({
      ...row,
      perLane: Lap.perLaneByEntity(race.id, row.entity_id, row.entity_type)
    }));

    // ── Consistencia (misma métrica que live-stats) ───────────────────────────
    // Dos niveles, ambos con robustConsistency de ../lib/consistency:
    //   A) POR CELDA (entidad × carril): la parrilla agrupa por carril
    //      (GROUP BY l.lane en perLaneByEntity; en "repetir carril" una celda
    //      puede abarcar >1 manga del mismo carril), así que la consistencia de
    //      la celda se calcula sobre las vueltas elegibles de esa entidad en ese
    //      carril. Variante SIN salidas/pits (ritmo puro): is_exit=0 + filtro
    //      incidentes.
    //   B) DE CARRERA (por entidad): dos variantes como en live-stats —
    //      SIN (is_exit=0 + filtro incidentes) y CON (todas, incluye is_exit,
    //      sin filtro). Se agrega por ENTIDAD (team_id / driver_id), lo que en
    //      resistencia equivale al NOMBRE (una entidad = un nombre; en equipos
    //      duplicados por tanda comparten team_id).
    // Filtro de elegibilidad idéntico al de live-stats: !is_ghost && !is_warmup
    // && lap_number>1 && lap_time_ms >= min_lap_ms.
    {
      const dbc = require('../config/database');
      const minLap = race.min_lap_ms || 0;
      const eligibleRows = dbc.prepare(`
        SELECT
          CASE WHEN l.team_id IS NOT NULL THEN 'team_'||l.team_id ELSE 'driver_'||l.driver_id END AS key,
          l.lane AS lane,
          l.manga_id AS manga_id,
          l.lap_time_ms AS t,
          l.is_exit AS is_exit
        FROM laps l
        JOIN mangas m ON m.id = l.manga_id
        JOIN tandas tt ON tt.id = m.tanda_id
        WHERE tt.race_id = ?
          AND l.is_ghost = 0 AND l.is_warmup = 0
          AND l.lap_number > 1 AND l.lap_time_ms >= ${minLap}
      `).all(race.id);

      // Acumuladores: por (key,lane) SIN; por (key,lane,manga) SIN (para las
      // celdas por-ocurrencia); por key SIN y CON.
      const cellClean     = new Map();   // `${key}|${lane}` -> [t]  (SIN salidas)
      const cellMangaClean = new Map();  // `${key}|${lane}|${manga_id}` -> [t]  (SIN salidas)
      const raceClean = new Map();   // key -> [t]  (SIN salidas)
      const raceAll   = new Map();   // key -> [t]  (CON salidas/pits)
      for (const r of eligibleRows) {
        let all = raceAll.get(r.key);
        if (!all) { all = []; raceAll.set(r.key, all); }
        all.push(r.t);
        if (!r.is_exit) {
          let rc = raceClean.get(r.key);
          if (!rc) { rc = []; raceClean.set(r.key, rc); }
          rc.push(r.t);
          const ck = `${r.key}|${r.lane}`;
          let cc = cellClean.get(ck);
          if (!cc) { cc = []; cellClean.set(ck, cc); }
          cc.push(r.t);
          const cmk = `${r.key}|${r.lane}|${r.manga_id}`;
          let cmc = cellMangaClean.get(cmk);
          if (!cmc) { cmc = []; cellMangaClean.set(cmk, cmc); }
          cmc.push(r.t);
        }
      }
      // Expuesto al bloque per-ocurrencia (más abajo) para no re-consultar.
      results._cellMangaClean = cellMangaClean;

      results.forEach(r => {
        const key = r.entity_type === 'team' ? `team_${r.entity_id}` : `driver_${r.entity_id}`;
        // A) por celda/carril (SIN)
        (r.perLane || []).forEach(pl => {
          const c = robustConsistency(cellClean.get(`${key}|${pl.lane}`) || [], MIN_CONSISTENCY_LAPS);
          pl.consistency      = c ? c.pct   : null;
          pl.consistencyLevel = c ? c.level : null;
          pl.consistencyStdMs = c ? c.stdMs : null;
        });
        // B) de carrera (SIN)
        const cs = robustConsistency(raceClean.get(key) || [], MIN_CONSISTENCY_LAPS);
        r.raceConsistency      = cs ? cs.pct   : null;
        r.raceConsistencyLevel = cs ? cs.level : null;
        r.raceConsistencyStdMs = cs ? cs.stdMs : null;
        // B) de carrera (CON salidas/pits, sin filtro de incidentes)
        const ca = robustConsistency(raceAll.get(key) || [], MIN_CONSISTENCY_LAPS, { filterIncidents: false });
        r.raceConsistencyAll      = ca ? ca.pct   : null;
        r.raceConsistencyAllLevel = ca ? ca.level : null;
        r.raceConsistencyAllStdMs = ca ? ca.stdMs : null;
      });
    }

    // ── Parrilla por OCURRENCIA (solo pasadas / repetir-carril) ────────────────
    // Cuando race.passes>1 || race.lane_repeat>1, una entidad corre el MISMO
    // carril en varias mangas y hay que separarlas para comparar ("PISTA 1,
    // PISTA 1"). Definición de ocurrencia: para (entidad, carril), la k-ésima
    // manga (ordenada por number) en que corrió ese carril = ocurrencia k.
    // Construimos: occColumns (columnas ordenadas siguiendo el lane_sequence,
    // con las ocurrencias de cada carril ADYACENTES) y, por fila, un índice de
    // celdas por (lane, occ). Cuando passes==1 && lane_repeat==1 NO se toca nada.
    const perOccurrence = (race.passes > 1) || (race.lane_repeat > 1);
    let occColumns = null;
    if (perOccurrence) {
      const cellMangaClean = results._cellMangaClean || new Map();
      // Nº de ocurrencias por carril, derivado de los datos (max entre entidades).
      const occCountByLane = new Map();
      results.forEach(r => {
        const key = r.entity_type === 'team' ? `team_${r.entity_id}` : `driver_${r.entity_id}`;
        const rows = Lap.perLaneMangaByEntity(race.id, r.entity_id, r.entity_type);
        // Agrupar por carril, ya vienen ORDER BY lane, manga.number → occ = índice+1.
        const byLane = new Map();
        rows.forEach(row => {
          if (!byLane.has(row.lane)) byLane.set(row.lane, []);
          byLane.get(row.lane).push(row);
        });
        r.occByKey = {};              // `${lane}-${occ}` -> celda
        r.occCellCount = 0;
        byLane.forEach((laneRows, lane) => {
          const K = laneRows.length;
          const prev = occCountByLane.get(lane) || 0;
          if (K > prev) occCountByLane.set(lane, K);
          laneRows.forEach((row, i) => {
            const occ = i + 1;
            const c = robustConsistency(
              cellMangaClean.get(`${key}|${lane}|${row.manga_id}`) || [], MIN_CONSISTENCY_LAPS);
            const cell = {
              lane,
              occ,
              occCount: K,
              mangaNumber: row.manga_number,
              manga_id: row.manga_id,
              best_ms: row.best_ms,
              avg_ms: row.avg_ms != null ? Math.round(row.avg_ms) : null,
              worst_ms: row.worst_ms,
              laps: row.laps,
              exit_count: row.exit_count,
              pit_stop_count: row.pit_stop_count,
              pit_stop_laps: row.pit_stop_laps,
              consistency:      c ? c.pct   : null,
              consistencyLevel: c ? c.level : null,
              consistencyStdMs: c ? c.stdMs : null,
            };
            r.occByKey[`${lane}-${occ}`] = cell;
            r.occCellCount++;
          });
        });
      });

      // Orden de carriles siguiendo el lane_sequence (sin 0 = descanso, sin
      // duplicados). Fallback: orden numérico de los carriles con datos.
      const seqLanes = [];
      const seen = new Set();
      (laneSequence || []).forEach(l => {
        if (l && l !== 0 && !seen.has(l) && occCountByLane.has(l)) { seen.add(l); seqLanes.push(l); }
      });
      // Carriles con datos que no aparecen en la secuencia → al final, numérico.
      [...occCountByLane.keys()].sort((a, b) => a - b).forEach(l => {
        if (!seen.has(l)) { seen.add(l); seqLanes.push(l); }
      });

      // Columnas: por cada carril, sus K ocurrencias ADYACENTES.
      const ordinal = ['1ª','2ª','3ª','4ª','5ª','6ª','7ª','8ª'];
      occColumns = [];
      seqLanes.forEach(lane => {
        const K = occCountByLane.get(lane) || 1;
        for (let occ = 1; occ <= K; occ++) {
          occColumns.push({
            lane,
            occ,
            occCount: K,
            key: `${lane}-${occ}`,
            label: K > 1 ? `PISTA ${lane} · ${ordinal[occ - 1] || occ + 'ª'}` : `PISTA ${lane}`,
          });
        }
      });
    }
    delete results._cellMangaClean;

    // Starting lane per entity: first non-rest assignment in tanda+manga order.
    // Teams/drivers that start resting will pick up the lane of the manga where
    // they first actually race (works correctly even with multi-circuit rest).
    const db = require('../config/database');
    const startRows = db.prepare(`
      SELECT ml.lane, ml.team_id, ml.driver_id
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND ml.is_rest = 0
      ORDER BY t.number ASC, m.number ASC, ml.lane ASC
    `).all(race.id);
    const startLaneByEntity = {};
    startRows.forEach(r => {
      const key = r.team_id ? `team_${r.team_id}` : `driver_${r.driver_id}`;
      if (startLaneByEntity[key] == null) startLaneByEntity[key] = r.lane;
    });

    // Race overall fastest lap (across all entities & lanes) — for highlight
    let raceBestLapMs = null, raceBestEntity = null, raceBestLane = null;
    for (const r of results) {
      for (const pl of r.perLane) {
        if (pl.best_ms != null && (raceBestLapMs == null || pl.best_ms < raceBestLapMs)) {
          raceBestLapMs = pl.best_ms;
          raceBestEntity = r.entity_name;
          raceBestLane = pl.lane;
        }
      }
    }

    const tandasRaw = Tanda.findByRace(race.id);
    const tandas = tandasRaw.map(t => ({
      ...t,
      mangas: Manga.findByTanda(t.id)
    }));

    // ── Progression chart data ─────────────────────────────────────────────
    // For each entity collect every racing lap with enough context to filter
    // by lane / manga / driver later in the UI. Exits & pit-stops are kept
    // (flagged) so the user can choose whether to include them.
    const progressionRows = db.prepare(`
      SELECT l.id, l.lane, l.lap_number, l.lap_time_ms, l.elapsed_ms,
             l.team_id, l.driver_id, l.is_exit, l.is_pit_stop,
             l.manga_id, m.number AS manga_number, m.started_at AS manga_started_at,
             d.name AS lap_driver_name
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
      ORDER BY t.number ASC, m.number ASC, l.lane ASC, l.lap_number ASC
    `).all(race.id);

    // For team races, resolve which driver was driving each lap from driver_shifts
    let shiftsByMangaLane = {};
    if (race.format === 'team') {
      const shifts = db.prepare(`
        SELECT manga_id, lane, driver_name, started_at
        FROM driver_shifts WHERE race_id = ?
        ORDER BY manga_id, lane, started_at ASC
      `).all(race.id);
      shifts.forEach(s => {
        const k = `${s.manga_id}_${s.lane}`;
        if (!shiftsByMangaLane[k]) shiftsByMangaLane[k] = [];
        shiftsByMangaLane[k].push({ driver: s.driver_name, ts: new Date(s.started_at).getTime() });
      });
    }
    function resolveDriver(row) {
      if (row.lap_driver_name) return row.lap_driver_name;
      if (race.format !== 'team') return null;
      const k = `${row.manga_id}_${row.lane}`;
      const shifts = shiftsByMangaLane[k];
      if (!shifts || shifts.length === 0) return null;
      const mangaStart = new Date(row.manga_started_at).getTime();
      const lapTs = mangaStart + (row.elapsed_ms || 0);
      let driver = shifts[0].driver;
      for (const s of shifts) {
        if (s.ts <= lapTs) driver = s.driver; else break;
      }
      return driver;
    }

    const progressionByEntity = {};
    results.forEach(r => {
      progressionByEntity[`${r.entity_type}_${r.entity_id}`] = {
        name: r.entity_name, color: r.color, laps: [],
      };
    });
    progressionRows.forEach(row => {
      const key = row.team_id ? `team_${row.team_id}` : `driver_${row.driver_id}`;
      const e = progressionByEntity[key];
      if (!e) return;
      e.laps.push({
        lane:      row.lane,
        ms:        row.lap_time_ms,
        manga:     row.manga_number,
        driver:    resolveDriver(row) || '—',
        isExit:    !!row.is_exit,
        isPitStop: !!row.is_pit_stop,
      });
    });

    // ── Posiciones por TIEMPO de carrera (tandas fusionadas) ──────────────
    // Eje X = tiempo total de carrera (min), una sola línea continua (las tandas
    // se concatenan). En cada cierre de manga la posición = ranking por vueltas
    // PROYECTADAS al final (vueltas hechas + mangas que le quedan × duración ÷
    // media de vuelta hasta ese momento). Así un coche de la tanda 2 se compara
    // por dónde va a ACABAR, no por las pocas vueltas que lleva → pelea real.
    const mangaSeq = db.prepare(`
      SELECT m.id, m.number AS manga_number, t.number AS tanda_number, m.actual_duration_ms
      FROM mangas m
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ?
      ORDER BY t.number ASC, m.number ASC
    `).all(race.id);

    const lapTotalsByManga = db.prepare(`
      SELECT l.manga_id, l.team_id, l.driver_id,
             COUNT(*) AS laps,
             SUM(CASE WHEN l.is_warmup = 0 THEN l.lap_time_ms END) AS clean_time,
             SUM(CASE WHEN l.is_warmup = 0 THEN 1 ELSE 0 END)      AS clean_laps,
             SUM(l.is_pit_stop)                                    AS pits
      FROM laps l
      WHERE l.race_id = ? AND l.is_ghost = 0
      GROUP BY l.manga_id, l.team_id, l.driver_id
    `).all(race.id);

    const entityKeys = results.map(r => `${r.entity_type}_${r.entity_id}`);
    const entityKeyOf = (r) => r.team_id ? `team_${r.team_id}` : `driver_${r.driver_id}`;

    const lapsIdx = new Map();
    lapTotalsByManga.forEach(r => {
      if (!lapsIdx.has(r.manga_id)) lapsIdx.set(r.manga_id, []);
      lapsIdx.get(r.manga_id).push(r);
    });

    // Mangas asignadas (a correr) por entidad → para saber cuántas le quedan.
    const assignedRows = db.prepare(`
      SELECT CASE WHEN ml.team_id IS NOT NULL THEN 'team_'||ml.team_id ELSE 'driver_'||ml.driver_id END AS k
      FROM manga_lanes ml JOIN mangas m ON m.id = ml.manga_id
      WHERE m.race_id = ? AND ml.is_rest = 0 AND (ml.team_id IS NOT NULL OR ml.driver_id IS NOT NULL)
    `).all(race.id);
    const assignedCount = {};
    assignedRows.forEach(r => { assignedCount[r.k] = (assignedCount[r.k] || 0) + 1; });

    const durDefault = (race.manga_duration_minutes || 0) * 60000;
    const cumE = {};
    entityKeys.forEach(k => { cumE[k] = { laps: 0, cleanTime: 0, cleanCount: 0, raced: 0 }; });

    const N = entityKeys.length;
    const positionPoints = {};
    const gapPoints = {};   // gap de VUELTAS frente al líder, por tiempo de carrera
    entityKeys.forEach(k => { positionPoints[k] = []; gapPoints[k] = []; });
    let cumTimeMs = 0;
    let mangaOrd  = 0;   // ordinal de manga disputada (M1, M2, … para el eje X del gap)

    mangaSeq.forEach(m => {
      const mLaps = lapsIdx.get(m.id);
      if (!mLaps || mLaps.length === 0) return;   // manga sin disputar
      mangaOrd++;
      const durMs = m.actual_duration_ms || durDefault;
      const tStartMin = +(cumTimeMs / 60000).toFixed(2);   // inicio de esta manga
      cumTimeMs += durMs;
      const pitThisManga = {};
      mLaps.forEach(r => {
        const k = entityKeyOf(r);
        if (!cumE[k]) return;
        cumE[k].laps       += r.laps;
        cumE[k].cleanTime  += r.clean_time || 0;
        cumE[k].cleanCount += r.clean_laps || 0;
        cumE[k].raced      += 1;
        pitThisManga[k]     = (pitThisManga[k] || 0) + (r.pits || 0);
      });
      // Proyección causal de vueltas al final (datos sólo hasta este cierre).
      const proj = {};
      entityKeys.forEach(k => {
        const c = cumE[k];
        if (c.laps === 0) { proj[k] = 0; return; }   // aún no ha corrido → al fondo
        const media     = c.cleanCount > 0 ? c.cleanTime / c.cleanCount : null;
        const remaining = Math.max(0, (assignedCount[k] || 0) - c.raced);
        proj[k] = media ? c.laps + (remaining * durDefault) / media : c.laps;
      });
      const sorted = [...entityKeys].sort((a, b) => proj[b] - proj[a] || cumE[b].laps - cumE[a].laps);
      const tMin = +(cumTimeMs / 60000).toFixed(2);
      // Cada entidad SALE desde la última posición (P=N) al entrar (inicio de su
      // 1ª manga) y desde ahí la línea sube/baja según su proyección mejora o no.
      // Solo se pinta a quien ya ha corrido (sin líneas planas de quien no salió).
      sorted.forEach((k, idx) => {
        if (proj[k] <= 0) return;
        if (positionPoints[k].length === 0) positionPoints[k].push({ x: tStartMin, y: N });
        positionPoints[k].push({ x: tMin, y: idx + 1 });
      });
      // Gap de vueltas frente al líder (el que MÁS vueltas reales lleva a este
      // cierre), por manga. Líder = 0; el resto NEGATIVO (vueltas perdidas).
      const leaderLaps = Math.max(0, ...entityKeys.map(k => cumE[k].laps));
      entityKeys.forEach(k => {
        if (cumE[k].laps <= 0) return;   // aún no ha corrido
        gapPoints[k].push({ x: mangaOrd, y: cumE[k].laps - leaderLaps, pit: pitThisManga[k] || 0 });
      });
    });

    const positionData = {};
    const gapData = {};
    results.forEach(r => {
      const k = `${r.entity_type}_${r.entity_id}`;
      positionData[k] = { name: r.entity_name, color: r.color, points: positionPoints[k] };
      gapData[k]      = { name: r.entity_name, color: r.color, points: gapPoints[k] };
    });

    // ── Advanced stats por entidad (race-wide) ────────────────────────────
    // Repite el cálculo de LiveStatsController.buildEntityStats pero a nivel
    // de carrera completa (no de una manga), y añade evolución por manga.
    const advancedLaps = db.prepare(`
      SELECT l.team_id, l.driver_id, l.manga_id, l.lane,
             l.lap_time_ms, l.elapsed_ms, l.is_exit, l.is_pit_stop, l.is_ghost, l.is_warmup,
             m.number AS manga_number
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND l.is_ghost = 0
      ORDER BY t.number ASC, m.number ASC, l.elapsed_ms ASC
    `).all(race.id);

    const advByEntity = new Map();
    results.forEach(r => {
      advByEntity.set(`${r.entity_type}_${r.entity_id}`, {
        key:    `${r.entity_type}_${r.entity_id}`,
        name:   r.entity_name,
        color:  r.color,
        lanes:  new Map(),   // lane (pista) -> [laps]  (en slot el carril manda)
        all:    [],
      });
    });
    advancedLaps.forEach(l => {
      const key = l.team_id ? `team_${l.team_id}` : `driver_${l.driver_id}`;
      const e = advByEntity.get(key);
      if (!e) return;
      e.all.push(l);
      if (!e.lanes.has(l.lane)) e.lanes.set(l.lane, []);
      e.lanes.get(l.lane).push(l);
    });

    function stats(laps) {
      // `laps` incluye las warmup (para el TOTAL, como el DS y la matriz); las
      // métricas de ritmo (mejor/media/salidas/tiempo perdido) van sobre `racing`
      // = sin warmup, que no son representativas.
      const racing = laps.filter(l => !l.is_warmup);
      const clean  = racing.filter(l => !l.is_exit);
      const exits  = racing.filter(l => !!l.is_exit);
      const sum  = a => a.reduce((s,l) => s + l.lap_time_ms, 0);
      const min  = a => a.length ? Math.min(...a.map(l => l.lap_time_ms)) : null;
      const avg  = a => a.length ? Math.round(sum(a) / a.length) : null;
      const bestMs   = min(clean);
      const avgAll   = avg(racing);
      const avgClean = avg(clean);
      const ref      = avgClean ?? avgAll ?? 0;
      let lostMs = 0;
      for (const l of exits) { const o = l.lap_time_ms - ref; if (o > 0) lostMs += o; }
      return {
        totalLaps:    laps.length,
        cleanLaps:    clean.length,
        exitCount:    exits.filter(l => !l.is_pit_stop).length,
        pitStopCount: exits.filter(l => l.is_pit_stop).length,
        bestMs, avgAll, avgClean,
        deltaAll:   (bestMs && avgAll  ) ? avgAll   - bestMs : null,
        deltaClean: (bestMs && avgClean) ? avgClean - bestMs : null,
        lostMs,
        lostLapsEquiv: ref > 0 ? +(lostMs / ref).toFixed(2) : 0,
      };
    }

    const advancedStats = [...advByEntity.values()].map(e => {
      const s = stats(e.all);
      // Evolución POR CARRIL (pista): cada equipo corre cada carril una vez, y
      // en slot el carril es lo determinante. Ordenado por nº de carril.
      const perLane = [...e.lanes.entries()]
        .sort((a,b) => a[0] - b[0])
        .map(([lane, laps]) => ({ lane, ...stats(laps) }));
      return { key: e.key, entityName: e.name, color: e.color, ...s, perLane };
    });

    // ── Clasificación de la pole (si la carrera la tuvo) ──────────────────────
    // Se muestra como pestaña extra en resultados: orden por vuelta única, gap
    // al poleman y el mejor marcado. Reutiliza PoleSession.getEntriesSorted.
    let pole = null;
    if (race.has_pole) {
      const PoleSession = require('../models/PoleSession');
      const ps = PoleSession.findByRace(race.id);
      if (ps) {
        const entries = PoleSession.getEntriesSorted(ps.id);
        const timed   = entries.filter(e => e.lap_time_ms != null);
        if (timed.length) {
          const bestMs = timed[0].lap_time_ms;
          let pos = 0;
          pole = {
            lane:       ps.lane,
            status:     ps.status,
            bestMs,
            poleHolder: timed[0].entity_name,
            rows: entries.map(e => ({
              pos:       e.lap_time_ms != null ? ++pos : null,
              name:      e.entity_name,
              lapTimeMs: e.lap_time_ms,
              gapMs:     e.lap_time_ms != null ? e.lap_time_ms - bestMs : null,
            })),
          };
        }
      }
    }

    return SessionController._sendResults(req, res, {
      t: req.t, race, results, laneSequence, tandas, LANE_COLORS,
      raceBestLapMs, raceBestEntity, raceBestLane, startLaneByEntity,
      progressionByEntity, positionData, gapData,
      advancedStats,
      perOccurrence, occColumns,
      pole,
      publicView: !!req._publicResults,
    });
  }

  // Renderiza la vista de resultados. En modo export devuelve un HTML
  // AUTOCONTENIDO como descarga (para GitHub Pages / compartir sin PitWall);
  // si no, render normal.
  static _sendResults(req, res, data) {
    if (!req._exportMode) return res.render('races/results', data);
    res.render('races/results', { ...data, hideNavbar: true }, (err, html) => {
      if (err) { console.error('[export] render error:', err.message); return res.status(500).send('Export error'); }
      const out = SessionController._inlineForExport(html);
      // index.html → se sube tal cual a un repo y GitHub Pages ya lo sirve.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="index.html"');
      res.send(out);
    });
  }

  // Convierte el HTML en autónomo: inline del CSS local y quita los assets/JS
  // y la botonera que dependen del servidor. Chart.js y las fuentes (CDN) y los
  // datos embebidos (JSON) se mantienen → funciona offline / en GitHub Pages.
  static _inlineForExport(html) {
    const fs   = require('fs');
    const path = require('path');
    let css = '', chartJs = '';
    try { css     = fs.readFileSync(path.join(__dirname, '../../public/css/style.css'), 'utf8'); } catch {}
    try { chartJs = fs.readFileSync(path.join(__dirname, '../../node_modules/chart.js/dist/chart.umd.min.js'), 'utf8'); } catch {}
    let out = html;
    out = out.replace(/<link[^>]*href="\/css\/style\.css"[^>]*>/i, '<style>\n' + css + '\n</style>');
    out = out.replace(/<script[^>]*src="\/js\/app\.js"[^>]*><\/script>/i, '');
    out = out.replace(/<link[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>\s*/gi, '');
    // SIN internet: Chart.js inline (CDN → local) y fuera las fuentes de Google
    // (se usan las del sistema). Así el HTML funciona 100% offline.
    if (chartJs) {
      out = out.replace(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@[^"]*"[^>]*><\/script>/i,
        '<script>\n' + chartJs + '\n</script>');
    }
    out = out.replace(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, '');
    out = out.replace(/<link[^>]*rel="preconnect"[^>]*>\s*/gi, '');
    // Oculta navegación/botonera/footer (dependen del servidor); deja el análisis.
    out = out.replace(/<\/head>/i,
      '<style>.vt-head__actions,.vt-back-link,.footer,.navbar{display:none!important}</style></head>');
    return out;
  }

  // ── Resultados públicos ────────────────────────────────────────────────────
  // GET /results — landing pública: lista de carreras finalizadas.
  static resultsIndex(req, res) {
    const lang  = req.session?.lang || 'es';
    const races = Race.findAll()
      .filter(r => r.status === 'finished')
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.render('races/results-index', { t: req.t, lang, races });
  }

  // GET /results/:id — resultados públicos de una carrera (misma vista que
  // /races/:id/results pero sin la sección de corrección de vueltas).
  static publicResults(req, res) {
    req._publicResults = true;
    return SessionController.results(req, res);
  }

  // GET /races/:id/results/export.html — descarga un index.html AUTOCONTENIDO
  // de los resultados (gráficos + datos embebidos) listo para subir a GitHub
  // Pages o compartir sin acceso a PitWall.
  static exportResults(req, res) {
    req._exportMode    = true;
    req._publicResults = true;
    return SessionController.results(req, res);
  }

  // GET /races/:id/results/xlsx
  static async excel(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const aggregate = Lap.aggregateByRace(race.id);
    const isEs      = (req.query.lang || 'es') === 'es';

    const fmtMs = (ms) => {
      if (ms == null) return '';
      const s = Math.floor(ms / 1000);
      const h = Math.floor((ms % 1000) / 10);
      const m = Math.floor(s / 60);
      return (m > 0 ? m + ':' : '') + String(s % 60).padStart(m > 0 ? 2 : 1, '0') + '.' + String(h).padStart(2,'0');
    };
    const fmtSec = (ms) => ms == null ? '' : (ms / 1000).toFixed(3).replace('.', ',');
    const fmtPct = (p) => p == null ? '' : p.toFixed(1).replace('.', ',') + '%';

    // ── Style palette ────────────────────────────────────────────────────────
    const COL = {
      header:    'FF161B22',   // dark slate
      headerFg:  'FFFFFFFF',
      gold:      'FFFBBF24',
      silver:    'FFD1D5DB',
      bronze:    'FFD97706',
      best:      'FF7EE787',   // green for fastest cells
      worstBg:   'FFFFF1F0',
      raceBest:  'FFFEF3C7',   // highlight for global fastest
      band:      'FFF6F8FA',
      rowTotal:  'FFEEF1F4',   // light gray — entity total row
      rowBest:   'FFE7F8EC',   // light green — fastest row
      rowAvg:    'FFFFFBE6',   // light yellow — average row
      rowExits:  'FFFDECEC',   // light red — exits row
      muted:     'FF6E7681',
      exit:      'FFF85149',
      border:    'FFD0D7DE',
      accent:    'FF1F6FEB',   // azul de marca para la banda de subtítulo
      footerBg:  'FFF6F8FA',
    };
    const thinBorder = {
      top:    { style: 'thin', color: { argb: COL.border } },
      left:   { style: 'thin', color: { argb: COL.border } },
      bottom: { style: 'thin', color: { argb: COL.border } },
      right:  { style: 'thin', color: { argb: COL.border } },
    };
    const fillSolid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const headerStyle = {
      font: { bold: true, color: { argb: COL.headerFg }, size: 11 },
      fill: fillSolid(COL.header),
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: thinBorder,
    };
    const podiumFill = (pos) => pos === 1 ? fillSolid(COL.gold) : pos === 2 ? fillSolid(COL.silver) : pos === 3 ? fillSolid(COL.bronze) : null;
    const applyBorder = (ws, range) => {
      ws.getCell(range).border = thinBorder;
    };

    const wb = new ExcelJS.Workbook();
    wb.creator       = 'PitWall';
    wb.company       = 'PitWall';
    wb.title         = race.name;
    wb.lastModifiedBy = 'PitWall';
    wb.created       = new Date();

    // Logo de la app para incrustarlo en la cabecera de cada hoja (opcional: si
    // no se puede leer, se sigue sin logo).
    const _fs   = require('fs');
    const _path = require('path');
    let logoId = null;
    try {
      const logoBuf = _fs.readFileSync(_path.join(__dirname, '../../build/icon.png'));
      logoId = wb.addImage({ buffer: logoBuf, extension: 'png' });
    } catch (e) { /* sin logo */ }

    // Date shown in header: prefer finished_at, fall back to started_at, then created_at
    const raceDateRaw = race.finished_at || race.started_at || race.created_at;
    const raceDate = raceDateRaw ? new Date(raceDateRaw) : null;
    const raceDateStr = raceDate
      ? raceDate.toLocaleString(isEs ? 'es-ES' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const titleLabel = isEs ? 'Carrera' : 'Race';
    const dateLabel  = isEs ? 'Fecha'   : 'Date';

    // Adds 2 header rows (title + date) to a sheet across `cols` columns
    // Subtítulo: tipo · formato · fecha (lo que haya).
    const _fmtType = race.type ? String(race.type).charAt(0).toUpperCase() + String(race.type).slice(1) : null;
    const _fmtFormat = race.format === 'team' ? (isEs ? 'Equipos' : 'Teams')
                     : race.format === 'individual' ? (isEs ? 'Individual' : 'Individual') : null;
    const subParts = [_fmtType, _fmtFormat, raceDateStr].filter(Boolean);
    const subLine  = subParts.join('   ·   ');

    function addRaceHeader(ws, cols) {
      // ── Banda de título (oscura) con el logo de PitWall a la derecha ──────
      const r1 = ws.addRow([race.name]);
      r1.height = 40;
      ws.mergeCells(r1.number, 1, r1.number, cols);
      const c1 = r1.getCell(1);
      c1.font = { name: 'Calibri', bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
      c1.fill = fillSolid(COL.header);
      c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      if (logoId != null) {
        // Logo anclado a la ESQUINA de la última columna de la banda del título.
        // Anclaje ENTERO (sin fracciones): con anchos de columna personalizados,
        // un anclaje fraccional ExcelJS lo recalcula mal y acaba tapando contenido.
        ws.addImage(logoId, {
          tl: { col: Math.max(0, cols - 1), row: r1.number - 1 },
          ext: { width: 30, height: 30 },
          editAs: 'oneCell',
        });
      }

      // ── Banda de subtítulo (acento azul) ─────────────────────────────────
      const r2 = ws.addRow([subLine || race.name]);
      r2.height = 20;
      ws.mergeCells(r2.number, 1, r2.number, cols);
      const c2 = r2.getCell(1);
      c2.font = { name: 'Calibri', size: 10, color: { argb: 'FFFFFFFF' } };
      c2.fill = fillSolid(COL.accent);
      c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

      ws.addRow([]);
    }

    // ── Sheet 1 — Clasificación ─────────────────────────────────────────────
    // Desempate oficial (igual que /results): vueltas → coma última manga →
    // tiempo total → mejor vuelta. Antes ordenaba solo por mejor vuelta, así que
    // el Excel salía en distinto orden que la pantalla en los empates a vueltas.
    const byTotal = [...aggregate].sort((a,b) => b.total_laps - a.total_laps
      || (b.last_manga_coma||0) - (a.last_manga_coma||0)
      || (a.total_time_ms||Infinity) - (b.total_time_ms||Infinity)
      || (a.best_lap_ms||Infinity) - (b.best_lap_ms||Infinity));
    const s1 = wb.addWorksheet(isEs ? 'Clasificación' : 'Standings');
    s1.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }];
    addRaceHeader(s1, 6);
    const s1Header = s1.addRow(['#', isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Total vueltas' : 'Total laps', isEs ? 'Mejor vuelta' : 'Best lap', isEs ? 'Vuelta media' : 'Avg lap', isEs ? 'Mangas' : 'Heats']);
    s1Header.height = 22;
    s1Header.eachCell(c => Object.assign(c, headerStyle));
    s1.views = [{ state: 'frozen', ySplit: s1Header.number }];
    byTotal.forEach((r, i) => {
      const row = s1.addRow([i+1, r.entity_name, r.total_laps, fmtMs(r.best_lap_ms), fmtMs(Math.round(r.avg_lap_ms)), r.mangas_raced]);
      const fill = podiumFill(i+1);
      row.eachCell(c => {
        c.border = thinBorder;
        if (fill) c.fill = fill;
        if (fill && i < 3) c.font = { bold: true };
      });
      row.getCell(3).font = { bold: true };
      if (i % 2 === 1 && !fill) row.eachCell(c => c.fill = fillSolid(COL.band));
    });

    // ── Sheet 2 — Mejor vuelta ──────────────────────────────────────────────
    const byBest = [...aggregate].filter(r => r.best_lap_ms).sort((a,b) => a.best_lap_ms - b.best_lap_ms);
    const s2 = wb.addWorksheet(isEs ? 'Mejor vuelta' : 'Best lap');
    s2.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }];
    addRaceHeader(s2, 4);
    const s2Header = s2.addRow(['#', isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Mejor vuelta' : 'Best lap', isEs ? 'Total vueltas' : 'Total laps']);
    s2Header.height = 22;
    s2Header.eachCell(c => Object.assign(c, headerStyle));
    s2.views = [{ state: 'frozen', ySplit: s2Header.number }];
    byBest.forEach((r, i) => {
      const row = s2.addRow([i+1, r.entity_name, fmtMs(r.best_lap_ms), r.total_laps]);
      const fill = podiumFill(i+1);
      row.eachCell(c => {
        c.border = thinBorder;
        if (fill) c.fill = fill;
        if (fill) c.font = { bold: true };
      });
      row.getCell(3).font = { bold: true, color: { argb: 'FF1A7F37' } };
      if (i % 2 === 1 && !fill) row.eachCell(c => c.fill = fillSolid(COL.band));
    });

    // ── Sheet 3 — Por carril ────────────────────────────────────────────────
    const s3 = wb.addWorksheet(isEs ? 'Por carril' : 'Per lane');
    s3.columns = [{ width: 30 }, { width: 8 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 10 }];
    addRaceHeader(s3, 6);
    const s3Header = s3.addRow([isEs ? 'Piloto / Equipo' : 'Driver / Team', isEs ? 'Carril' : 'Lane', isEs ? 'Vueltas' : 'Laps', isEs ? 'Mejor' : 'Best', isEs ? 'Media' : 'Avg', isEs ? 'Salidas' : 'Exits']);
    s3Header.height = 22;
    s3Header.eachCell(c => Object.assign(c, headerStyle));
    s3.views = [{ state: 'frozen', ySplit: s3Header.number }];
    aggregate.forEach(r => {
      const perLane = Lap.perLaneByEntity(race.id, r.entity_id, r.entity_type);
      perLane.forEach(pl => {
        const row = s3.addRow([r.entity_name, pl.lane, pl.laps, fmtMs(pl.best_ms), fmtMs(Math.round(pl.avg_ms)), pl.exit_count || 0]);
        row.eachCell(c => c.border = thinBorder);
        row.getCell(4).font = { color: { argb: 'FF1A7F37' }, bold: true };
        if (pl.exit_count > 0) row.getCell(6).font = { color: { argb: COL.exit }, bold: true };
      });
    });

    // ── Sheet 4 — Comparativa (PDF style with colors) ───────────────────────
    const laneSeq = (Race.getLaneSequence(race) || []).filter(l => l > 0);
    const entityData = aggregate.map(r => ({
      ...r,
      perLane: Lap.perLaneByEntity(race.id, r.entity_id, r.entity_type)
    }));
    let raceBestLapMs = null, raceBestEntity = null, raceBestLane = null;
    for (const r of entityData) {
      for (const pl of r.perLane) {
        if (pl.best_ms != null && (raceBestLapMs == null || pl.best_ms < raceBestLapMs)) {
          raceBestLapMs = pl.best_ms; raceBestEntity = r.entity_name; raceBestLane = pl.lane;
        }
      }
    }
    const byTotalM = [...entityData].sort((a,b) => b.total_laps - a.total_laps
      || (b.last_manga_coma||0) - (a.last_manga_coma||0)
      || (a.total_time_ms||Infinity) - (b.total_time_ms||Infinity)
      || (a.best_lap_ms||Infinity) - (b.best_lap_ms||Infinity));

    // ── Consistencia (misma métrica que en la web, results ~809-874) ──────────
    // perLaneByEntity no trae consistencia: se calcula aquí sobre las vueltas
    // elegibles de la carrera (SIN salidas/pits, filtro de incidentes por
    // defecto), tanto por celda (entidad×carril) como de carrera (por entidad).
    {
      const dbc = require('../config/database');
      const minLap = race.min_lap_ms || 0;
      const eligibleRows = dbc.prepare(`
        SELECT
          CASE WHEN l.team_id IS NOT NULL THEN 'team_'||l.team_id ELSE 'driver_'||l.driver_id END AS key,
          l.lane AS lane,
          l.lap_time_ms AS t,
          l.is_exit AS is_exit
        FROM laps l
        JOIN mangas m ON m.id = l.manga_id
        JOIN tandas tt ON tt.id = m.tanda_id
        WHERE tt.race_id = ?
          AND l.is_ghost = 0 AND l.is_warmup = 0
          AND l.lap_number > 1 AND l.lap_time_ms >= ${minLap}
      `).all(race.id);

      const cellClean = new Map();   // `${key}|${lane}` -> [t]  (SIN salidas)
      const raceClean  = new Map();  // key -> [t]  (SIN salidas)
      for (const row of eligibleRows) {
        if (row.is_exit) continue;
        let rc = raceClean.get(row.key);
        if (!rc) { rc = []; raceClean.set(row.key, rc); }
        rc.push(row.t);
        const ck = `${row.key}|${row.lane}`;
        let cc = cellClean.get(ck);
        if (!cc) { cc = []; cellClean.set(ck, cc); }
        cc.push(row.t);
      }

      entityData.forEach(r => {
        const key = r.entity_type === 'team' ? `team_${r.entity_id}` : `driver_${r.entity_id}`;
        (r.perLane || []).forEach(pl => {
          const c = robustConsistency(cellClean.get(`${key}|${pl.lane}`) || [], MIN_CONSISTENCY_LAPS);
          pl.consistency = c ? c.pct : null;
        });
        const cs = robustConsistency(raceClean.get(key) || [], MIN_CONSISTENCY_LAPS);
        r.raceConsistency = cs ? cs.pct : null;
      });
    }

    // Starting lane per entity — first non-rest assignment in tanda+manga order
    const db = require('../config/database');
    const startRows = db.prepare(`
      SELECT ml.lane, ml.team_id, ml.driver_id
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ? AND ml.is_rest = 0
      ORDER BY t.number ASC, m.number ASC, ml.lane ASC
    `).all(race.id);
    const startLaneByEntity = {};
    startRows.forEach(r => {
      const key = r.team_id ? `team_${r.team_id}` : `driver_${r.driver_id}`;
      if (startLaneByEntity[key] == null) startLaneByEntity[key] = r.lane;
    });

    const s4 = wb.addWorksheet(isEs ? 'Comparativa' : 'Comparison', {
      properties: { outlineProperties: { summaryBelow: false, summaryRight: false } }
    });
    // Que "Comparativa" sea la PRIMERA pestaña (y la que se abre) aunque se cree
    // la 4ª. El resto conserva su orden (orderNo por defecto es el de creación).
    s4.orderNo = 0;
    wb.views = [{ activeTab: 0, firstSheet: 0 }];
    const numLaneCols = laneSeq.length;
    s4.columns = [
      { width: 5 },   // #
      { width: 28 },  // name / label
      { width: 12 },  // total / per-row value
      ...laneSeq.map(() => ({ width: 12 })),
    ];
    addRaceHeader(s4, 3 + numLaneCols);

    // Banner row: TODO el texto en una sola celda combinada (A..última) para que
    // la etiqueta no se recorte en la columna A (que es estrecha).
    if (raceBestLapMs != null) {
      const bannerText = `⚡ ${isEs ? 'Vuelta rápida de la carrera' : 'Race fastest lap'}:  `
        + `${fmtSec(raceBestLapMs)}s — ${raceBestEntity} (${isEs ? 'Pista' : 'Lane'} ${raceBestLane})`;
      s4.addRow([bannerText]);
      const r = s4.lastRow;
      r.height = 26;
      s4.mergeCells(r.number, 1, r.number, 3 + numLaneCols);
      const c = r.getCell(1);
      c.fill = fillSolid(COL.gold);
      c.font = { bold: true, size: 12, color: { argb: 'FF1A1A1A' } };
      c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      s4.addRow([]);
    }

    // Header
    const headerRow = s4.addRow(['#', isEs ? 'Equipo / Piloto' : 'Team / Driver', isEs ? 'Vueltas' : 'Laps', ...laneSeq.map(l => `${isEs ? 'Pista' : 'Lane'} ${l}`)]);
    headerRow.height = 22;
    headerRow.eachCell(c => Object.assign(c, headerStyle));
    s4.views = [{ state: 'frozen', ySplit: headerRow.number }];

    const startLaneFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }; // light blue
    const startLaneBorder = {
      top:    { style: 'thin',   color: { argb: COL.border } },
      left:   { style: 'medium', color: { argb: 'FF58A6FF' } },
      bottom: { style: 'thin',   color: { argb: COL.border } },
      right:  { style: 'thin',   color: { argb: COL.border } },
    };

    // ── Rank por VUELTAS dentro de cada carril (misma lógica que results.ejs
    // rankByLaps): más vueltas = mejor; empate se rompe por menor media.
    const keyOf = r => `${r.entity_type}_${r.entity_id}`;
    function rankByLaps(entries) {
      const m = {};
      const better = (o, e) => o.laps > e.laps
        || (o.laps === e.laps && o.avg != null && (e.avg == null || o.avg < e.avg));
      entries.forEach(e => { m[e.key] = 1 + entries.filter(o => better(o, e)).length; });
      return m;
    }
    const laneLapRank = {};
    laneSeq.forEach(lane => {
      const entries = byTotalM
        .map(r => { const pl = (r.perLane || []).find(p => p.lane === lane);
                    return pl && pl.laps != null ? { key: keyOf(r), laps: pl.laps, avg: pl.avg_ms } : null; })
        .filter(Boolean);
      laneLapRank[lane] = rankByLaps(entries);
    });

    byTotalM.forEach((r, i) => {
      const laneMap = new Map(r.perLane.map(pl => [pl.lane, pl]));
      const totalExits = r.perLane.reduce((s,pl)=>s+(pl.exit_count||0),0);
      const totalPits  = r.perLane.reduce((s,pl)=>s+(pl.pit_stop_count||0),0);
      const startLane  = startLaneByEntity[`${r.entity_type}_${r.entity_id}`];
      const pos = i+1;
      const podium = podiumFill(pos);

      // Entity header row (light gray on lane cells)
      const nameDisplay = startLane ? `${r.entity_name}   🚦 P${startLane}` : r.entity_name;
      const rowA = s4.addRow([pos, nameDisplay, r.total_laps, ...laneSeq.map(l => {
        const pl = laneMap.get(l);
        if (!pl || pl.laps == null) return '';
        const rank = laneLapRank[l] ? laneLapRank[l][keyOf(r)] : null;
        return rank ? `${pl.laps} (${rank})` : `${pl.laps}`;
      })]);
      rowA.height = 20;
      rowA.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.font = { bold: true, size: 11 };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = fillSolid(COL.rowTotal);
      });
      rowA.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
      if (podium) {
        rowA.getCell(1).fill = podium;
        rowA.getCell(2).fill = podium;
        rowA.getCell(3).fill = podium;
      }
      rowA.getCell(3).font = { bold: true, size: 12, color: { argb: pos === 1 ? 'FF8A6D00' : pos === 2 ? 'FF374151' : pos === 3 ? 'FFFFFFFF' : 'FF0969DA' } };

      // Mark the starting-lane cell on the entity header row
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) {
          const cell = rowA.getCell(4 + idx);
          cell.fill   = startLaneFill;
          cell.border = startLaneBorder;
        }
      }

      // Fastest row
      const fastestVals = laneSeq.map(l => {
        const pl = laneMap.get(l); return (pl && pl.best_ms != null) ? fmtSec(pl.best_ms) : '';
      });
      const bestLapPl = r.best_lap_ms != null ? r.perLane.find(pl => pl.best_ms === r.best_lap_ms) : null;
      const bestLapLane = bestLapPl ? bestLapPl.lane : null;
      const bestLapTotalStr = bestLapLane != null ? `${fmtSec(r.best_lap_ms)} (${bestLapLane})` : fmtSec(r.best_lap_ms);
      const rowB = s4.addRow(['', `⚡ ${isEs ? 'Vuelta rápida' : 'Fastest'}`, bestLapTotalStr, ...fastestVals]);
      rowB.outlineLevel = 1;
      rowB.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.font = { color: { argb: 'FF1A7F37' }, bold: true };
        c.alignment = { horizontal: 'center' };
        c.fill = fillSolid(COL.rowBest);
      });
      rowB.getCell(2).alignment = { horizontal: 'left' };
      rowB.getCell(2).font = { color: { argb: COL.muted }, italic: true };
      // Highlight race-best cell (overrides green row bg)
      laneSeq.forEach((l, idx) => {
        const pl = laneMap.get(l);
        if (pl && pl.best_ms != null && pl.best_ms === raceBestLapMs) {
          const cell = rowB.getCell(4 + idx);
          cell.fill = fillSolid(COL.raceBest);
          cell.font = { bold: true, color: { argb: 'FF8A6D00' }, size: 12 };
          cell.value = `${fmtSec(pl.best_ms)} ★`;
        }
      });
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowB.getCell(4 + idx).border = startLaneBorder;
      }

      // Average row
      const avgVals = laneSeq.map(l => {
        const pl = laneMap.get(l); return (pl && pl.avg_ms != null) ? fmtSec(Math.round(pl.avg_ms)) : '';
      });
      let bestAvgLane = null, bestAvgMs = null;
      r.perLane.forEach(pl => { if (pl.avg_ms != null && (bestAvgMs == null || pl.avg_ms < bestAvgMs)) { bestAvgMs = pl.avg_ms; bestAvgLane = pl.lane; } });
      const avgTotalStr = bestAvgLane != null
        ? `${fmtSec(Math.round(r.avg_lap_ms))} / ${fmtSec(Math.round(bestAvgMs))} (${bestAvgLane})`
        : fmtSec(Math.round(r.avg_lap_ms));
      const rowC = s4.addRow(['', isEs ? 'Media gen / Mejor med' : 'Avg / Best avg', avgTotalStr, ...avgVals]);
      rowC.outlineLevel = 1;
      rowC.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.fill = fillSolid(COL.rowAvg);
      });
      rowC.getCell(2).alignment = { horizontal: 'left' };
      rowC.getCell(2).font = { color: { argb: COL.muted }, italic: true };
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowC.getCell(4 + idx).border = startLaneBorder;
      }

      // Consistency row (SIN salidas/pits, ritmo puro)
      const consVals = laneSeq.map(l => {
        const pl = laneMap.get(l);
        return (pl && pl.consistency != null) ? fmtPct(pl.consistency) : '';
      });
      const rowCons = s4.addRow(['', isEs ? 'Const. sin' : 'Const. clean', fmtPct(r.raceConsistency), ...consVals]);
      rowCons.outlineLevel = 1;
      rowCons.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { size: 10 };
        c.fill = fillSolid('FFEFF6FF');
      });
      rowCons.getCell(2).alignment = { horizontal: 'left' };
      rowCons.getCell(2).font = { color: { argb: COL.muted }, italic: true, size: 10 };
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowCons.getCell(4 + idx).border = startLaneBorder;
      }

      // Exits row
      const exitVals = laneSeq.map(l => {
        const pl = laneMap.get(l);
        if (!pl || pl.worst_ms == null) return '';
        return `(${pl.exit_count||0}) ${fmtSec(pl.worst_ms)}`;
      });
      const rowD = s4.addRow(['', `${isEs ? 'Salidas' : 'Exits'} (${totalExits})`, '', ...exitVals]);
      rowD.outlineLevel = 1;
      rowD.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { size: 10, color: { argb: COL.muted } };
        c.fill = fillSolid(COL.rowExits);
      });
      rowD.getCell(2).alignment = { horizontal: 'left' };
      rowD.getCell(2).font = { color: { argb: totalExits > 0 ? COL.exit : COL.muted }, italic: true, bold: totalExits > 0 };
      // Highlight cells with exits in red
      laneSeq.forEach((l, idx) => {
        const pl = laneMap.get(l);
        if (pl && pl.exit_count > 0) {
          const cell = rowD.getCell(4 + idx);
          cell.font = { size: 10, color: { argb: COL.exit }, bold: true };
        }
      });
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowD.getCell(4 + idx).border = startLaneBorder;
      }

      // Pit-stops row
      const pitVals = laneSeq.map(l => {
        const pl = laneMap.get(l);
        if (!pl || !pl.pit_stop_count) return '';
        const laps = pl.pit_stop_laps
          ? pl.pit_stop_laps.split(',').filter(Boolean).map(n => 'V' + n).join(', ')
          : '';
        return `(${pl.pit_stop_count}) ${laps}`;
      });
      const rowE = s4.addRow(['', `🔧 ${isEs ? 'Pit-stops' : 'Pit-stops'} (${totalPits})`, '', ...pitVals]);
      rowE.outlineLevel = 1;
      rowE.eachCell({ includeEmpty: true }, c => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { size: 10, color: { argb: COL.muted } };
        c.fill = fillSolid('FFFFF4E5'); // light orange
      });
      rowE.getCell(2).alignment = { horizontal: 'left' };
      rowE.getCell(2).font = { color: { argb: totalPits > 0 ? 'FFFF9800' : COL.muted }, italic: true, bold: totalPits > 0 };
      laneSeq.forEach((l, idx) => {
        const pl = laneMap.get(l);
        if (pl && pl.pit_stop_count > 0) {
          const cell = rowE.getCell(4 + idx);
          cell.font = { size: 10, color: { argb: 'FFFF9800' }, bold: true };
        }
      });
      if (startLane) {
        const idx = laneSeq.indexOf(startLane);
        if (idx >= 0) rowE.getCell(4 + idx).border = startLaneBorder;
      }

      // Spacer
      s4.addRow([]);
    });

    // ── One sheet per entity with lap-by-lap progression ───────────────────
    const progressionRows = db.prepare(`
      SELECT l.lane, l.lap_time_ms, l.team_id, l.driver_id, l.is_exit, l.is_pit_stop
      FROM laps l
      JOIN mangas m ON m.id = l.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE l.race_id = ? AND l.is_ghost = 0 AND l.lap_number > 0
        AND l.is_warmup = 0
        AND l.lap_time_ms >= (SELECT COALESCE(min_lap_ms, 0) FROM races WHERE id = l.race_id)
      ORDER BY t.number ASC, m.number ASC, l.lane ASC, l.lap_number ASC
    `).all(race.id);
    const progByEntity = {};
    entityData.forEach(e => {
      progByEntity[`${e.entity_type}_${e.entity_id}`] = { name: e.entity_name, lanes: {}, laneAvg: {} };
    });
    progressionRows.forEach(row => {
      const key = row.team_id ? `team_${row.team_id}` : `driver_${row.driver_id}`;
      const e = progByEntity[key];
      if (!e) return;
      if (!e.lanes[row.lane]) e.lanes[row.lane] = [];
      e.lanes[row.lane].push({ ms: row.lap_time_ms, isExit: !!row.is_exit, isPitStop: !!row.is_pit_stop });
    });
    Object.values(progByEntity).forEach(e => {
      Object.entries(e.lanes).forEach(([lane, arr]) => {
        if (arr.length === 0) return;
        e.laneAvg[lane] = Math.round(arr.reduce((s,v)=>s+v.ms,0) / arr.length);
      });
    });


    function sanitizeSheetName(name) {
      // Excel: max 31 chars, no \ / ? * [ ] :
      let n = String(name).replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 28);
      return n.length ? n : 'Equipo';
    }
    const usedNames = new Set();
    for (let idx = 0; idx < byTotalM.length; idx++) {
      const entity = byTotalM[idx];
      const key = `${entity.entity_type}_${entity.entity_id}`;
      const prog = progByEntity[key];
      if (!prog) continue;
      const lanes = Object.keys(prog.lanes).map(Number).sort((a,b)=>a-b);
      if (lanes.length === 0) continue;

      let base = sanitizeSheetName((idx+1).toString().padStart(2,'0') + '_' + entity.entity_name);
      let nm = base, i = 2;
      while (usedNames.has(nm)) { nm = base.slice(0, 26) + '_' + (i++); }
      usedNames.add(nm);

      const sE = wb.addWorksheet(nm);
      sE.columns = [{ width: 8 }, ...lanes.map(() => ({ width: 14 }))];
      addRaceHeader(sE, 1 + lanes.length);

      // Title row for entity
      const tRow = sE.addRow([`${idx+1}. ${entity.entity_name}`]);
      tRow.height = 22;
      sE.mergeCells(tRow.number, 1, tRow.number, 1 + lanes.length);
      const tc = tRow.getCell(1);
      tc.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      tc.fill = fillSolid(COL.header);
      tc.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      sE.addRow([]);

      // ── Section: Absolute times ─────────────────────────────────────────
      const absTitle = sE.addRow([isEs ? '⏱ Tiempo absoluto (s)' : '⏱ Absolute time (s)']);
      sE.mergeCells(absTitle.number, 1, absTitle.number, 1 + lanes.length);
      absTitle.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1F6FEB' } };
      absTitle.getCell(1).alignment = { vertical: 'middle', indent: 1 };

      const absHeader = sE.addRow([isEs ? 'Vuelta' : 'Lap', ...lanes.map(l => `${isEs ? 'Pista' : 'Lane'} ${l}`)]);
      absHeader.height = 20;
      absHeader.eachCell({ includeEmpty: true }, c => Object.assign(c, headerStyle));

      const maxLapCount = Math.max(...lanes.map(l => prog.lanes[l].length));
      const absStartRow = sE.lastRow.number + 1;
      for (let li = 0; li < maxLapCount; li++) {
        const values = [li + 1, ...lanes.map(l => {
          const lap = prog.lanes[l][li];
          return lap != null ? Number((lap.ms / 1000).toFixed(3)) : '';
        })];
        const row = sE.addRow(values);
        row.eachCell({ includeEmpty: true }, (c, colNum) => {
          c.border = thinBorder;
          c.alignment = { horizontal: 'center' };
          if (colNum === 1) {
            c.font = { color: { argb: COL.muted }, size: 10 };
            c.fill = fillSolid(COL.band);
          }
        });
        // Tint exit/pit-stop cells so they stand out in the absolute table
        lanes.forEach((l, ci) => {
          const lap = prog.lanes[l][li];
          if (!lap) return;
          const c = row.getCell(2 + ci);
          if (lap.isPitStop) {
            c.font = { bold: true, color: { argb: 'FFFF9800' } };
            c.fill = fillSolid('FFFFF4E5');
          } else if (lap.isExit) {
            c.font = { bold: true, color: { argb: COL.exit } };
            c.fill = fillSolid('FFFDECEC');
          } else if (li % 2 === 1) {
            c.fill = fillSolid(COL.band);
          }
        });
      }

      // Avg row at the bottom of absolute section
      const avgRow = sE.addRow([isEs ? 'Media' : 'Avg', ...lanes.map(l => {
        const v = prog.laneAvg[l];
        return v != null ? Number((v / 1000).toFixed(3)) : '';
      })]);
      avgRow.eachCell({ includeEmpty: true }, (c, colNum) => {
        c.border = thinBorder;
        c.alignment = { horizontal: 'center' };
        c.font = { bold: true, color: { argb: 'FF8A6D00' } };
        c.fill = fillSolid(COL.rowAvg);
      });

      sE.addRow([]);

      // ── Section: Delta vs lane average ─────────────────────────────────
      const dTitle = sE.addRow([isEs ? 'Δ Delta vs media de carril (s)' : 'Δ Delta vs lane avg (s)']);
      sE.mergeCells(dTitle.number, 1, dTitle.number, 1 + lanes.length);
      dTitle.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1F6FEB' } };
      dTitle.getCell(1).alignment = { vertical: 'middle', indent: 1 };

      const dHeader = sE.addRow([isEs ? 'Vuelta' : 'Lap', ...lanes.map(l => `${isEs ? 'Pista' : 'Lane'} ${l}`)]);
      dHeader.height = 20;
      dHeader.eachCell({ includeEmpty: true }, c => Object.assign(c, headerStyle));

      for (let li = 0; li < maxLapCount; li++) {
        const values = [li + 1, ...lanes.map(l => {
          const lap = prog.lanes[l][li];
          if (lap == null) return '';
          const avg = prog.laneAvg[l] || 0;
          return Number(((lap.ms - avg) / 1000).toFixed(3));
        })];
        const row = sE.addRow(values);
        row.eachCell({ includeEmpty: true }, (c, colNum) => {
          c.border = thinBorder;
          c.alignment = { horizontal: 'center' };
          if (colNum === 1) {
            c.font = { color: { argb: COL.muted }, size: 10 };
            c.fill = fillSolid(COL.band);
          } else if (typeof c.value === 'number') {
            if (c.value < -0.05) {
              c.font = { bold: true, color: { argb: 'FF1A7F37' } };
              c.fill = fillSolid('FFE7F8EC');
            } else if (c.value > 0.05) {
              c.font = { bold: true, color: { argb: COL.exit } };
              c.fill = fillSolid('FFFDECEC');
            }
          }
        });
      }

    }



    // ── Pie de página de copyright en TODAS las hojas ────────────────────────
    // Fila visible al final + footer de impresión (se ve al imprimir/PDF).
    const _year = (wb.created instanceof Date ? wb.created : new Date()).getFullYear();
    const copyrightText = `© ${_year} PitWall · Software libre (GNU AGPLv3) · pitwall.es`;
    wb.eachSheet((ws) => {
      const cols = Math.max(1, ws.columnCount || 1);
      ws.addRow([]);
      const fr = ws.addRow([copyrightText]);
      fr.height = 16;
      ws.mergeCells(fr.number, 1, fr.number, cols);
      const fc = fr.getCell(1);
      fc.font = { name: 'Calibri', italic: true, size: 9, color: { argb: COL.muted } };
      fc.fill = fillSolid(COL.footerBg);
      fc.alignment = { horizontal: 'center', vertical: 'middle' };
      // Footer de impresión (aparece al imprimir o exportar a PDF).
      ws.headerFooter = ws.headerFooter || {};
      ws.headerFooter.oddFooter  = `&C&"Calibri"&8${copyrightText}`;
      ws.headerFooter.evenFooter = `&C&"Calibri"&8${copyrightText}`;
    });

    const buf = await wb.xlsx.writeBuffer();
    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_resultados.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  }

  // ── Puntos de clasificación ─────────────────────────────────────────────
  // Tabla fija (pos 1..64). Posiciones por encima de 64 → 0 puntos.
  static _pointsFor(position) {
    const T = SessionController._POINTS_TABLE;
    if (position < 1 || position > T.length) return 0;
    return T[position - 1];
  }

  // GET /races/:id/results/points.xlsx
  static async pointsExcel(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const isEs = (req.query.lang || 'es') === 'es';
    const rows = SessionController._buildPointsRanking(race.id);

    const fmtMs = (ms) => {
      if (ms == null) return '';
      const s = Math.floor(ms / 1000);
      const h = Math.floor((ms % 1000) / 10);
      const m = Math.floor(s / 60);
      return (m > 0 ? m + ':' : '') + String(s % 60).padStart(m > 0 ? 2 : 1, '0') + '.' + String(h).padStart(2,'0');
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SloTime';
    wb.created = new Date();
    const ws = wb.addWorksheet(isEs ? 'Puntos' : 'Points');
    ws.columns = [{ width: 5 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 12 }];

    const hdr = ws.addRow(['#', isEs ? 'Piloto / Equipo' : 'Driver / Team',
                           isEs ? 'Total vueltas' : 'Total laps',
                           isEs ? 'Mejor vuelta'  : 'Best lap',
                           isEs ? 'Vuelta media'  : 'Avg lap',
                           isEs ? 'Mangas'        : 'Heats',
                           isEs ? 'Puntos'        : 'Points']);
    hdr.height = 22;
    hdr.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF161B22' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    ws.views = [{ state: 'frozen', ySplit: hdr.number }];

    const podium = (p) => p === 1 ? 'FFFBBF24' : p === 2 ? 'FFD1D5DB' : p === 3 ? 'FFD97706' : null;
    rows.forEach((r, i) => {
      const row = ws.addRow([r.position, r.entity_name, r.total_laps, fmtMs(r.best_lap_ms),
                             fmtMs(Math.round(r.avg_lap_ms || 0)), r.mangas_raced, r.points]);
      const fill = podium(r.position);
      row.eachCell(c => {
        if (fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      });
      row.getCell(7).font = { bold: true };
    });

    const buf = await wb.xlsx.writeBuffer();
    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_puntos.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  }

  // GET /races/:id/results/points.csv
  static pointsCsv(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    const isEs = (req.query.lang || 'es') === 'es';
    const rows = SessionController._buildPointsRanking(race.id);

    const head = isEs
      ? ['Posicion','Piloto/Equipo','TotalVueltas','MejorVueltaMs','VueltaMediaMs','Mangas','Puntos']
      : ['Position','DriverTeam','TotalLaps','BestLapMs','AvgLapMs','Heats','Points'];

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(';')];
    for (const r of rows) {
      lines.push([
        r.position, r.entity_name, r.total_laps,
        r.best_lap_ms ?? '', r.avg_lap_ms != null ? Math.round(r.avg_lap_ms) : '',
        r.mangas_raced, r.points,
      ].map(esc).join(';'));
    }

    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_puntos.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // BOM para que Excel detecte UTF-8 al abrir el CSV directamente
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }

  // GET /races/:id/results/control.csv
  // Clasificación general en formato TicTacSlot, compatible con el importador
  // de resultados de PitWall Control (Posición, Nombre, Vueltas, Coma, Pole).
  // Control solo aplica posición + nombre; vueltas/coma/pole son informativas
  // en su vista previa. El nombre debe coincidir con el equipo en Control
  // (la copa puede ir como sufijo: "APR SPORT GT").
  static controlCsv(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).send('Not found');

    // Orden oficial: vueltas DESC, coma DESC, tiempo total ASC (igual que /results)
    const rows = Lap.aggregateByRace(race.id)
      .filter(r => r.entity_id != null);

    // Poleman: mejor tiempo de la sesión de pole, casado por nombre de entidad
    let poleName = null;
    const PoleSession = require('../models/PoleSession');
    const pole = PoleSession.findByRace(race.id);
    if (pole) {
      const best = PoleSession.getEntriesSorted(pole.id)[0];
      if (best && best.lap_time_ms != null) poleName = best.entity_name;
    }

    // El parser de Control usa coma como separador y acepta punto decimal en
    // la columna Coma (fracción de vuelta, ×1000 = milésimas).
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Posición,Nombre,Vueltas,Coma,Pole'];
    rows.forEach((r, i) => {
      lines.push([
        i + 1,
        r.entity_name,
        r.total_laps,
        r.coma_total != null ? Number(r.coma_total).toFixed(3) : '',
        poleName != null && r.entity_name === poleName ? 1 : '',
      ].map(esc).join(','));
    });

    const filename = `${race.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_control.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }

  static _buildPointsRanking(raceId) {
    const aggregate = Lap.aggregateByRace(raceId);
    // Desempate oficial (igual que /results), CLAVE para los puntos: vueltas →
    // coma última manga → tiempo total → mejor vuelta.
    const sorted = [...aggregate].sort((a, b) =>
      b.total_laps - a.total_laps
      || (b.last_manga_coma || 0) - (a.last_manga_coma || 0)
      || (a.total_time_ms || Infinity) - (b.total_time_ms || Infinity)
      || (a.best_lap_ms || Infinity) - (b.best_lap_ms || Infinity));
    return sorted.map((r, i) => ({
      ...r,
      position: i + 1,
      points:   SessionController._pointsFor(i + 1),
    }));
  }

  // POST /races/:id/mangas/:mangaId/checkin
  // Body: { qr_code } or { driver_id, lane, force? } (manual override)
  //
  // Reglas (solo carreras de tipo 'championship'):
  //   1. Si manga.status === 'pending' (standby) → PRE-ARME: crea el shift
  //      con pre_armed=1, started_at_ms=null. Se activará al GO.
  //   2. Si manga.status === 'active' Y TimingService la gestiona Y running:
  //      → SWAP en runtime. Verifica lockout (últimos N ms bloqueados).
  //   3. Si manga.status === 'active' Y TimingService.isPaused:
  //      → SWAP permitido (sin lockout). El contador no avanza hasta resume.
  //   4. Si manga.status === 'finished'/'cancelled' → rechazo.
  static driverCheckin(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).json({ error: 'not_found' });
    if (race.type !== 'championship') return res.status(400).json({ error: 'not_championship_race' });
    if (race.format !== 'team') return res.status(400).json({ error: 'not_team_race' });

    const db = require('../config/database');

    // ── Validar estado de la manga para aceptar el scan ────────────────
    const mangaStatus = manga.status;
    let mode = null;        // 'pre_arm' | 'swap_running' | 'swap_paused'
    let remainingMs = null;

    if (mangaStatus === 'pending') {
      mode = 'pre_arm';
    } else if (mangaStatus === 'active') {
      const tsRunsThisManga = TimingService.activeMangaId === manga.id;
      if (!tsRunsThisManga) {
        return res.status(409).json({ error: 'manga_active_but_not_timing' });
      }
      if (TimingService.isRunning) {
        remainingMs = TimingService.getRemainingMs();
        const lockoutMs = race.driver_change_lockout_ms || 120000;
        const forceOverride = req.body.qr_code ? false : !!req.body.force;
        if (remainingMs != null && remainingMs <= lockoutMs && !forceOverride) {
          return res.status(409).json({
            error: 'change_locked_final_minutes',
            remainingMs,
            lockoutMs,
          });
        }
        mode = 'swap_running';
      } else if (TimingService.isPaused) {
        mode = 'swap_paused';
      } else {
        return res.status(409).json({ error: 'manga_active_but_not_running' });
      }
    } else {
      return res.status(409).json({ error: 'manga_status_invalid', status: mangaStatus });
    }

    // ── Resolver piloto + carril ────────────────────────────────────────
    let assignment = null;
    let profileName = null;

    if (req.body.qr_code) {
      const qr = (req.body.qr_code || '').trim();
      const profile = db.prepare('SELECT * FROM driver_profiles WHERE qr_code = ?').get(qr);
      if (!profile) return res.status(404).json({ error: 'unknown_qr', qr });
      profileName = profile.name;

      const assignments = DriverShift.findAssignmentsByProfile(profile.id, manga.id);
      if (assignments.length === 0) {
        // Si su equipo descansa esta manga, el motivo es ese (no "no está").
        if (DriverShift.isProfileTeamResting(profile.id, manga.id)) {
          return res.status(409).json({ error: 'team_resting', name: profile.name });
        }
        return res.status(404).json({ error: 'driver_not_in_manga', name: profile.name });
      }
      if (assignments.length > 1) {
        // Caso raro: piloto en varios equipos del catálogo que coinciden
        // con equipos diferentes en esta manga → ambigüedad. El staff
        // debe usar override manual (driver_id + lane).
        return res.status(409).json({
          error: 'ambiguous_team',
          name: profile.name,
          candidates: assignments.map(a => ({ lane: a.lane, teamId: a.team_id })),
        });
      }
      assignment = assignments[0];
    } else {
      // Override manual
      const lane     = parseInt(req.body.lane, 10);
      const driverId = parseInt(req.body.driver_id, 10);
      if (!lane || !driverId) return res.status(400).json({ error: 'missing_params' });

      const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
      if (!driver) return res.status(404).json({ error: 'driver_not_found' });
      assignment = {
        lane,
        team_id: driver.team_id,
        driver_id: driver.id,
        driver_name: driver.name,
      };
      profileName = driver.name;
    }

    // ── Aplicar el cambio según el modo ────────────────────────────────
    let shiftId = null;

    if (mode === 'pre_arm') {
      // Cierra cualquier shift pre-armado previo para este carril
      // (el equipo cambió de idea antes del GO).
      const prev = DriverShift.findOpenByLane(manga.id, assignment.lane);
      if (prev) {
        DriverShift.closeShift(prev.id, Date.now(), prev.driving_ms || 0);
      }
      shiftId = DriverShift.openShift({
        mangaId:    manga.id,
        raceId:     race.id,
        lane:       assignment.lane,
        teamId:     assignment.team_id,
        driverId:   assignment.driver_id,
        driverName: assignment.driver_name,
        preArmed:   true,
      });
    } else if (mode === 'swap_running' || mode === 'swap_paused') {
      // Cambio en caliente. Con la manga pausada es el MISMO camino: el reloj
      // del circuito está congelado, así que el turno saliente se cierra con su
      // valor exacto y el entrante queda anclado al elapsed de la pausa — no
      // avanza hasta el resume. Es TimingService quien mantiene su mapa.
      shiftId = TimingService.swapDriverOnLane({
        lane:       assignment.lane,
        raceId:     race.id,
        mangaId:    manga.id,
        teamId:     assignment.team_id,
        driverId:   assignment.driver_id,
        driverName: assignment.driver_name,
      });
      if (!shiftId) {
        // La manga en curso ya no es la que el cliente creía (o no es de
        // campeonato): no hay turno que abrir. Mejor fallar que fingir.
        return res.status(409).json({ ok: false, error: 'La manga activa ha cambiado; recarga la pantalla.' });
      }
    }

    SocketService.emit('driver_checkin', {
      mangaId:    manga.id,
      lane:       assignment.lane,
      driverName: assignment.driver_name,
      driverId:   assignment.driver_id,
      teamId:     assignment.team_id,
      mode,
    });

    return res.json({
      ok: true,
      mode,
      lane: assignment.lane,
      driverName: assignment.driver_name,
      shiftId,
    });
  }

  // ── Corrección manual de tiempo ─────────────────────────────────────────────
  // Cuando un equipo olvidó fichar por QR, el staff añade a mano el tiempo que
  // condujo un piloto (p.ej. la duración completa de la manga). Crea un turno
  // manual cerrado. Funciona en cualquier estado de manga (incluida finalizada),
  // por eso NO comparte las guardas de driverCheckin.
  static correctShiftTime(req, res) {
    const race  = Race.findById(req.params.id);
    const manga = Manga.findById(req.params.mangaId);
    if (!race || !manga) return res.status(404).json({ error: 'not_found' });
    if (race.type !== 'championship') return res.status(400).json({ error: 'not_championship_race' });
    if (race.format !== 'team')       return res.status(400).json({ error: 'not_team_race' });

    const driverId = parseInt(req.body.driver_id, 10);
    const ms       = Math.round(Number(req.body.ms));
    if (!driverId || !Number.isFinite(ms) || ms <= 0) {
      return res.status(400).json({ error: 'invalid_params' });
    }
    // Tope de cordura: 24 h.
    if (ms > 24 * 3600 * 1000) return res.status(400).json({ error: 'time_too_large' });

    const db = require('../config/database');
    const drv = db.prepare('SELECT id, name, team_id FROM drivers WHERE id = ? AND race_id = ?').get(driverId, race.id);
    if (!drv) return res.status(404).json({ error: 'driver_not_found' });

    // Carril del equipo en esta manga (0 si descansa / sin carril).
    const laneRow = db.prepare('SELECT lane FROM manga_lanes WHERE manga_id = ? AND team_id = ?').get(manga.id, drv.team_id);
    const lane = laneRow ? laneRow.lane : 0;

    const shiftId = DriverShift.addManualTime({
      mangaId: manga.id, raceId: race.id, lane,
      teamId: drv.team_id, driverId: drv.id, driverName: drv.name,
      drivingMs: ms,
    });

    SocketService.emit('driver_checkin', { mangaId: manga.id, lane, driverName: drv.name, driverId: drv.id, teamId: drv.team_id, mode: 'manual_correction' });
    return res.json({ ok: true, driverName: drv.name, ms, lane, shiftId });
  }

  // ── Activate next tanda: register its first manga for DS-300 GO ──────────────
  static activateNextTanda(req, res) {
    const raceId  = parseInt(req.params.id, 10);
    const tandaId = parseInt(req.params.tandaId, 10);

    const race  = Race.findById(raceId);
    const tanda = Tanda.findById(tandaId);
    if (!race || !tanda) return res.status(404).json({ error: 'Not found' });

    const nextTanda = Tanda.findNextPending(raceId, tanda.number);
    if (!nextTanda) return res.status(404).json({ error: 'No next tanda' });

    const manga = Manga.nextPending(nextTanda.id);
    if (!manga) return res.status(404).json({ error: 'No pending manga in next tanda' });

    const lanes   = Manga.getLanes(manga.id);
    const teams   = Team.findByTanda(nextTanda.id);
    const drivers = Driver.findByTanda(nextTanda.id);

    TimingService.setPendingManga(manga, race, lanes, teams, drivers);
    TimingService._tandaBoundary = false;

    return res.json({ ok: true, mangaId: manga.id, tandaId: nextTanda.id, tandaNumber: nextTanda.number });
  }
}

// Tabla de puntos por posición final (1..64). Posiciones 53-64 = 1 pt; >64 = 0.
SessionController._POINTS_TABLE = [
  70,64,59,55,52,50,48,46,44,43,42,41,40,39,38,37,36,35,34,33,
  32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,
  12,11,10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
   1, 1, 1, 1,
];

module.exports = SessionController;
