const Lap           = require('../models/Lap');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Team          = require('../models/Team');
const Driver        = require('../models/Driver');
const SerialService = require('./SerialService');
const SocketService = require('./SocketService');
const DebugLogger   = require('./DebugLogger');

const DEBOUNCE_MS    = 3000;
// Salida de pista (crash): a single lap is flagged as "exit" when it exceeds
// the lane's running average by at least EXIT_MARGIN_MS. The threshold is
// absolute (not a multiplier) because a crash adds a fixed recovery overhead
// regardless of how fast the lane normally laps.
//   lap_time ≥ avg + EXIT_MARGIN_MS  → exit (salida)
//
// Pit-stop: a much longer outlier (lap_time ≥ avg × PIT_STOP_MULTIPLIER) is
// flagged as pit-stop instead of a plain exit. Same in-memory treatment
// (doesn't pollute the average), different DB flag and UI icon (🔧).
const EXIT_MARGIN_MS     = 3000;
const PIT_STOP_MULTIPLIER = 2;

class TimingServiceClass {
  constructor() {
    this.session         = null;
    this._tickInt        = null;
    this._autoStopTimer  = null;
    this._lapHandler     = null;
    this._pendingSetup   = null; // manga queued for DS hardware GO
    this._tandaBoundary  = false; // true when last manga of a tanda just ended — blocks auto-GO
  }

  // Allow controllers (e.g. SessionController.repeat) to clear the boundary
  // when the user explicitly reactivates the last manga of a finished tanda.
  clearTandaBoundary() {
    this._tandaBoundary = false;
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
        bestLapMs:     null,
        lastLapMs:     null,
        lastCrossing:  startTime,
        avgLapCount:   0,   // # of laps that contribute to the average (every
                            //   racing lap counts, including exits & pit-stops;
                            //   only the first-crossing rolling start is excluded)
        lapsMsSum:     0,
        lapAvgMs:      0,
        // Media "limpia" — solo vueltas no-exit. Se usa ÚNICAMENTE para decidir
        // si una vuelta nueva es salida. Evita que las salidas previas suban
        // la media y "escondan" a las siguientes. La UI sigue mostrando
        // lapAvgMs (la otra) y la proyección usa esa también.
        cleanAvgCount: 0,
        cleanLapsSum:  0,
        cleanAvgMs:    0,
        // La primera vuelta REAL (la primera que entra en la rama "normal" con
        // un lap_time_ms del DS, sin contar el rolling start / first crossing)
        // se marca como "warmup" y NO cuenta para mejor vuelta. Muchas mangas
        // arrancan con un cruce inicial que infla/desinfla artificialmente
        // ese primer tiempo; ignorarlo evita que aparezca como vuelta rápida
        // espuria. Sí cuenta para totales, media y proyección.
        firstRealLapDone: false,
        exitCount:     0,
        pitStopCount:  0,
        raceBestLapMs:    null,
        raceBestEntity:   null,
        pendingPauseAdjustMs: 0,  // ms to subtract from the next reported lap_time
                                  //   so the first crossing post-resume reflects
                                  //   only real driving time (accumulates if
                                  //   several pause cycles happen with no crossing
                                  //   in between).
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
      const elapsedMs   = Date.now() - startTime;
      const remainingMs = Math.max(0, sessionDurationMs - elapsedMs);
      SocketService.emit('tick', { elapsedMs, remainingMs });
    }, 1000);

    this._autoStopTimer = setTimeout(() => {
      console.log('[TimingService] Manga auto-stopped (time expired)');
      this.stopManga(true);
    }, sessionDurationMs);

    Manga.updateStatus(manga.id, 'active');
    DebugLogger.startMangaLog(manga, race);
    DebugLogger.log('manga', { event: 'start', mangaNumber: manga.number, durationMs: sessionDurationMs, activeLanes });
    SocketService.emit('manga:started', { mangaId: manga.id, ...this.getStandings() });
    console.log(`[TimingService] Manga ${manga.number} started @ ${Date.now()} — ${activeLanes.length} active lanes — ${race.manga_duration_minutes}min`);
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

    DebugLogger.log('manga', { event: 'stop', mangaNumber: this.session.manga.number, isTandaEnd, nextMangaId });
    DebugLogger.endMangaLog();
    SocketService.emit('manga:stopped', { mangaId: this.session.manga.id, nextMangaId, nextLanes, isTandaEnd, nextTandaId, nextTandaNumber });
    console.log(`[TimingService] Manga ${this.session.manga.number} stopped`);

    // Cuando se cierra la ÚLTIMA manga de una tanda, empujamos el dossier
    // de stats acumulado a los clientes móviles para que actualicen su
    // histórico local. El móvil ve resultados parciales tras cada tanda
    // (no sólo al cerrar la carrera entera).
    if (isTandaEnd) {
      try {
        const MobileController = require('../controllers/MobileController');
        const snapshot = MobileController.buildStatsSnapshot(this.session.race.id);
        if (snapshot) SocketService.emit('race:stats-snapshot', snapshot);
      } catch (err) {
        console.error('[TimingService] stats-snapshot emit failed:', err.message);
      }
    }

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
    DebugLogger.log('manga', { event: 'pause', mangaNumber: this.session.manga.number });
    SocketService.emit('manga:paused');
    console.log(`[TimingService] Manga ${this.session.manga.number} paused`);
  }

  resumeManga() {
    if (!this.session || this.session.status !== 'paused') return;
    const pausedMs = Date.now() - this.session.pauseStart;
    this.session.startTime += pausedMs; // shift start so elapsed stays correct
    this.session.status     = 'running';
    this.session.pauseStart = null;

    // Accumulate pause duration into every active lane so the first crossing
    // post-resume per lane subtracts the pause time from the DS-reported
    // lap_time (the DS keeps counting during the pause and includes it in the
    // first reported lap after resume).
    for (const ld of Object.values(this.session.laneMap)) {
      ld.pendingPauseAdjustMs = (ld.pendingPauseAdjustMs || 0) + pausedMs;
    }
    console.log(`[TimingService] Manga ${this.session.manga.number} resumed after ${pausedMs}ms pause`);

    this._tickInt = setInterval(() => {
      const elapsedMs   = Date.now() - this.session.startTime;
      const remainingMs = Math.max(0, this.session.durationMs - elapsedMs);
      SocketService.emit('tick', { elapsedMs, remainingMs });
    }, 1000);

    const remaining = this.session.durationMs - (Date.now() - this.session.startTime);
    if (remaining > 0) {
      this._autoStopTimer = setTimeout(() => this.stopManga(true), remaining);
    }

    DebugLogger.log('manga', { event: 'resume', mangaNumber: this.session.manga.number, pausedMs });
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

    const mangaId = this.session.manga.id;
    const raceId  = this.session.race.id;

    // Delete all laps recorded in this session and reset manga to pending
    Lap.deleteByManga(mangaId);
    Manga.updateStatus(mangaId, 'pending');

    // Re-register as pending setup so DS-300 GO can restart it immediately
    const { manga, race, lanes, teams, drivers } = this.session;
    this._pendingSetup = { manga: { ...manga, status: 'pending' }, race, lanes, teams, drivers };

    DebugLogger.log('manga', { event: 'cancel', mangaNumber: this.session.manga.number, mangaId, raceId });
    DebugLogger.endMangaLog();
    SocketService.emit('manga:cancelled', { mangaId, raceId });
    console.log(`[TimingService] Manga ${this.session.manga.number} cancelled — reset to pending`);
    this.session = null;
  }

  // ── Lap crossing ──────────────────────────────────────────────────────────

  _onCrossing(lane, timestamp, deviceLapTimeMs) {
    if (!this.session || this.session.status !== 'running') {
      DebugLogger.log('crossing_dropped', { lane, deviceLapTimeMs, reason: this.session ? 'not_running' : 'no_session' });
      return;
    }

    const ld = this.session.laneMap[lane];
    if (!ld) {
      DebugLogger.log('crossing_dropped', { lane, deviceLapTimeMs, reason: 'lane_not_in_manga' });
      return;
    }

    DebugLogger.log('crossing', { lane, timestamp, deviceLapTimeMs, lapCountBefore: ld.lapCount, pendingPauseAdjustMs: ld.pendingPauseAdjustMs || 0 });

    // Use device-reported lap time when available; fall back to timestamp diff
    let lapTimeMs = deviceLapTimeMs ?? (timestamp - ld.lastCrossing);

    // Post-resume compensation: the DS-300 reports the first lap_time after a
    // resume including the pause duration. Subtract it so the lane continues
    // from the elapsed time it had when paused (real driving time only).
    if (ld.pendingPauseAdjustMs > 0 && lapTimeMs != null) {
      const adjusted = lapTimeMs - ld.pendingPauseAdjustMs;
      if (adjusted > 0) {
        console.log(`[TimingService] Lane ${lane} post-resume: ${lapTimeMs}ms - ${ld.pendingPauseAdjustMs}ms pause = ${adjusted}ms`);
        lapTimeMs = adjusted;
      }
      ld.pendingPauseAdjustMs = 0;
    }

    // Debounce only applies to timestamp-based measurements (not device-timed)
    if (!deviceLapTimeMs && lapTimeMs < DEBOUNCE_MS) return;

    // First crossing from device (no device-reported lap time): count it as
    // lap 1 with elapsed time from race start → first crossing.
    if (deviceLapTimeMs === null) {
      const firstLapMs = Math.max(0, Math.round(timestamp - this.session.startTime));
      ld.lapCount++;
      ld.lastLapMs    = firstLapMs;
      ld.lastCrossing = timestamp;
      // No best/avg update — first crossing isn't a true racing lap.

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
            lap_time_ms: firstLapMs, elapsed_ms: firstLapMs,
            is_exit: 0,
          });
        } catch (err) { console.error('[TimingService] DB error:', err.message); }
      });

      SocketService.emit('lane:on_track', { lane, color: ld.color, name: ld.name });
      SocketService.emit('lap', {
        lane, color: ld.color, name: ld.name,
        lapNumber: ld.lapCount, lapTimeMs: firstLapMs, bestLapMs: ld.bestLapMs,
        elapsedMs: firstLapMs, isExit: false, isFirstCrossing: true,
      });
      SocketService.emitStandings(this.getStandings());
      return;
    }

    // ── Auto-ghost detection ─────────────────────────────────────────────────
    // Per DS-300 manual: a ghost lap is one whose time is below the configured
    // Pt (minimum lap time). The effective Pt comes from
    // category override > circuit default > 0 (already resolved at race creation
    // time into `race.min_lap_ms`).
    const minLapMs = this.session.race.min_lap_ms || 0;
    const autoGhost = minLapMs > 0 && lapTimeMs < minLapMs;
    if (autoGhost) {
      DebugLogger.log('ghost_lap', { lane, lapTimeMs, minLapMs });
      console.log(`[TimingService] Ghost lap: lane ${lane} (${lapTimeMs}ms < Pt ${minLapMs}ms)`);
      const elapsedMs = timestamp - this.session.startTime;
      const race    = this.session.race;
      const manga   = this.session.manga;
      const teamId  = ld.teamId;
      const driverId = ld.driverId;

      // Persist the ghost on the originating lane (synchronously so we can
      // optionally transfer it to another lane below using its id).
      let ghostId = null;
      try {
        ghostId = Lap.create({
          race_id: race.id, manga_id: manga.id,
          team_id: teamId, driver_id: driverId,
          lane, lap_number: 0,
          lap_time_ms: lapTimeMs, elapsed_ms: elapsedMs,
          is_exit: 0, is_ghost: 1,
        });
      } catch (err) { console.error('[TimingService] DB error (ghost lap):', err.message); }

      // Heuristic auto-reassignment: pick the lane that is most "overdue"
      // (silent for longer than its own average). If found, transfer the lap
      // there using the same flow as a manual correction.
      const targetLane = this._findOverdueLane(lane, timestamp);
      if (targetLane != null && ghostId) {
        const tld = this.session.laneMap[targetLane];
        console.log(`[TimingService] Auto-reassign: lap from lane ${lane} → lane ${targetLane} (${tld?.name})`);
        try {
          Lap.transfer(ghostId, targetLane, manga.id, race.id);
        } catch (err) { console.error('[TimingService] DB error (transfer):', err.message); }

        // Mirror the lap into the destination lane's in-memory state so the
        // standings emitted right after reflect the new count immediately.
        if (tld) {
          tld.lapCount++;
          tld.lastLapMs    = lapTimeMs;
          tld.lastCrossing = timestamp;
          if (!tld.bestLapMs || lapTimeMs < tld.bestLapMs) tld.bestLapMs = lapTimeMs;
          tld.avgLapCount++;
          tld.lapsMsSum += lapTimeMs;
          tld.lapAvgMs   = tld.lapsMsSum / tld.avgLapCount;
        }

        SocketService.emit('lap:reassigned', {
          fromLane: lane, toLane: targetLane,
          color: tld?.color, name: tld?.name,
          lapTimeMs, elapsedMs,
        });
        SocketService.emitStandings(this.getStandings());
        return;
      }

      // No reasonable destination — keep it as a ghost for manual review.
      SocketService.emit('lap:ghost', {
        lane, color: ld.color, name: ld.name,
        lapTimeMs, ptMs: minLapMs, elapsedMs,
      });
      return;
    }

    // ── Normal (non-ghost) lap: update in-memory state and persist ───────────

    // Retroactive crash detection: when the 2nd valid lap arrives, check
    // whether the 1st lap was actually a crash. If lap1 − lap2 ≥ EXIT_MARGIN_MS
    // then lap1 was the salida; flip its is_exit (and is_pit_stop, if ratio≥2)
    // in DB so it shows up in /corrections. The average is NOT touched: exits
    // and pit-stops contribute to the lane average just like normal laps, so
    // that the projected total laps for the race reflects reality.
    if (ld.lapCount === 1 && ld.avgLapCount === 1 &&
        ld.lastLapMs - lapTimeMs >= EXIT_MARGIN_MS && ld.lastLapId) {
      const prevId = ld.lastLapId;
      const prevMs = ld.lastLapMs;
      const wasPit = lapTimeMs > 0 && prevMs >= lapTimeMs * PIT_STOP_MULTIPLIER;
      console.log(`[TimingService] Retro-exit on lane ${lane}: lap1 ${prevMs}ms was a ${wasPit ? 'pit-stop' : 'crash'} (lap2 ${lapTimeMs}ms)`);
      setImmediate(() => {
        try {
          require('../config/database')
            .prepare('UPDATE laps SET is_exit = 1, is_pit_stop = ? WHERE id = ?')
            .run(wasPit ? 1 : 0, prevId);
        } catch (err) { console.error('[TimingService] DB error (retro exit):', err.message); }
      });
      ld.exitCount++;
      if (wasPit) ld.pitStopCount++;
      // Lap 1 fue añadida a la "media limpia" en su procesamiento normal
      // (no era exit en ese momento). Ahora que la reclasificamos como exit
      // retroactivamente, la sacamos de las cuentas limpias para que el
      // umbral siguiente vuelva a basarse en pace real.
      ld.cleanAvgCount = Math.max(0, ld.cleanAvgCount - 1);
      ld.cleanLapsSum  = Math.max(0, ld.cleanLapsSum  - prevMs);
      ld.cleanAvgMs    = ld.cleanAvgCount > 0 ? ld.cleanLapsSum / ld.cleanAvgCount : 0;
      // Tell clients to repaint lap1 as a salida.
      SocketService.emit('lap:retro_exit', {
        lane, color: ld.color, name: ld.name,
        lapNumber: 1, lapTimeMs: prevMs, isPitStop: wasPit,
      });
    }

    // Para decidir si una vuelta es salida usamos la MEDIA LIMPIA (que excluye
    // salidas previas). Si aún no hay vueltas limpias (primeras vueltas o
    // piloto que solo ha salido), caemos a la media total como fallback.
    const refAvg = ld.cleanAvgMs > 0 ? ld.cleanAvgMs : ld.lapAvgMs;
    const isExit    = refAvg > 0 && lapTimeMs - refAvg >= EXIT_MARGIN_MS;
    // A pit-stop is a *very* long outlier: at least 2× la media limpia.
    const isPitStop = isExit && lapTimeMs >= refAvg * PIT_STOP_MULTIPLIER;

    ld.lapCount++;
    ld.lastLapMs    = lapTimeMs;
    ld.lastCrossing = timestamp;
    // Primera vuelta real de la manga: NO compite por mejor vuelta. Se marca
    // como warmup y se persiste con is_warmup=1 para que tampoco salga del DB
    // como best en mangas futuras.
    const isWarmup = !ld.firstRealLapDone;
    ld.firstRealLapDone = true;
    if (!isWarmup) {
      if (!ld.bestLapMs || lapTimeMs < ld.bestLapMs) ld.bestLapMs = lapTimeMs;
      if (!ld.raceBestLapMs || lapTimeMs < ld.raceBestLapMs) {
        ld.raceBestLapMs  = lapTimeMs;
        ld.raceBestEntity = ld.name;
      }
    }

    if (isExit) {
      ld.exitCount++;
      if (isPitStop) ld.pitStopCount++;
    }
    // Every racing lap (including exits and pit-stops, EXCLUDING warmup)
    // contributes a la media. La warmup tiene artefactos (countdown del
    // semáforo, cruce inicial) que no representan el ritmo real, así que
    // queda fuera. La proyección "vueltas estimadas al final de la carrera"
    // usa esta media — coherente con la fórmula `totalRaceMs / lapAvgMs`.
    if (!isWarmup) {
      ld.avgLapCount++;
      ld.lapsMsSum += lapTimeMs;
      ld.lapAvgMs   = ld.lapsMsSum / ld.avgLapCount;
    }
    // Media limpia: solo vueltas no-exit. Usada para detectar salidas futuras.
    if (!isExit) {
      ld.cleanAvgCount++;
      ld.cleanLapsSum += lapTimeMs;
      ld.cleanAvgMs    = ld.cleanLapsSum / ld.cleanAvgCount;
    }

    const elapsedMs = timestamp - this.session.startTime;
    const race    = this.session.race;
    const manga   = this.session.manga;
    const teamId  = ld.teamId;
    const driverId = ld.driverId;
    const lapNum  = ld.lapCount;

    // Synchronous create so we can remember the new row id on `ld.lastLapId`
    // — needed by the retro-exit check on the *next* lap.
    try {
      ld.lastLapId = Lap.create({
        race_id: race.id, manga_id: manga.id,
        team_id: teamId, driver_id: driverId,
        lane, lap_number: lapNum,
        lap_time_ms: lapTimeMs, elapsed_ms: elapsedMs,
        is_exit: isExit ? 1 : 0,
        is_pit_stop: isPitStop ? 1 : 0,
        is_warmup: isWarmup ? 1 : 0,
      });
    } catch (err) { console.error('[TimingService] DB error:', err.message); }

    SocketService.emit('lap', {
      lane, color: ld.color, name: ld.name,
      lapNumber: ld.lapCount, lapTimeMs, bestLapMs: ld.bestLapMs,
      elapsedMs, isExit, isPitStop,
      pitStopCount: ld.pitStopCount,
    });
    SocketService.emitStandings(this.getStandings());
  }

  // Pick the lane (other than `skipLane`) that's "most overdue": the one whose
  // time since its last crossing exceeds its own average lap time by the
  // largest margin. Returns the lane number or null if nobody is overdue.
  //
  // Lanes without an average yet (haven't completed any valid lap) are skipped:
  // we can't tell whether they're late or just slow on their first attempt.
  _findOverdueLane(skipLane, timestamp) {
    if (!this.session) return null;
    let best = null;
    let bestDebt = 0;
    for (const ld of Object.values(this.session.laneMap)) {
      if (ld.lane === skipLane) continue;
      if (!ld.lapAvgMs || ld.lapAvgMs <= 0) continue;
      const elapsedSinceLast = timestamp - ld.lastCrossing;
      const debt = elapsedSinceLast - ld.lapAvgMs;
      // Require a meaningful margin (20% of the lane's avg) so we don't grab
      // a lap from a lane that's just a tick behind schedule.
      if (debt > ld.lapAvgMs * 0.2 && debt > bestDebt) {
        best = ld.lane;
        bestDebt = debt;
      }
    }
    return best;
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
        pitStopCount: l.pitStopCount || 0,
        avgLapMs: l.lapAvgMs > 0 ? Math.round(l.lapAvgMs) : null,
      }))
      .sort((a, b) => b.lapCount - a.lapCount || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));

    const leaderLaps = rows[0]?.lapCount ?? 0;
    rows.forEach((r, i) => { r.position = i + 1; r.gap = leaderLaps - r.lapCount; });

    const raceBestLaps = {};
    Object.values(laneMap).forEach(l => {
      raceBestLaps[l.lane] = { bestLapMs: l.raceBestLapMs, entityName: l.raceBestEntity };
    });

    // Race-wide running average per lane: combines all prior mangas (from DB)
    // with the current manga's in-memory state, so the sidebar can show a
    // race-wide projected average that updates lap by lap.
    const db = require('../config/database');
    const priorStats = db.prepare(`
      SELECT lane, COUNT(*) AS cnt, AVG(lap_time_ms) AS avg_ms
      FROM laps
      WHERE race_id = ? AND manga_id != ?
        AND is_ghost = 0 AND is_warmup = 0 AND lap_number > 0
      GROUP BY lane
    `).all(race.id, manga.id);
    const priorByLane = {};
    priorStats.forEach(p => { priorByLane[p.lane] = { count: p.cnt, avg: p.avg_ms }; });
    rows.forEach(r => {
      const prior = priorByLane[r.lane];
      const priorCount = prior?.count || 0;
      const priorSum   = prior ? prior.avg * prior.count : 0;
      const currCount  = r.lapCount;
      const currSum    = laneMap[r.lane].lapsMsSum || 0;
      const totalCount = priorCount + currCount;
      r.raceAvgLapMs = totalCount > 0 ? Math.round((priorSum + currSum) / totalCount) : null;
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
