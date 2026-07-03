const Lap           = require('../models/Lap');
const Manga         = require('../models/Manga');
const Tanda         = require('../models/Tanda');
const Team          = require('../models/Team');
const Driver        = require('../models/Driver');
const DriverShift   = require('../models/DriverShift');
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
// Umbral +1.7s: punto medio entre detectar solo crashes graves (+3s perdía
// salidas reales) y contar tráfico/toques leves como piño (TicTac usa ~+1.2s
// para su "vuelta lenta", demasiado sensible). A +1.7s captura las salidas de
// pista de verdad sin marcar cada vuelta lenta de tráfico.
//
// Pit-stop: a much longer outlier (lap_time ≥ avg × PIT_STOP_MULTIPLIER) is
// flagged as pit-stop instead of a plain exit. Same in-memory treatment
// (doesn't pollute the average), different DB flag and UI icon (🔧).
const EXIT_MARGIN_MS     = 1700;
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

  startManga(manga, race, lanes, teams, drivers, durationMs = null, startCircuitIndex = 0) {
    if (this.session) this.stopManga(false);

    // Si TrainingService se había auto-activado por el mismo GO (su listener
    // de race_started corre antes que el de app.js que llama aquí), hay que
    // pararlo: ese GO pertenece a la manga oficial, no al training libre.
    try {
      const TrainingService = require('./TrainingService');
      if (TrainingService.isReady) {
        TrainingService.stop();
        console.log('[TimingService] Training libre detenido — la manga oficial toma el control del GO');
      }
    } catch {}

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
        country:      ml.team_country || null,
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
        // espuria. Cuenta para el total de vueltas, pero queda fuera de la
        // media (y por tanto de la proyección).
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

    // ── Estado por circuito ───────────────────────────────────────────────
    // Una manga abarca todos los circuitos, pero cada uno tiene ciclo de vida
    // propio (GO/fin/reloj). El mapa carril→circuito sale de circuits_config
    // (mismos offsets que SerialService). Arrancamos SOLO el circuito cuyo GO
    // disparó esto; los demás quedan 'pending' hasta recibir su propio GO.
    const { circuits, laneToCircuit } = this._buildCircuits(race, sessionDurationMs, startTime, startCircuitIndex);

    this.session = { manga, race, lanes, teams, drivers, laneMap, startTime, durationMs: sessionDurationMs, status: 'running', circuits, laneToCircuit };

    // Persistir la duración REAL que mandó el DS al arrancar (GO). Así la
    // clasificación estimada la usa también en mangas ya terminadas o tras
    // recargar, en vez del placeholder manga_duration_minutes (p.ej. 99 min),
    // que inflaría la proyección ~10×. Solo si el DS dio un valor real.
    if (durationMs && durationMs > 0) {
      try {
        const dbc = require('../config/database');
        dbc.prepare('UPDATE mangas SET actual_duration_ms = ? WHERE id = ?')
           .run(durationMs, manga.id);
        // La duración de manga la marca el DS-300 en el GO. Al arrancar la
        // PRIMERA manga de la carrera (ninguna otra tiene aún duración real),
        // ese tiempo es el de referencia del evento: lo guardamos como
        // manga_duration_minutes de la carrera para que cualquier cálculo que
        // use ese campo (fallback de arranque, proyección sin manga viva, etc.)
        // parta del tiempo REAL del DS y no del valor por defecto.
        const priorRun = dbc.prepare(
          'SELECT COUNT(*) AS c FROM mangas WHERE race_id = ? AND id <> ? AND actual_duration_ms IS NOT NULL'
        ).get(race.id, manga.id).c;
        if (priorRun === 0) {
          const mins = Math.round(durationMs / 60000);
          if (mins > 0) {
            dbc.prepare('UPDATE races SET manga_duration_minutes = ? WHERE id = ?')
               .run(mins, race.id);
          }
        }
      } catch (err) { console.error('[TimingService] persist duration error:', err.message); }
    }

    const activeLanes = Object.keys(laneMap).map(Number);
    if (SerialService.isSimulating && activeLanes.length > 0) {
      SerialService.startSimulation(activeLanes.length);
    }

    this._lapHandler = ({ lane, timestamp, lapTimeMs }) => this._onCrossing(lane, timestamp, lapTimeMs);
    SerialService.on('lane_crossing', this._lapHandler);

    // ── Driver shifts (solo carreras de campeonato) ────────────────────
    // Mapa en memoria: lane → { shiftId, drivingMs }. Se incrementa cada
    // tick mientras la manga esté running. Se persiste a BD cada 5s.
    this._isChampionship = (race.type === 'championship');
    this._activeShiftsByLane = {};
    if (this._isChampionship) {
      // Activa los shifts pre-armados que el staff haya escaneado durante
      // el standby: les setea started_at_ms = startTime y pre_armed=0.
      DriverShift.activatePreArmedShifts(manga.id, startTime);
      // Carga el mapa en memoria de los shifts abiertos (los recién activados
      // y cualquier otro que pueda haber quedado pendiente de un crash).
      DriverShift.findAllOpenByManga(manga.id).forEach(s => {
        this._activeShiftsByLane[s.lane] = { shiftId: s.id, drivingMs: s.driving_ms || 0 };
      });
    }
    this._driverShiftTickN = 0; // contador para persistir cada 5 ticks

    this._startTick();

    // Auto-fin del circuito de arranque al agotar SU tiempo. Cada circuito
    // programa el suyo al recibir su propio GO (startCircuit).
    this._scheduleCircuitAutoFinish(startCircuitIndex);

    Manga.updateStatus(manga.id, 'active');
    DebugLogger.startMangaLog(manga, race);
    DebugLogger.log('manga', { event: 'start', mangaNumber: manga.number, durationMs: sessionDurationMs, activeLanes });
    SocketService.emit('manga:started', { mangaId: manga.id, ...this.getStandings() });
    console.log(`[TimingService] Manga ${manga.number} started @ ${Date.now()} — ${activeLanes.length} active lanes — ${race.manga_duration_minutes}min`);

    // Inversión de control: en fuentes que SlotTime pilota (BART) hay que
    // ARRANCAR el hardware. No-op en DS-300 (manda la caja). Best-effort.
    SerialService.sendStart();
  }

  // ── Estado por circuito (helpers) ───────────────────────────────────────────

  // Construye el mapa carril→circuito y el estado por circuito a partir de
  // circuits_config (p.ej. "[8,8]"). Solo `startCi` arranca; el resto 'pending'.
  _buildCircuits(race, durationMs, startTime, startCi) {
    let cfg = [];
    try { cfg = JSON.parse(race.circuits_config || '[]'); } catch {}
    const counts = (Array.isArray(cfg) && cfg.length) ? cfg : [race.lanes_count || 0];
    const circuits = {};
    const laneToCircuit = {};
    let off = 0;
    counts.forEach((n, ci) => {
      for (let l = off + 1; l <= off + n; l++) laneToCircuit[l] = ci;
      circuits[ci] = {
        index: ci,
        status: ci === startCi ? 'running' : 'pending',
        startTime: ci === startCi ? startTime : null,
        durationMs,
        autoStopTimer: null,
        laneCount: n,
      };
      off += n;
    });
    // Salvaguarda: si el circuito de arranque no aparece en la config, créalo.
    if (!circuits[startCi]) {
      circuits[startCi] = { index: startCi, status: 'running', startTime, durationMs, autoStopTimer: null, laneCount: 0 };
    }
    return { circuits, laneToCircuit };
  }

  // (Re)programa el auto-fin de un circuito según el tiempo que le queda.
  _scheduleCircuitAutoFinish(ci) {
    const c = this.session && this.session.circuits[ci];
    if (!c) return;
    if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    const elapsed   = c.startTime ? (Date.now() - c.startTime) : 0;
    const remaining = Math.max(0, c.durationMs - elapsed);
    c.autoStopTimer = setTimeout(() => {
      console.log(`[TimingService] Circuito ${ci + 1} auto-finalizado (tiempo agotado)`);
      this.finishCircuit(ci);
    }, remaining);
  }

  _clearAllCircuitTimers() {
    if (!this.session || !this.session.circuits) return;
    for (const c of Object.values(this.session.circuits)) {
      if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    }
  }

  // Carriles activos (en laneMap) que pertenecen a un circuito.
  _circuitLanes(ci) {
    if (!this.session) return [];
    return Object.values(this.session.laneMap)
      .filter(ld => this.session.laneToCircuit[ld.lane] === ci)
      .map(ld => ld.lane);
  }

  // Reloj de cada circuito para la UI: tiempo restante propio según su estado.
  _circuitClocks() {
    if (!this.session) return [];
    const now = Date.now();
    return Object.values(this.session.circuits)
      .sort((a, b) => a.index - b.index)
      .map(c => {
        let remainingMs;
        if (c.status === 'pending')       remainingMs = c.durationMs;
        else if (c.status === 'finished') remainingMs = 0;
        else if (c.status === 'paused')   remainingMs = Math.max(0, c.durationMs - ((c.pauseStart || now) - c.startTime));
        else                               remainingMs = Math.max(0, c.durationMs - (now - c.startTime));
        return { index: c.index, status: c.status, remainingMs };
      });
  }

  // Arranca un circuito por su GO (cuando la manga ya existe). Cada circuito
  // cuenta su tiempo desde SU propio GO.
  startCircuit(ci, durationMs = null) {
    if (!this.session) return;
    const c = this.session.circuits[ci];
    if (!c) { console.log(`[TimingService] startCircuit: circuito ${ci + 1} no está en la config`); return; }
    if (c.status === 'running') return;   // su GO ya estaba dado → ignorar
    c.status    = 'running';
    c.startTime = Date.now();
    if (durationMs) c.durationMs = durationMs;
    this._scheduleCircuitAutoFinish(ci);
    console.log(`[TimingService] Circuito ${ci + 1} arrancado @ ${c.startTime}`);
    SocketService.emitStandings(this.getStandings());
  }

  // Arranca TODOS los circuitos pendientes a la vez. En simulación/BART hay una
  // sola señal de GO (no una caja DS por circuito), así que un único arranque
  // cubre todos los carriles. No-op para los que ya corren.
  startAllCircuits(durationMs = null) {
    if (!this.session) return;
    Object.values(this.session.circuits).forEach(c => {
      if (c.status === 'pending') this.startCircuit(c.index, durationMs);
    });
  }

  // ── Reloj simulado ──────────────────────────────────────────────────────────
  // En una carrera simulada el tiempo NO avanza con el reloj de pared: avanza
  // según las tramas reproducidas (a ×N, o de golpe al "final de manga"). El
  // reproductor llama aquí con los milisegundos transcurridos DESDE EL GO de la
  // manga; anclamos startTime para que el cronómetro y el elapsed_ms de cada
  // vuelta reflejen ese tiempo virtual. Así el contador va a ×N y, al volcar el
  // final de manga de golpe, salta hasta el final con las vueltas repartidas en
  // su minuto real (no amontonadas en el 0).
  simSetClock(elapsedMs) {
    if (!this.session) return;
    const anchor = Date.now() - Math.max(0, elapsedMs);
    this.session.startTime = anchor;
    Object.values(this.session.circuits).forEach(c => {
      if (c.status === 'running') c.startTime = anchor;
    });
  }

  // Finaliza un circuito (fin normal o tiempo agotado). La manga se cierra de
  // verdad cuando NINGÚN circuito sigue corriendo y al menos uno terminó.
  finishCircuit(ci) {
    if (!this.session) return;
    const c = this.session.circuits[ci];
    if (!c || c.status !== 'running') return;
    c.status = 'finished';
    if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    console.log(`[TimingService] Circuito ${ci + 1} finalizado`);

    const list = Object.values(this.session.circuits);
    const anyRunning  = list.some(x => x.status === 'running');
    const anyFinished = list.some(x => x.status === 'finished');
    if (!anyRunning && anyFinished) {
      console.log('[TimingService] Todos los circuitos finalizados → cierre de manga');
      this.stopManga(true);
    } else {
      SocketService.emitStandings(this.getStandings());
    }
  }

  // ── Stop manga ────────────────────────────────────────────────────────────

  stopManga(updateDb = true) {
    if (!this.session) return;

    // Inversión de control: parar el hardware que SlotTime pilota (BART).
    // No-op en DS-300. Best-effort.
    SerialService.sendStop();

    clearInterval(this._tickInt);
    clearTimeout(this._autoStopTimer);
    this._tickInt = this._autoStopTimer = null;
    this._clearAllCircuitTimers();

    if (this._lapHandler) {
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }
    this._pendingSetup = null;

    // Cierra todos los shifts abiertos de la manga (persiste driving_ms
    // final + ended_at_ms). Solo aplica a campeonato.
    if (this._isChampionship) {
      this._persistAllDriverShifts();
      DriverShift.closeAllOpenForManga(this.session.manga.id, Date.now());
      this._activeShiftsByLane = {};
    }

    let nextMangaId  = null;
    let nextLanes    = {};   // { currentLane → nextLane }
    let isTandaEnd   = false;
    let nextTandaId  = null;
    let nextTandaNumber = null;

    if (updateDb) {
      // "Coma": fracción de la vuelta en curso al caer la bandera, estimada
      // como (fin del circuito − último cruce) / media limpia del carril y
      // capada a 0.99 (con un solo sensor en meta nunca puede ser vuelta
      // entera). Se persiste en manga_lanes.coma para el desempate a igual
      // número de vueltas en la clasificación.
      const dbConn = require('../config/database');
      const comaStmt = dbConn.prepare('UPDATE manga_lanes SET coma = ? WHERE manga_id = ? AND lane = ?');
      const nowTs = Date.now();
      for (const ld of Object.values(this.session.laneMap)) {
        const ci = this.session.laneToCircuit[ld.lane];
        const c  = ci != null ? this.session.circuits[ci] : null;
        const endTs = c ? Math.min(nowTs, c.startTime + (c.durationMs || this.session.durationMs)) : nowTs;
        const refAvg = ld.cleanAvgMs > 0 ? ld.cleanAvgMs : ld.lapAvgMs;
        let coma = 0;
        if (ld.lapCount > 0 && refAvg > 0 && ld.lastCrossing) {
          coma = Math.min(0.99, Math.max(0, (endTs - ld.lastCrossing) / refAvg));
        }
        try {
          comaStmt.run(+coma.toFixed(3), this.session.manga.id, ld.lane);
        } catch (err) { console.error('[TimingService] persist coma error:', err.message); }
      }

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

  // ── Tick (cronómetro global de la manga) ────────────────────────────────────

  _startTick() {
    if (this._tickInt) return;
    this._tickInt = setInterval(() => {
      const elapsedMs   = Date.now() - this.session.startTime;
      const remainingMs = Math.max(0, this.session.durationMs - elapsedMs);
      SocketService.emit('tick', { elapsedMs, remainingMs, circuits: this._circuitClocks() });
      // Incremento del contador de cada piloto activo y persistencia periódica.
      if (this._isChampionship) this._tickDriverShifts();
    }, 1000);
  }

  // ── Pausa / Resume POR CIRCUITO ─────────────────────────────────────────────
  // Cada DS pausa/reanuda SOLO su circuito. El overlay global de pausa y el
  // congelado del cronómetro solo se aplican cuando TODOS los circuitos están
  // pausados. La compensación (pendingPauseAdjustMs) se aplica solo a los
  // carriles del circuito reanudado, con SU propia duración de pausa.

  pauseCircuit(ci) {
    if (!this.session) return;
    const c = this.session.circuits[ci];
    if (!c || c.status !== 'running') return;
    c.status     = 'paused';
    c.pauseStart = Date.now();
    if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }

    // Inversión de control: en BART pausamos el Master (corta pista y deja de
    // contar). No-op en DS-300/simulación. Best-effort.
    SerialService.sendPause(ci);
    if (this._isChampionship) this._persistAllDriverShifts();
    console.log(`[TimingService] Circuito ${ci + 1} pausado`);
    DebugLogger.log('manga', { event: 'pause', circuit: ci, mangaNumber: this.session.manga.number });

    // Si ya no queda ningún circuito corriendo, la manga está totalmente en
    // pausa: congelamos el cronómetro global y mostramos el overlay.
    const anyRunning = Object.values(this.session.circuits).some(x => x.status === 'running');
    if (!anyRunning) {
      this.session.pauseStart = Date.now();
      clearInterval(this._tickInt); this._tickInt = null;
      SocketService.emit('manga:paused');
    }
    // Feedback por circuito: marca sus carriles como pausados en la vista live.
    SocketService.emit('circuit:state', { circuit: ci, status: 'paused', lanes: this._circuitLanes(ci) });
    SocketService.emitStandings(this.getStandings());
  }

  resumeCircuit(ci) {
    if (!this.session) return;
    const c = this.session.circuits[ci];
    if (!c || c.status !== 'paused') return;
    const pausedMs = Date.now() - (c.pauseStart || Date.now());
    c.startTime += pausedMs;       // su reloj se desplaza por SU pausa
    c.status     = 'running';
    c.pauseStart = null;

    // Compensación SOLO a los carriles de este circuito: el primer cruce tras
    // el resume resta su propia pausa (el DS sigue contando durante la pausa).
    // En BART NO se aplica: el Master se pausó de verdad (dejó de contar), así
    // que el lap_ms posterior ya es tiempo real de pista, sin la pausa dentro.
    if (!SerialService.isBart) {
      for (const ld of Object.values(this.session.laneMap)) {
        if (this.session.laneToCircuit[ld.lane] === ci) {
          ld.pendingPauseAdjustMs = (ld.pendingPauseAdjustMs || 0) + pausedMs;
        }
      }
    }
    // Inversión de control: reanudar el Master BART (no hay OP_RESUME → START).
    SerialService.sendResume(ci);
    this._scheduleCircuitAutoFinish(ci);
    console.log(`[TimingService] Circuito ${ci + 1} reanudado tras ${pausedMs}ms`);
    DebugLogger.log('manga', { event: 'resume', circuit: ci, pausedMs, mangaNumber: this.session.manga.number });

    // Si la manga estaba totalmente pausada (cronómetro congelado), lo
    // reanudamos desplazando el inicio global por el tiempo que estuvo parada.
    if (!this._tickInt) {
      if (this.session.pauseStart) {
        this.session.startTime += Date.now() - this.session.pauseStart;
        this.session.pauseStart = null;
      }
      this._startTick();
    }
    SocketService.emit('manga:resumed');
    SocketService.emit('circuit:state', { circuit: ci, status: 'running', lanes: this._circuitLanes(ci) });
    SocketService.emitStandings(this.getStandings());
  }

  // Pausa/reanuda TODA la manga (botón PAUSE/RESUME de la UI en simulación/BART).
  // En DS-300 la pausa la dispara la caja (race_paused) por circuito.
  pauseManga() {
    if (!this.session) return;
    Object.values(this.session.circuits).forEach(c => { if (c.status === 'running') this.pauseCircuit(c.index); });
  }
  resumeManga() {
    if (!this.session) return;
    Object.values(this.session.circuits).forEach(c => { if (c.status === 'paused') this.resumeCircuit(c.index); });
  }
  // Reanudar en simulación: como resumeManga pero anulando la compensación de
  // pausa del DS-300. En una carrera real la caja sigue contando durante la
  // pausa y la primera vuelta tras reanudar viene inflada; en la simulación
  // paramos de inyectar tramas, así que el tiempo de vuelta ya es el real del
  // dato y NO hay que restarle nada.
  simResumeManga() {
    if (!this.session) return;
    this.resumeManga();
    Object.values(this.session.laneMap).forEach(ld => { ld.pendingPauseAdjustMs = 0; });
  }

  // ── Cancel manga (manual stop) — resets to pending, deletes laps ──────────

  cancelManga() {
    if (!this.session) return;

    // Inversión de control: parar el hardware que SlotTime pilota (BART).
    // No-op en DS-300. Best-effort.
    SerialService.sendStop();

    clearInterval(this._tickInt);
    clearTimeout(this._autoStopTimer);
    this._tickInt = this._autoStopTimer = null;
    this._clearAllCircuitTimers();

    if (this._lapHandler) {
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }

    const mangaId = this.session.manga.id;
    const raceId  = this.session.race.id;

    // Delete all laps recorded in this session and reset manga to pending
    Lap.deleteByManga(mangaId);
    Manga.updateStatus(mangaId, 'pending');
    // Borrar shifts de la manga cancelada (vuelve a 'pending' → el staff
    // tendrá que re-escanear los pilotos). Solo aplica a campeonato.
    if (this._isChampionship) {
      DriverShift.deleteByManga(mangaId);
      this._activeShiftsByLane = {};
    }

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
    if (!this.session) {
      DebugLogger.log('crossing_dropped', { lane, deviceLapTimeMs, reason: 'no_session' });
      return;
    }

    // El circuito de este carril debe estar corriendo: su GO dado y aún sin
    // finalizar. Así, un cruce de un circuito que todavía no arrancó —o que ya
    // terminó— no entra en la manga ni descuadra los tiempos.
    const ci = this.session.laneToCircuit[lane];
    const circuit = ci != null ? this.session.circuits[ci] : null;
    if (!circuit || circuit.status !== 'running') {
      DebugLogger.log('crossing_dropped', { lane, deviceLapTimeMs, reason: 'circuit_not_running', circuit: ci });
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

    // Debounce only applies to timestamp-based measurements (not device-timed).
    // El cruce de salida (lapCount 0) queda exento: con el coche parado pegado
    // a la línea puede llegar a <3s del GO y es un cruce legítimo que debe
    // contar como vuelta (regla del club: cuenta como vuelta, no como VR).
    if (!deviceLapTimeMs && ld.lapCount > 0 && lapTimeMs < DEBOUNCE_MS) return;

    // First crossing from device (no device-reported lap time): count it as
    // lap 1 with elapsed time from race start → first crossing.
    if (deviceLapTimeMs === null) {
      const firstLapMs = Math.max(0, Math.round(timestamp - circuit.startTime));
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
            // Cruce de salida: cuenta como vuelta pero nunca como VR/mejor ni
            // en la media — is_warmup=1 lo excluye en todas las queries (sin
            // esto, un cruce a 3s del GO sale como "mejor vuelta" en resultados).
            is_warmup: 1,
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
      // Registra el fantasma para correlacionar una futura vuelta 2× (el cruce
      // que otro carril se saltó) y neutralizarla — ver _ghostDerivedDouble.
      if (!this._recentGhosts) this._recentGhosts = [];
      this._recentGhosts.push({ ts: timestamp, lane });
      if (this._recentGhosts.length > 64) this._recentGhosts.shift();
      const elapsedMs = timestamp - circuit.startTime;
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

        // Refleja el cruce reasignado en memoria: cuenta para el total con
        // tiempo = MEDIA ACTUAL del carril (no el tiempo corto del fantasma). Así
        // la media no se mueve (añadir su propia media la deja igual) y la mejor
        // vuelta no se ve afectada (la media nunca es la más rápida).
        if (tld) {
          const assignMs = (tld.lapAvgMs > 0) ? tld.lapAvgMs : lapTimeMs;
          tld.lapCount++;
          tld.lastCrossing = timestamp;
          tld.avgLapCount++;
          tld.lapsMsSum += assignMs;
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

    // 2× DERIVADA DE UN FANTASMA → neutralizar a media. Un cruce mal atribuido
    // deja a un carril "saltándose" una vuelta → aparece una vuelta ~2×
    // (missed-crossing). Si coincide con un fantasma reciente en OTRO carril, NO
    // es un pit real: le ponemos tiempo = media para no falsear media/mejor. Los
    // pits / vueltas lentas REALES (sin fantasma cerca) se respetan tal cual.
    {
      const _refAvg = ld.cleanAvgMs > 0 ? ld.cleanAvgMs : ld.lapAvgMs;
      if (_refAvg > 0 && lapTimeMs >= _refAvg * 1.5 && lapTimeMs <= _refAvg * 2.8 &&
          this._ghostDerivedDouble(lane, timestamp, _refAvg)) {
        console.log(`[TimingService] 2× de fantasma (carril ${lane}): ${lapTimeMs}ms → media ${Math.round(_refAvg)}ms`);
        lapTimeMs = Math.round(_refAvg);
      }
    }

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

    const elapsedMs = timestamp - circuit.startTime;
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
      exitCount: ld.exitCount,
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
      // Ventana de deuda para reasignar un cruce mal atribuido:
      //  · SUELO (>0.2× media): que no sea un carril solo un pelín tarde.
      //  · TECHO (<1.5× media): un cruce mal leído = el carril se saltó UN cruce
      //    (deuda ~1 vuelta). Si la deuda es MUCHO mayor, lleva en silencio
      //    varias vueltas → es un PIT STOP o crash, NO un cruce perdido: no se le
      //    reasigna el fantasma. (La salida ya queda fuera: sin media aún.)
      if (debt > ld.lapAvgMs * 0.2 && debt < ld.lapAvgMs * 1.5 && debt > bestDebt) {
        best = ld.lane;
        bestDebt = debt;
      }
    }
    return best;
  }

  // ¿La vuelta larga (candidata a 2×) deriva de un fantasma reciente? = hubo un
  // fantasma en OTRO carril dentro de la ventana previa (~2.5× la media), señal
  // de un cruce mal atribuido. Poda de paso los fantasmas ya viejos.
  _ghostDerivedDouble(lane, timestamp, refAvg) {
    if (!this._recentGhosts || !this._recentGhosts.length) return false;
    // Poda con ventana FIJA generosa (30s) — no depende del carril, para no
    // descartar fantasmas que aún valen para otros carriles más lentos.
    this._recentGhosts = this._recentGhosts.filter(g => (timestamp - g.ts) <= 30000 && (timestamp - g.ts) >= 0);
    // Match: un fantasma en OTRO carril dentro de la ventana de este carril
    // (~2.5× su media = como mucho el tiempo de la vuelta que se saltó).
    const windowMs = Math.max(3000, refAvg * 2.5);
    return this._recentGhosts.some(g => g.lane !== lane && (timestamp - g.ts) <= windowMs);
  }

  // ── Standings ─────────────────────────────────────────────────────────────

  getStandings() {
    if (!this.session) return null;
    const { laneMap, startTime, manga, race } = this.session;

    const rows = Object.values(laneMap)
      .map(l => ({
        lane: l.lane, color: l.color, name: l.name, country: l.country,
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

    // Media de carrera por ENTIDAD (equipo/piloto): media simple de los tiempos
    // de vuelta combinando todas las mangas anteriores (de la BD) con la manga
    // actual en memoria. Es la definición que usa TicTac (verificado con las
    // tramas crudas del DS-300: AVG(lap_time_ms) sin warmup coincide al ms con
    // la media por pista de TicTac). Las mangas anteriores se agrupan por
    // entidad, NO por carril, porque los carriles rotan cada manga.
    const db = require('../config/database');
    const priorStats = db.prepare(`
      SELECT CASE WHEN team_id IS NOT NULL THEN 't' || team_id ELSE 'd' || driver_id END AS ekey,
             COUNT(*) AS cnt, AVG(lap_time_ms) AS avg_ms
      FROM laps
      WHERE race_id = ? AND manga_id != ?
        AND is_ghost = 0 AND is_warmup = 0 AND lap_number > 0
      GROUP BY ekey
    `).all(race.id, manga.id);
    const priorByEntity = {};
    priorStats.forEach(p => { priorByEntity[p.ekey] = { count: p.cnt, avg: p.avg_ms }; });
    rows.forEach(r => {
      const ld = laneMap[r.lane];
      const ekey = ld?.teamId ? 't' + ld.teamId : (ld?.driverId ? 'd' + ld.driverId : null);
      const prior = ekey ? priorByEntity[ekey] : null;
      const priorCount = prior?.count || 0;
      const priorSum   = prior ? prior.avg * prior.count : 0;
      // avgLapCount (no lapCount): lapsMsSum excluye la warmup, así que el
      // divisor también debe excluirla — la warmup la incluía y rebajaba la media.
      const currCount  = laneMap[r.lane].avgLapCount || 0;
      const currSum    = laneMap[r.lane].lapsMsSum || 0;
      const totalCount = priorCount + currCount;
      r.raceAvgLapMs = totalCount > 0 ? Math.round((priorSum + currSum) / totalCount) : null;
    });

    // Tiempo TOTAL acumulado de carrera por ENTIDAD (equipo/piloto), para el
    // desempate "por coma": a igualdad de vueltas, va delante quien las hizo en
    // menos tiempo. = tiempo en mangas anteriores (por entidad, sobrevive a la
    // rotación de carriles) + suma de la manga actual.
    const priorTimeRows = db.prepare(`
      SELECT CASE WHEN team_id IS NOT NULL THEN 't'||team_id ELSE 'd'||driver_id END AS ekey,
             SUM(lap_time_ms) AS sum_ms
      FROM laps
      WHERE race_id = ? AND manga_id != ? AND is_ghost = 0
      GROUP BY ekey
    `).all(race.id, manga.id);
    const priorTimeByEntity = {};
    priorTimeRows.forEach(p => { priorTimeByEntity[p.ekey] = p.sum_ms || 0; });
    rows.forEach(r => {
      const ld = laneMap[r.lane];
      const ekey = ld?.teamId ? 't' + ld.teamId : (ld?.driverId ? 'd' + ld.driverId : null);
      const priorTime = ekey ? (priorTimeByEntity[ekey] || 0) : 0;
      r.totalTimeMs = priorTime + (ld?.lapsMsSum || 0);
    });

    // ── Proyección de carrera (ÚNICA, para web y app móvil) ───────────────
    // Clasificación estimada por entidad sobre TODA la carrera: vueltas
    // proyectadas, posición, gap al de delante y "P/Subir". Es EXACTAMENTE la
    // función única buildRaceProjection (misma que Le Mans y live-stats), por
    // lo que todos los consumidores comparten cálculo y orden.
    const projection = this.buildRaceProjection(race.id);

    return {
      mangaId:      manga.id,
      raceId:       race.id,
      elapsedMs:    Date.now() - startTime,
      remainingMs:  Math.max(0, this.session.durationMs - (Date.now() - startTime)),
      standings:    rows,
      projection,
      raceBestLaps,
      circuits:     this._circuitClocks(),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PROYECCIÓN ÚNICA DE CARRERA — la ÚNICA fuente de verdad de la proyección
  //  para TODAS las vistas (Le Mans, panel/directo, live-stats, Lap, resultados).
  //
  //  Fórmula (FIJA):
  //    proyección = vueltas_totales + (tiempo_restante_ms ÷ media_ms)
  //      · media_ms          = AVG(lap_time_ms) sin warmup/ghost (= TicTac).
  //      · vueltas_totales    = COUNT vueltas válidas (is_ghost=0, lap_number>0;
  //                             incluye cruce de salida y salidas de pit).
  //      · tiempo_restante_ms = mangas_pendientes × duración_manga
  //                             + (si en pista ahora → restante de la manga actual).
  //  Orden: proyección DESC; desempates total DESC, coma_total DESC, best ASC.
  //  Entidad sin vueltas/sin media → proyección null → al final.
  //
  //  100% BASADO EN BD — NO usa this.session. Deriva el elapsed/remaining de la
  //  manga activa desde mangas.started_at + duración vs Date.now(), por lo que
  //  funciona en Le Mans sin sesión viva y para DS-300 / BART / simulación por
  //  igual. La "manga activa" es la que tiene started_at pero no está 'finished'.
  //
  //  Devuelve array ordenado de:
  //    { entityId, entityType, name, totalLaps, avgLapMs, bestLapMs, comaTotal,
  //      mangasRaced, remainingMs, onTrack,
  //      projectedRaw, projectedTotal, gapV, gapVLeader, avgToCatch, position }
  // ════════════════════════════════════════════════════════════════════════
  buildRaceProjection(raceId) {
    const db  = require('../config/database');
    const Lap = require('../models/Lap');

    const race = db.prepare('SELECT id, format, manga_duration_minutes FROM races WHERE id = ?').get(raceId);
    if (!race) return [];
    const isTeam = race.format === 'team';
    const idCol  = isTeam ? 'ml.team_id' : 'ml.driver_id';

    const durDefaultMs = (race.manga_duration_minutes || 0) * 60000;

    // ── Manga ACTIVA (en curso): started_at fijado y aún no 'finished'.
    // Su duración real (actual_duration_ms) y su transcurrido/restante se
    // derivan del reloj, NO de la sesión en memoria.
    const activeManga = db.prepare(`
      SELECT id, started_at, actual_duration_ms
      FROM mangas
      WHERE race_id = ? AND status != 'finished' AND started_at IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(raceId);

    let activeMangaId = null, activeRemMs = 0;
    if (activeManga) {
      activeMangaId = activeManga.id;
      const durMs = activeManga.actual_duration_ms > 0 ? activeManga.actual_duration_ms : durDefaultMs;
      const startedMs = activeManga.started_at
        ? (Date.parse(activeManga.started_at + 'Z') || Date.parse(activeManga.started_at))
        : null;
      const elapsed = startedMs != null ? (Date.now() - startedMs) : 0;
      activeRemMs = Math.max(0, durMs - elapsed);
    }

    // ── Mangas PENDIENTES (aún por correr) por entidad. Excluye la activa: su
    // tiempo restante ya lo aporta activeRemMs para los que están en pista.
    const pendRows = db.prepare(`
      SELECT ${idCol} AS eid, COUNT(*) AS pending
      FROM manga_lanes ml JOIN mangas m ON m.id = ml.manga_id
      WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
        AND m.status = 'pending' AND m.started_at IS NULL
      GROUP BY eid
    `).all(raceId);
    const pendingById = {};
    pendRows.forEach(r => { pendingById[r.eid] = r.pending || 0; });

    // ── Entidades EN PISTA ahora (asignadas a la manga activa, no descanso).
    const onTrackSet = new Set();
    if (activeMangaId) {
      db.prepare(`
        SELECT ${idCol} AS eid FROM manga_lanes ml
        WHERE ml.manga_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      `).all(activeMangaId).forEach(r => onTrackSet.add(r.eid));
    }

    // ── Duración de manga para las PENDIENTES futuras: la real de cada manga
    // futura si estuviera guardada; como aún no han corrido, usamos el default
    // de la carrera (mismo criterio que el resto de vistas).
    const futureMangaDurMs = durDefaultMs;

    // ── Agregado por entidad (media simple, total, coma, best) desde BD.
    const agg = Lap.aggregateByRace(raceId).filter(p => p.entity_id != null);

    // Incluir TAMBIÉN las entidades asignadas a la carrera que aún no tienen
    // vueltas (tandas/mangas por empezar): deben salir en la clasificación con
    // proyección null (al final), igual que en el panel y en Le Mans.
    const nameJoin = isTeam ? 'teams e ON e.id = ml.team_id' : 'drivers e ON e.id = ml.driver_id';
    const assigned = db.prepare(`
      SELECT ${idCol} AS eid, e.name AS name
      FROM manga_lanes ml JOIN mangas m ON m.id = ml.manga_id
      JOIN ${nameJoin}
      WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      GROUP BY eid
    `).all(raceId);
    const haveAgg = new Set(agg.map(p => p.entity_id));
    assigned.forEach(a => {
      if (haveAgg.has(a.eid)) return;
      agg.push({
        entity_id: a.eid, entity_name: a.name,
        entity_type: isTeam ? 'team' : 'driver',
        total_laps: 0, avg_lap_ms: null, best_lap_ms: null,
        coma_total: 0, mangas_raced: 0,
      });
    });

    const proj = agg.map(p => {
      const onTrack = onTrackSet.has(p.entity_id);
      const futureRemMs = (pendingById[p.entity_id] || 0) * futureMangaDurMs;
      const remMs = (onTrack ? activeRemMs : 0) + futureRemMs;
      const avg   = p.avg_lap_ms;
      // Proyección MEDIA-BASED: total + tiempo_restante / media.
      const projRaw = (avg != null && avg > 0)
        ? p.total_laps + remMs / avg
        : null;
      return {
        entityId:    p.entity_id,
        entityType:  p.entity_type,
        name:        p.entity_name,
        totalLaps:   p.total_laps,
        avgLapMs:    avg != null ? Math.round(avg) : null,
        bestLapMs:   p.best_lap_ms,
        comaTotal:   p.coma_total || 0,
        mangasRaced: p.mangas_raced || 0,
        remainingMs: remMs,
        futureRemMs,
        onTrack,
        projectedRaw: projRaw,
      };
    });

    // Orden: proyección DESC; desempates total DESC, coma DESC, best ASC.
    // Entidades sin proyección (null) al final.
    proj.sort((a, b) => {
      if (a.projectedRaw == null && b.projectedRaw == null) return (a.name || '').localeCompare(b.name || '');
      if (a.projectedRaw == null) return 1;
      if (b.projectedRaw == null) return -1;
      return (b.projectedRaw - a.projectedRaw)
          || (b.totalLaps - a.totalLaps)
          || (b.comaTotal - a.comaTotal)
          || ((a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));
    });

    const leaderRaw = proj.length ? proj[0].projectedRaw : null;
    return proj.map((r, i) => {
      const ahead    = proj[i - 1];
      const aheadRaw = ahead ? ahead.projectedRaw : null;
      const gapV     = (i === 0 || aheadRaw == null || r.projectedRaw == null) ? null : (aheadRaw - r.projectedRaw);
      const gapVLead = (i === 0 || leaderRaw == null || r.projectedRaw == null) ? null : (leaderRaw - r.projectedRaw);
      // "P/Subir": media ms/vuelta que necesita en lo que le queda para alcanzar
      // la proyección del de delante. null = líder / sin tiempo / inalcanzable.
      let avgToCatch = null;
      // Solo tiene sentido para quien YA está corriendo (tiene vueltas): a un
      // piloto con 0 vueltas (aún no ha corrido / corre en otra tanda) no se le
      // da un "ritmo para subir".
      if (r.totalLaps > 0 && !(i === 0 || aheadRaw == null || !(r.remainingMs > 0))) {
        const lapsNeeded = aheadRaw - r.totalLaps;
        const req = lapsNeeded > 0 ? r.remainingMs / lapsNeeded : null;
        if (req != null && req > 0 && (!r.bestLapMs || req >= r.bestLapMs)) avgToCatch = Math.round(req);
      }
      return {
        position:       i + 1,
        entityId:       r.entityId,
        entityType:     r.entityType,
        name:           r.name,
        totalLaps:      r.totalLaps,
        total:          r.totalLaps,   // alias legacy (live.js, Lap, live-stats)
        avgLapMs:       r.avgLapMs,
        bestLapMs:      r.bestLapMs,
        comaTotal:      +r.comaTotal.toFixed ? +r.comaTotal.toFixed(3) : r.comaTotal,
        mangasRaced:    r.mangasRaced,
        remainingMs:    r.remainingMs,
        futureRemMs:    r.futureRemMs,
        onTrack:        r.onTrack,
        projectedRaw:   r.projectedRaw,
        projectedTotal: r.projectedRaw != null ? +r.projectedRaw.toFixed(1) : null,
        gapV:           gapV     != null ? +gapV.toFixed(2)     : null,
        gapVLeader:     gapVLead != null ? +gapVLead.toFixed(2) : null,
        avgToCatch,
      };
    });
  }

  // Compat: la proyección que consume getStandations().projection (app móvil,
  // live-stats). Ahora es un fino adaptador sobre la función única para que
  // TODOS los consumidores compartan exactamente el mismo cálculo y orden.
  _buildProjection(race /* , laneMap, startTime */) {
    return this.buildRaceProjection(race.id).map(r => ({
      position:       r.position,
      entityId:       r.entityId,
      entityType:     r.entityType,
      name:           r.name,
      total:          r.totalLaps,
      projectedTotal: r.projectedTotal,
      gapV:           r.gapV,
      avgToCatch:     r.avgToCatch,
      avgLapMs:       r.avgLapMs,
    }));
  }

  // Derivados del estado por circuito: la manga "corre" si algún circuito corre;
  // está "en pausa" si ninguno corre pero alguno está pausado.
  get isRunning()     { return !!this.session && Object.values(this.session.circuits).some(c => c.status === 'running'); }
  get isPaused()      { return !!this.session && !this.isRunning && Object.values(this.session.circuits).some(c => c.status === 'paused'); }
  // True si hay una manga armada esperando el GO del DS-300, o una manga
  // en curso. Útil para que TrainingService no enganche cruces durante una
  // carrera oficial, ya que el listener de race_started del training puede
  // dispararse antes que el de TimingService.startManga.
  get isBusy()        { return this.isRunning || this.isPaused || this._pendingSetup != null || this._tandaBoundary === true; }
  get activeMangaId() { return this.session?.manga?.id ?? null; }
  get activeRaceId()  { return this.session?.race?.id ?? null; }

  // Ms restantes hasta el final de la manga. Devuelve null si no hay sesión.
  // Durante pausa, el tiempo no avanza, pero remaining es relativo a la
  // duración original menos lo elapsed antes de la pausa.
  getRemainingMs() {
    if (!this.session) return null;
    // Si la manga está totalmente pausada, el tiempo no avanza desde pauseStart.
    const ref = (this.isPaused && this.session.pauseStart) ? this.session.pauseStart : Date.now();
    return Math.max(0, this.session.durationMs - (ref - this.session.startTime));
  }

  // ── Driver shifts (solo carreras de campeonato) ─────────────────────

  // Incremento por tick (1s) de cada shift activo. Persiste cada 5s.
  // Emite snapshot por socket para que la vista de control refresque
  // cronómetros sin estimación en cliente.
  _tickDriverShifts() {
    for (const lane in this._activeShiftsByLane) {
      // No sumar tiempo a un piloto cuyo circuito esté pausado.
      const ci = this.session && this.session.laneToCircuit ? this.session.laneToCircuit[lane] : null;
      if (ci != null && this.session.circuits[ci] && this.session.circuits[ci].status !== 'running') continue;
      this._activeShiftsByLane[lane].drivingMs += 1000;
    }
    this._driverShiftTickN++;
    if (this._driverShiftTickN >= 5) {
      this._persistAllDriverShifts();
      this._driverShiftTickN = 0;
    }
    SocketService.emit('shifts:tick', {
      mangaId: this.session?.manga?.id,
      raceId:  this.session?.race?.id,
      active:  this._activeShiftsByLane,
    });
  }

  // UPDATE de driving_ms en BD para cada shift abierto.
  _persistAllDriverShifts() {
    for (const lane in this._activeShiftsByLane) {
      const s = this._activeShiftsByLane[lane];
      try { DriverShift.updateDrivingMs(s.shiftId, s.drivingMs); }
      catch (e) { console.error('[TimingService] persist driver shift error', e.message); }
    }
  }

  // Cambia el piloto de un carril en runtime. Si había un shift abierto, lo
  // cierra con su driving_ms acumulado y luego registra el nuevo. Si la
  // manga está en pausa, el nuevo shift se crea pero el contador no avanza
  // hasta el resume. Llamado por SessionController.driverCheckin cuando la
  // manga ya está corriendo (no para pre-arme).
  swapDriverOnLane({ lane, raceId, mangaId, teamId, driverId, driverName }) {
    if (!this.session || this.session.manga.id !== mangaId) return null;
    if (!this._isChampionship) return null;

    const now = Date.now();
    // Cerrar shift previo si existe
    const prev = this._activeShiftsByLane[lane];
    if (prev) {
      try { DriverShift.closeShift(prev.shiftId, now, prev.drivingMs); }
      catch (e) { console.error('[TimingService] closeShift', e.message); }
    }

    // Abrir nuevo
    const newId = DriverShift.openShift({
      mangaId, raceId, lane, teamId, driverId, driverName,
      startedAtMs: now, preArmed: false,
    });
    this._activeShiftsByLane[lane] = { shiftId: newId, drivingMs: 0 };
    return newId;
  }

  // Devuelve el snapshot de shifts activos (lane → { shiftId, drivingMs }).
  // El driving_ms es el valor in-memory ya tickeado, no el de BD.
  getActiveShifts() {
    return { ...this._activeShiftsByLane };
  }
}

module.exports = new TimingServiceClass();
