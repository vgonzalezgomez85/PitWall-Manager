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
const TimingService     = require('../services/TimingService');
const TrainingService   = require('../services/TrainingService');
const PoleTimingService = require('../services/PoleTimingService');
const PoleSession       = require('../models/PoleSession');
const Race  = require('../models/Race');
const Lap   = require('../models/Lap');
const db = require('../config/database');

const MobileController = {
  // GET /api/mobile/session
  session(req, res) {
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

  // Internal: build the full race-detail payload that the mobile app needs
  // to show pickers and follow a participant. Shared by /races/current and
  // /races/:id endpoints.
  _buildRaceDetail(race) {
    // Active manga (if any) — drives the "is it my turn now?" decision on the app side.
    // TimingService marks the running manga as `status='active'` (not 'running').
    const activeManga = db.prepare(`
      SELECT m.id, m.number, m.tanda_id, t.number AS tanda_number, m.started_at
      FROM mangas m JOIN tandas t ON t.id = m.tanda_id
      WHERE m.race_id = ? AND m.status = 'active'
      LIMIT 1
    `).get(race.id);

    // All manga_lanes for this race in tanda+manga order, joined with the
    // manga number so we can build each participant's schedule.
    const planRows = db.prepare(`
      SELECT ml.lane, ml.team_id, ml.driver_id, ml.is_rest,
             m.id AS manga_id, m.number AS manga_number, m.status AS manga_status,
             t.number AS tanda_number
      FROM manga_lanes ml
      JOIN mangas m ON m.id = ml.manga_id
      JOIN tandas t ON t.id = m.tanda_id
      WHERE t.race_id = ?
      ORDER BY t.number ASC, m.number ASC, ml.lane ASC
    `).all(race.id);

    const isTeam = race.format === 'team';
    const participants = isTeam
      ? db.prepare('SELECT id, name, color FROM teams WHERE race_id = ? ORDER BY id').all(race.id)
      : db.prepare('SELECT id, name FROM drivers WHERE race_id = ? ORDER BY id').all(race.id);

    const planByEntity = {};
    planRows.forEach(r => {
      const key = isTeam ? r.team_id : r.driver_id;
      if (key == null) return;
      if (!planByEntity[key]) planByEntity[key] = [];
      planByEntity[key].push({
        tandaNum:    r.tanda_number,
        mangaId:     r.manga_id,
        mangaNum:    r.manga_number,
        lane:        r.lane,
        isRest:      !!r.is_rest,
        mangaStatus: r.manga_status,
      });
    });

    const out = participants.map(p => ({
      id:    p.id,
      name:  p.name,
      color: p.color || '#8b949e',
      mangas: planByEntity[p.id] || [],
    }));

    return {
      race: {
        id:                race.id,
        name:              race.name,
        format:            race.format,                // 'team' | 'individual'
        type:              race.type,                  // 'club' | 'championship'
        status:            race.status,                // 'active' | 'pending'
        lanesCount:        race.lanes_count,
        mangaDurationMin:  race.manga_duration_minutes,
        startedAt:         race.started_at,
        hasPole:           !!race.has_pole,
      },
      activeManga: activeManga ? {
        id:         activeManga.id,
        number:     activeManga.number,
        tandaNum:   activeManga.tanda_number,
        startedAt:  activeManga.started_at,
      } : null,
      participants: out,
    };
  },

  // GET /api/mobile/races/current
  //
  // Returns the race in progress (status='active') or, if none, the earliest
  // pending race. Includes every registered team or driver with their full
  // per-manga lane plan. Devuelve `{ race: null }` si no hay carrera activa
  // ni pendiente.
  racesCurrent(req, res) {
    const race = db.prepare(`
      SELECT * FROM races
      WHERE status IN ('active','pending')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `).get();
    if (!race) return res.json({ race: null });
    return res.json(MobileController._buildRaceDetail(race));
  },

  // GET /api/mobile/races/active
  //
  // Lista todas las carreras activas y pendientes. La app móvil la usa para
  // mostrar selector cuando hay más de una preparada.
  racesActive(req, res) {
    const rows = db.prepare(`
      SELECT id, name, format, type, status, lanes_count, manga_duration_minutes,
             has_pole, created_at, started_at
      FROM races
      WHERE status IN ('active','pending')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC
    `).all();

    const enriched = rows.map(r => {
      const tandasCount = db.prepare('SELECT COUNT(*) AS c FROM tandas WHERE race_id = ?').get(r.id).c;
      const partCount = r.format === 'team'
        ? db.prepare('SELECT COUNT(*) AS c FROM teams WHERE race_id = ?').get(r.id).c
        : db.prepare('SELECT COUNT(*) AS c FROM drivers WHERE race_id = ?').get(r.id).c;
      return {
        id:                r.id,
        name:              r.name,
        format:            r.format,
        type:              r.type,
        status:            r.status,
        lanesCount:        r.lanes_count,
        mangaDurationMin:  r.manga_duration_minutes,
        hasPole:           !!r.has_pole,
        createdAt:         r.created_at,
        startedAt:         r.started_at,
        tandasCount,
        participantsCount: partCount,
      };
    });
    return res.json({ races: enriched });
  },

  // GET /api/mobile/races/:id
  //
  // Detalle completo de una carrera concreta (mismo shape que /races/current
  // pero para la carrera indicada). 404 si no existe.
  racesShow(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });
    return res.json(MobileController._buildRaceDetail(race));
  },

  // GET /api/mobile/races/:id/pole
  //
  // Estado completo de la pole de una carrera. Útil para la app móvil cuando
  // la race tiene has_pole=1: la app muestra orden de salida, clasificación
  // por mejor tiempo y, si hay alguien en pista, el cronómetro en vivo.
  racesPole(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).json({ error: 'race_not_found' });

    const defaultDurationMs = (race.manga_duration_minutes || 5) * 60_000;
    const sess = PoleSession.findByRace(race.id);

    if (!sess) {
      return res.json({
        active:        false,
        status:        null,
        poleLane:      null,
        durationMs:    defaultDurationMs,
        currentIdx:    0,
        totalCount:    0,
        currentEntry:  null,
        nextEntry:     null,
        startingOrder: [],
        standings:     [],
        live:          null,
      });
    }

    const ordered = PoleSession.getEntriesOrdered(sess.id);
    const sorted  = PoleSession.getEntriesSorted(sess.id);

    const startingOrder = ordered.map((e, i) => ({
      entryId:   e.id,
      pos:       (e.order_idx ?? i) + 1,
      name:      e.entity_name,
      lapTimeMs: e.lap_time_ms ?? null,
      done:      e.lap_time_ms != null,
    }));

    const standings = sorted
      .filter(e => e.lap_time_ms != null)
      .map((e, i) => ({
        entryId:   e.id,
        pos:       i + 1,
        name:      e.entity_name,
        lapTimeMs: e.lap_time_ms,
      }));

    // currentEntry/live: PoleTimingService manda si su sesión coincide con
    // la de esta race (alguien en standby o cronómetro corriendo). Si no,
    // caemos al current_idx persistido en BD.
    const ts = PoleTimingService;
    const matches = ts.session && ts.session.poleSessionId === sess.id;

    let currentEntry = null;
    let liveSnapshot = null;
    let durationMs   = defaultDurationMs;

    if (matches && (ts.isRunning || ts.isStandby)) {
      const e = ordered.find(o => o.id === ts.session.entryId);
      currentEntry = {
        entryId:  ts.session.entryId,
        name:     ts.session.entryName,
        startPos: (e?.order_idx ?? 0) + 1,
      };
      liveSnapshot = ts.getLiveSnapshot();   // null si está en standby
      if (ts.session.durationMs) durationMs = ts.session.durationMs;
    } else if (sess.status === 'in_progress' && ordered[sess.current_idx]) {
      const c = ordered[sess.current_idx];
      currentEntry = {
        entryId:  c.id,
        name:     c.entity_name,
        startPos: (c.order_idx ?? sess.current_idx) + 1,
      };
    }

    // nextEntry: el siguiente en starting order tras el current. Si la
    // pole ya está done, no hay siguiente.
    let nextEntry = null;
    if (sess.status !== 'done') {
      const curIdx = currentEntry
        ? ordered.findIndex(e => e.id === currentEntry.entryId)
        : sess.current_idx - 1;
      const next = ordered[curIdx + 1];
      if (next) nextEntry = { entryId: next.id, name: next.entity_name };
    }

    return res.json({
      active:        sess.status !== 'done',
      status:        sess.status,
      poleLane:      sess.lane ?? null,
      durationMs,
      currentIdx:    sess.current_idx,
      totalCount:    ordered.length,
      currentEntry,
      nextEntry,
      startingOrder,
      standings,
      live:          liveSnapshot,
    });
  },

  // GET /api/mobile/training
  //
  // Estado del modo entrenamiento. La app móvil lo consulta cuando se
  // conecta para ofrecer entrenamiento si no hay carrera activa (o como
  // alternativa).
  training(req, res) {
    const active = TrainingService.isActive;
    const lanes = active ? TrainingService.getLanes() : [];
    return res.json({
      active,
      startedAt:  TrainingService.startedAt,
      durationMs: TrainingService.durationMs,
      lanes: lanes.map(l => ({
        lane:   l.lane,
        color:  l.color,
        count:  l.count,
        avgMs:  l.avgMs,
        bestMs: l.bestMs,
        lastMs: l.lastMs,
      })),
    });
  },

  // GET /api/mobile/races
  //
  // Past races for the history view. Finished only — pending/active surface via
  // /races/current instead.
  racesList(req, res) {
    const rows = db.prepare(`
      SELECT id, name, format, type, lanes_count,
             created_at, started_at, finished_at
      FROM races
      WHERE status IN ('finished','completed')
      ORDER BY COALESCE(finished_at, created_at) DESC
      LIMIT 100
    `).all();

    return res.json({
      races: rows.map(r => ({
        id:          r.id,
        name:        r.name,
        format:      r.format,
        type:        r.type,
        lanesCount:  r.lanes_count,
        createdAt:   r.created_at,
        startedAt:   r.started_at,
        finishedAt:  r.finished_at,
      })),
    });
  },

  // GET /api/mobile/races/:id/results
  //
  // Aggregated final standings for a past race.
  racesResults(req, res) {
    const snapshot = MobileController.buildStatsSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'race_not_found' });
    return res.json({
      race: {
        id:          snapshot.raceId,
        name:        snapshot.name,
        format:      snapshot.format,
        type:        snapshot.type,
        startedAt:   snapshot.startedAt,
        finishedAt:  snapshot.finishedAt,
      },
      standings: snapshot.standings,
    });
  },

  // Build the full stats snapshot for a finished race. Used both by the
  // GET /results endpoint and by RaceController.complete to push the dossier
  // over socket when a race ends, so mobile clients can persist a local
  // history copy that works offline.
  buildStatsSnapshot(raceId) {
    const race = Race.findById(raceId);
    if (!race) return null;

    const aggregate = Lap.aggregateByRace(race.id);
    const standings = aggregate.map((row, i) => ({
      position:     i + 1,
      entityId:     row.entity_id,
      entityType:   row.entity_type,
      name:         row.entity_name,
      color:        row.color || '#8b949e',
      totalLaps:    row.total_laps,
      bestLapMs:    row.best_lap_ms,
      avgLapMs:     row.avg_lap_ms != null ? Math.round(row.avg_lap_ms) : null,
      totalTimeMs:  row.total_time_ms,
      mangasRaced:  row.mangas_raced,
      exitCount:    row.exit_count,
    }));
    const leaderLaps = standings[0]?.totalLaps ?? 0;
    standings.forEach(s => { s.gapLaps = leaderLaps - s.totalLaps; });

    return {
      raceId:      race.id,
      name:        race.name,
      format:      race.format,
      type:        race.type,
      startedAt:   race.started_at,
      finishedAt:  race.finished_at,
      standings,
      // Ruta relativa al export Excel comparativa. La app móvil la
      // combina con la baseUrl del servidor al que está conectada para
      // formar la URL completa de descarga.
      excelPath:   `/races/${race.id}/results/xlsx`,
    };
  },
};

module.exports = MobileController;
