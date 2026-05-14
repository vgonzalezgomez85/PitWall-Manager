const Lap           = require('../models/Lap');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Team          = require('../models/Team');
const Driver        = require('../models/Driver');
const SerialService = require('./SerialService');
const SocketService = require('./SocketService');

const DEBOUNCE_MS    = 3000;
const EXIT_THRESHOLD = 2.5; // lap > 2.5× running avg → salida de pista

class TimingServiceClass {
  constructor() {
    this.session         = null;
    this._tickInt        = null;
    this._autoStopTimer  = null;
    this._lapHandler     = null;
    this._recentCrossings = new Map(); // lane → {timestamp, lapTimeMs}
    this._pendingSetup   = null; // manga queued for DS hardware GO
    this._tandaBoundary  = false; // true when last manga of a tanda just ended — blocks auto-GO
  }

  // Queue a manga to be started by DS hardware GO button
  setPendingManga(manga, race, lanes, teams, drivers) {
    this._pendingSetup = { manga, race, lanes, teams, drivers };
  }

  clearPendingManga() {
    this._pendingSetup = null;
  }

  // ── Start manga ───────────────────────────────────────────────────────────

  startManga(manga, race, lanes, teams, drivers, durationMs = null) {
    if (this.session) this.stopManga(false);

    const startTime = Date.now();
    const sessionDurationMs = durationMs || (race.manga_duration_minutes * 60 * 1000);

    const laneMap = {};
    lanes.forEach(ml => {
      if (ml.is_rest) return;
      laneMap[ml.lane] = {
        lane:         ml.lane,
        name:         ml.team_name || ml.driver_name || `Lane ${ml.lane}`,
        teamId:       ml.team_id   || null,
        driverId:     ml.driver_id || null,
        color:        ml.team_color || '#8b949e',
        lapCount:      0,
        validLapCount: 0,
        bestLapMs:     null,
        lastLapMs:     null,
        lastCrossing:  startTime,
        lapsMsSum:     0,
        lapAvgMs:      0,
        exitCount:     0,
        raceBestLapMs:    null,
        raceBestEntity:   null,
      };
    });

    // Load race-wide best laps from previous mangas
    const prevBests = Lap.raceBestByLane(race.id);
    prevBests.forEach(row => {
      if (laneMap[row.lane]) {
        laneMap[row.lane].raceBestLapMs  = row.bestLapMs;
        laneMap[row.lane].raceBestEntity = row.entityName;
      }
    });

    this.session = { manga, race, lanes, teams, drivers, laneMap, startTime, durationMs: sessionDurationMs, status: 'running' };

    const activeLanes = Object.keys(laneMap).map(Number);
    if (SerialService.isSimulating && activeLanes.length > 0) {
      SerialService.startSimulation(activeLanes.length);
    }

    this._lapHandler = ({ lane, timestamp, lapTimeMs }) => this._onCrossing(lane, timestamp, lapTimeMs);
    SerialService.on('lane_crossing', this._lapHandler);

    this._tickInt = setInterval(() => {
      SocketService.emit('tick', { elapsedMs: Date.now() - startTime });
    }, 1000);

    this._autoStopTimer = setTimeout(() => {
      console.log('[TimingService] Manga auto-stopped (time expired)');
      this.stopManga(true);
    }, sessionDurationMs);

    Manga.updateStatus(manga.id, 'active');
    SocketService.emit('manga:started', { mangaId: manga.id, ...this.getStandings() });
    console.log(`[TimingService] Manga ${manga.number} started — ${activeLanes.length} active lanes — ${race.manga_duration_minutes}min`);
  }

  // ── Stop manga ────────────────────────────────────────────────────────────

  stopManga(updateDb = true) {
    if (!this.session) return;

    clearInterval(this._tickInt);
    clearTimeout(this._autoStopTimer);
    this._tickInt = this._autoStopTimer = null;

    if (this._lapHandler) {
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }
    this._recentCrossings.clear();
    this._pendingSetup = null;

    let nextMangaId  = null;
    let nextLanes    = {};   // { currentLane → nextLane }
    let isTandaEnd   = false;
    let nextTandaId  = null;
    let nextTandaNumber = null;

    if (updateDb) {
      Manga.updateStatus(this.session.manga.id, 'finished');
      const next = Manga.nextPending(this.session.manga.tanda_id);

      if (!next) {
        // Last manga of this tanda — mark it finished and look for a next tanda
        Tanda.updateStatus(this.session.manga.tanda_id, 'finished');
        isTandaEnd = true;
        this._tandaBoundary = true; // block auto-GO until user explicitly starts next tanda

        const currentTanda = Tanda.findById(this.session.manga.tanda_id);
        const nextTanda    = currentTanda
          ? Tanda.findNextPending(this.session.race.id, currentTanda.number)
          : null;
        if (nextTanda) {
          nextTandaId     = nextTanda.id;
          nextTandaNumber = nextTanda.number;
        }
      } else {
        nextMangaId = next.id;

        // Build cardId → next-target map (cardId = lane number for racing,
        // r1..rN for resting entities sorted alphabetically). Each value is
        // { lane } for a racing slot or { rest:true, pos, total } for rest.
        const nextLaneDefs = Manga.getLanes(next.id);
        const nextRest = nextLaneDefs.filter(nl => nl.is_rest)
          .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
        const nextRestTotal = nextRest.length;
        const nextRestPos = {};
        nextRest.forEach((nl, i) => {
          const key = nl.team_id ? `t${nl.team_id}` : `d${nl.driver_id}`;
          nextRestPos[key] = i + 1;
        });
        const nextByEntity = {};
        for (const nl of nextLaneDefs) {
          if (!nl.team_id && !nl.driver_id) continue;
          const key = nl.team_id ? `t${nl.team_id}` : `d${nl.driver_id}`;
          nextByEntity[key] = nl.is_rest
            ? { rest: true, pos: nextRestPos[key] || 0, total: nextRestTotal }
            : { lane: nl.lane };
        }

        const curRest = this.session.lanes.filter(l => l.is_rest)
          .sort((a, b) => (a.team_name || a.driver_name || '').localeCompare(b.team_name || b.driver_name || ''));
        const curRestPos = {};
        curRest.forEach((cl, i) => {
          const key = cl.team_id ? `t${cl.team_id}` : `d${cl.driver_id}`;
          curRestPos[key] = i + 1;
        });

        for (const cl of this.session.lanes) {
          if (!cl.team_id && !cl.driver_id) continue;
          const key = cl.team_id ? `t${cl.team_id}` : `d${cl.driver_id}`;
          if (nextByEntity[key] == null) continue;
          const cardId = cl.is_rest ? `r${curRestPos[key] || 0}` : String(cl.lane);
          nextLanes[cardId] = nextByEntity[key];
        }

        // Pre-register next manga so DS-300 GO can start it immediately
        const tandaId = this.session.manga.tanda_id;
        const race    = this.session.race;
        const teams   = Team.findByTanda(tandaId);
        const drivers = Driver.findByTanda(tandaId);
        this._pendingSetup = { manga: next, race, lanes: nextLaneDefs, teams, drivers };
      }
    }

    SocketService.emit('manga:stopped', { mangaId: this.session.manga.id, nextMangaId, nextLanes, isTandaEnd, nextTandaId, nextTandaNumber });
    console.log(`[TimingService] Manga ${this.session.manga.number} stopped`);
    this.session = null;
  }

  // ── Pause / Resume manga ──────────────────────────────────────────────────

  pauseManga() {
    if (!this.session || this.session.status !== 'running') return;
    this.session.status    = 'paused';
    this.session.pauseStart = Date.now();
    clearInterval(this._tickInt);
    clearTimeout(this._autoStopTimer);
    this._tickInt = this._autoStopTimer = null;
    SocketService.emit('manga:paused');
    console.log(`[TimingService] Manga ${this.session.manga.number} paused`);
  }

  resumeManga() {
    if (!this.session || this.session.status !== 'paused') return;
    const pausedMs = Date.now() - this.session.pauseStart;
    this.session.startTime += pausedMs; // shift start so elapsed stays correct
    this.session.status     = 'running';
    this.session.pauseStart = null;

    this._tickInt = setInterval(() => {
      SocketService.emit('tick', { elapsedMs: Date.now() - this.session.startTime });
    }, 1000);

    const remaining = this.session.durationMs - (Date.now() - this.session.startTime);
    if (remaining > 0) {
      this._autoStopTimer = setTimeout(() => this.stopManga(true), remaining);
    }

    SocketService.emit('manga:resumed');
    console.log(`[TimingService] Manga ${this.session.manga.number} resumed`);
  }

  // ── Cancel manga (manual stop) — resets to pending, deletes laps ──────────

  cancelManga() {
    if (!this.session) return;

    clearInterval(this._tickInt);
    clearTimeout(this._autoStopTimer);
    this._tickInt = this._autoStopTimer = null;

    if (this._lapHandler) {
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }
    this._recentCrossings.clear();

    const mangaId = this.session.manga.id;
    const raceId  = this.session.race.id;

    // Delete all laps recorded in this session and reset manga to pending
    Lap.deleteByManga(mangaId);
    Manga.updateStatus(mangaId, 'pending');

    // Re-register as pending setup so DS-300 GO can restart it immediately
    const { manga, race, lanes, teams, drivers } = this.session;
    this._pendingSetup = { manga: { ...manga, status: 'pending' }, race, lanes, teams, drivers };

    SocketService.emit('manga:cancelled', { mangaId, raceId });
    console.log(`[TimingService] Manga ${this.session.manga.number} cancelled — reset to pending`);
    this.session = null;
  }

  // ── Lap crossing ──────────────────────────────────────────────────────────

  _onCrossing(lane, timestamp, deviceLapTimeMs) {
    if (!this.session || this.session.status !== 'running') return;

    const ld = this.session.laneMap[lane];
    if (!ld) return;

    // Use device-reported lap time when available; fall back to timestamp diff
    const lapTimeMs = deviceLapTimeMs ?? (timestamp - ld.lastCrossing);

    // Debounce only applies to timestamp-based measurements (not device-timed)
    if (!deviceLapTimeMs && lapTimeMs < DEBOUNCE_MS) return;

    // First crossing from device may have null lapTimeMs (no valid lap yet)
    if (deviceLapTimeMs === null) {
      ld.lastCrossing = timestamp;
      SocketService.emit('lane:on_track', { lane, color: ld.color, name: ld.name });
      return;
    }

    // ── Auto-ghost detection ─────────────────────────────────────────────────

    // Case 1: lap is below the circuit's minimum lap time
    const minLapMs = this.session.race.min_lap_ms || 0;
    let autoGhost = minLapMs > 0 && lapTimeMs < minLapMs;

    // Case 2: nearly simultaneous crossing on another lane (sensor interference)
    // If another lane crossed within 200ms AND this lap is less than half that
    // lane's lap time, this crossing is likely a ghost of the other lane's car
    let ghostFromLane = null;
    if (!autoGhost) {
      const SIMUL_WINDOW_MS = 200;
      for (const [otherLane, rec] of this._recentCrossings) {
        if (otherLane === lane) continue;
        if (timestamp - rec.timestamp < SIMUL_WINDOW_MS && lapTimeMs < rec.lapTimeMs * 0.5) {
          autoGhost    = true;
          ghostFromLane = otherLane;
          console.log(`[TimingService] Auto-ghost: lane ${lane} (${lapTimeMs}ms) — caused by lane ${otherLane} (${rec.lapTimeMs}ms)`);
          break;
        }
      }
    }

    // Clean up stale recent-crossings entries
    for (const [l, r] of this._recentCrossings) {
      if (timestamp - r.timestamp > 1000) this._recentCrossings.delete(l);
    }

    // ── Update in-memory state (only for non-ghost laps) ────────────────────

    if (!autoGhost) {
      const isExit = ld.lapAvgMs > 0 && lapTimeMs > ld.lapAvgMs * EXIT_THRESHOLD;

      ld.lapCount++;
      ld.lastLapMs    = lapTimeMs;
      ld.lastCrossing = timestamp;
      if (!ld.bestLapMs || lapTimeMs < ld.bestLapMs) ld.bestLapMs = lapTimeMs;
      if (!ld.raceBestLapMs || lapTimeMs < ld.raceBestLapMs) {
        ld.raceBestLapMs  = lapTimeMs;
        ld.raceBestEntity = ld.name;
      }

      if (isExit) {
        ld.exitCount++;
      } else {
        ld.validLapCount++;
        ld.lapsMsSum += lapTimeMs;
        ld.lapAvgMs   = ld.lapsMsSum / ld.validLapCount;
      }

      this._recentCrossings.set(lane, { timestamp, lapTimeMs });

      const elapsedMs = timestamp - this.session.startTime;
      const race    = this.session.race;
      const manga   = this.session.manga;
      const teamId  = ld.teamId;
      const driverId = ld.driverId;
      const lapNum  = ld.lapCount;

      setImmediate(() => {
        try {
          Lap.create({
            race_id: race.id, manga_id: manga.id,
            team_id: teamId, driver_id: driverId,
            lane, lap_number: lapNum,
            lap_time_ms: lapTimeMs, elapsed_ms: elapsedMs,
            is_exit: isExit ? 1 : 0,
          });
        } catch (err) { console.error('[TimingService] DB error:', err.message); }
      });

      SocketService.emit('lap', {
        lane, color: ld.color, name: ld.name,
        lapNumber: ld.lapCount, lapTimeMs, bestLapMs: ld.bestLapMs,
        elapsedMs, isExit,
      });
      SocketService.emit('standings', this.getStandings());

    } else {
      // Ghost lap: write to DB (for manual review) but don't update live standings
      ld.lastCrossing = timestamp;
      const elapsedMs = timestamp - this.session.startTime;
      const race    = this.session.race;
      const manga   = this.session.manga;
      const teamId  = ld.teamId;
      const driverId = ld.driverId;

      const fromLane = ghostFromLane;
      setImmediate(() => {
        try {
          const ghostId = Lap.create({
            race_id: race.id, manga_id: manga.id,
            team_id: teamId, driver_id: driverId,
            lane, lap_number: 0,
            lap_time_ms: lapTimeMs, elapsed_ms: elapsedMs,
            is_exit: 0, is_ghost: 1,
            ghost_from_lane: fromLane,
          });
          // Case 2: link ghost to the real lap on the triggering lane so the
          // corrections view shows the bidirectional "→ / ↔ de" relationship
          if (fromLane) {
            Lap.linkGhostToRealLap(ghostId, manga.id, fromLane);
          }
        } catch (err) { console.error('[TimingService] DB ghost error:', err.message); }
      });

      console.log(`[TimingService] Ghost lap recorded: lane ${lane} ${lapTimeMs}ms`);
      SocketService.emit('ghost_lap', { lane, lapTimeMs });
    }
  }

  // ── Standings ─────────────────────────────────────────────────────────────

  getStandings() {
    if (!this.session) return null;
    const { laneMap, startTime, manga, race } = this.session;

    const rows = Object.values(laneMap)
      .map(l => ({
        lane: l.lane, color: l.color, name: l.name,
        lapCount: l.lapCount, lastLapMs: l.lastLapMs, bestLapMs: l.bestLapMs,
        exitCount: l.exitCount,
        avgLapMs: l.lapAvgMs > 0 ? Math.round(l.lapAvgMs) : null,
      }))
      .sort((a, b) => b.lapCount - a.lapCount || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));

    const leaderLaps = rows[0]?.lapCount ?? 0;
    rows.forEach((r, i) => { r.position = i + 1; r.gap = leaderLaps - r.lapCount; });

    const raceBestLaps = {};
    Object.values(laneMap).forEach(l => {
      raceBestLaps[l.lane] = { bestLapMs: l.raceBestLapMs, entityName: l.raceBestEntity };
    });

    return {
      mangaId:      manga.id,
      raceId:       race.id,
      elapsedMs:    Date.now() - startTime,
      remainingMs:  Math.max(0, this.session.durationMs - (Date.now() - startTime)),
      standings:    rows,
      raceBestLaps,
    };
  }

  get isRunning()     { return this.session?.status === 'running'; }
  get activeMangaId() { return this.session?.manga?.id ?? null; }
}

module.exports = new TimingServiceClass();
