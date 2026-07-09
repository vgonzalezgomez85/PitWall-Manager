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
    this._priorCache     = null; // agregados de mangas anteriores (ver _priorAggregates)
    this._projCache      = null; // proyección de carrera con TTL (ver _cachedProjection)
  }

  // Cada cuánto se recalcula la proyección en el camino caliente. Es una
  // estimación a horas vista; 1 s de frescura sobra y ahorra 100 ms por cruce.
  static get PROJECTION_TTL_MS() { return 1000; }

  /**
   * El contador de vueltas del DS-300 (byte12) es BCD de un byte: cuenta
   * MÓDULO 100. `registered` son las vueltas ya persistidas de ese carril.
   *
   * Devuelve el contador ABSOLUTO del DS: el múltiplo de 100 más cercano a
   * `registered` que sea congruente con `dsCount`. Con ±50 de margen, porque un
   * carril no puede desfasarse medio centenar de vueltas al caer la bandera.
   *
   *   dsCount=30, registered=129  → 130  (el DS lleva una más: la de bandera)
   *   dsCount=0,  registered=199  → 200
   *   dsCount=99, registered=100  →  99  (la BD va por delante: no se repone)
   */
  static absoluteDsCount(dsCount, registered) {
    const CICLO = 100;
    let abs = Math.floor(registered / CICLO) * CICLO + (dsCount % CICLO);
    while (abs < registered - CICLO / 2) abs += CICLO;
    while (abs > registered + CICLO / 2) abs -= CICLO;
    // Un contador absoluto negativo no significa nada. Pasa solo con muy pocas
    // vueltas registradas y un byte12 disparatado (reg=0, ds=99): ahí volvemos al
    // valor crudo y deja que la salvaguarda de "desfase grande" lo cape.
    if (abs < 0) abs += CICLO;
    return abs;
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
        resumeWarmup:  false,  // 1ª vuelta tras un resume: fuera de VR y de la media
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
    this.invalidateStandingsCaches();   // manga nueva: las mangas 'anteriores' cambian
    if (this._isChampionship) {
      // Activa los pre-armes del circuito que ACABA de recibir su GO: les setea
      // started_at_ms = startTime y pre_armed = 0. Los de las demás cajas se
      // activan con su propio GO (startCircuit). Con 3 cajas el GO es escalonado:
      // sellarles a todos este startTime les pondría una hora de entrada falsa
      // en la cronología del informe (el tiempo sí era correcto: se deriva del
      // reloj de SU circuito, que hasta su GO está en pending y no avanza).
      DriverShift.activatePreArmedShifts(manga.id, startTime, this._circuitLanes(startCircuitIndex));
      // Carga el mapa en memoria de los shifts abiertos: los recién activados,
      // los pre-armados de los circuitos que aún esperan su GO (cuentan 0 hasta
      // entonces) y cualquiera que quedase colgando de una caída.
      DriverShift.findAllOpenByManga(manga.id).forEach(s => {
        this._openShiftEntry(s.lane, s.id, s.driving_ms || 0);
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
        endTime: null,           // lo fija finishCircuit(); congela el reloj del circuito
        durationMs,
        autoStopTimer: null,
        laneCount: n,
      };
      off += n;
    });
    // Salvaguarda: si el circuito de arranque no aparece en la config, créalo.
    if (!circuits[startCi]) {
      circuits[startCi] = { index: startCi, status: 'running', startTime, endTime: null, durationMs, autoStopTimer: null, laneCount: 0 };
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

  // Tiempo EFECTIVO transcurrido de un circuito desde su GO, ya descontadas sus
  // pausas. La resta sale gratis porque `resumeCircuit` desplaza `startTime` por
  // la duración de cada pausa: `startTime` no es el instante del GO, es el ancla
  // móvil del tiempo efectivo. Devuelve null si el circuito no existe.
  //
  // Es la base del contador de turnos: driving_ms se deriva de aquí en vez de
  // acumular ticks, así que no arrastra la deriva del setInterval (medidos ~1032
  // ppm en este banco → ~89 s por piloto en 24 h, y siempre a la baja).
  _circuitElapsedMs(ci) {
    const c = this.session && this.session.circuits[ci];
    if (!c) return null;
    if (c.status === 'pending')  return 0;   // GO escalonado: su caja aún no ha arrancado
    if (c.status === 'finished') return Math.max(0, (c.endTime   || Date.now()) - c.startTime);
    if (c.status === 'paused')   return Math.max(0, (c.pauseStart || Date.now()) - c.startTime);
    return Math.max(0, Date.now() - c.startTime);   // running
  }

  // Reloj de cada circuito para la UI: tiempo restante propio según su estado.
  _circuitClocks() {
    if (!this.session) return [];
    return Object.values(this.session.circuits)
      .sort((a, b) => a.index - b.index)
      .map(c => {
        let remainingMs;
        if (c.status === 'pending')       remainingMs = c.durationMs;
        else if (c.status === 'finished') remainingMs = 0;
        else                              remainingMs = Math.max(0, c.durationMs - this._circuitElapsedMs(c.index));
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
    c.endTime   = null;   // por si el circuito se relanza tras un stop forzado
    if (durationMs) c.durationMs = durationMs;

    // Los pilotos de ESTA caja entran ahora, no cuando arrancó la primera: su
    // hora de entrada es su propio GO. El contador ya era correcto (deriva del
    // reloj del circuito, en pending congelado a 0); esto arregla la cronología.
    if (this._isChampionship && this.session.manga) {
      DriverShift.activatePreArmedShifts(this.session.manga.id, c.startTime, this._circuitLanes(ci));
    }

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
    c.endTime = Date.now();   // ANTES del cambio de estado: _circuitElapsedMs ya lo lee
    c.status  = 'finished';
    this.invalidateStandingsCaches();   // el circuito ya no aporta tiempo restante
    if (c.autoStopTimer) { clearTimeout(c.autoStopTimer); c.autoStopTimer = null; }
    console.log(`[TimingService] Circuito ${ci + 1} finalizado`);

    // Los turnos de ESTE circuito se cierran en SU instante de fin. Con tres
    // cajas, esperar a stopManga() les colgaría el ended_at_ms de la última en
    // terminar. El tiempo ya no crece (elapsed queda congelado en endTime), pero
    // la cronología del informe sí quedaría falseada.
    if (this._isChampionship) this._closeDriverShiftsForCircuit(ci);

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

    // Cierra los shifts abiertos que queden. Cada uno con el tiempo calculado y
    // el instante de fin de SU circuito: los de un circuito que ya terminó se
    // cerraron en finishCircuit(), aquí caen los de un stop manual o los de
    // circuitos que nunca llegaron a finalizar. closeAllOpenForManga queda de
    // red de seguridad para huérfanos que no estén en el mapa (p.ej. tras una
    // caída). Solo aplica a campeonato.
    if (this._isChampionship) {
      const nowTs = Date.now();
      for (const lane of Object.keys(this._activeShiftsByLane)) {
        const e = this._activeShiftsByLane[lane];
        const c = this.session.circuits[e.ci];
        try { DriverShift.closeShift(e.shiftId, (c && c.endTime) || nowTs, this._drivingMsOf(e)); }
        catch (err) { console.error('[TimingService] closeShift', err.message); }
      }
      DriverShift.closeAllOpenForManga(this.session.manga.id, nowTs);
      this._activeShiftsByLane = {};
    }

    let nextMangaId  = null;
    let nextLanes    = {};   // { currentLane → nextLane }
    let isTandaEnd   = false;
    let nextTandaId  = null;
    let nextTandaNumber = null;
    let reconcileData = null;   // snapshot para la reconciliación del cruce "en la bandera"

    // Todo lo que sigue toca la BD. Si algo lanza (disco lleno hacia la hora 20,
    // SQLITE_BUSY, IOERR), la excepción subía al handler global y `this.session`
    // se quedaba sin vaciar: la manga acababa 'finished' en BD pero con sesión
    // viva, el tick parado y el handler de cruces ya desenganchado. Peor: como
    // `activeMangaId` seguía puesto, el siguiente GO del DS entraba por la rama
    // de "arrancar circuito" y arrastraba el zombi a la manga siguiente.
    // El `finally` garantiza que la sesión se cierra pase lo que pase.
    try {

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
        // Fin REAL de SU circuito. Con varias cajas una puede terminar antes que
        // las otras: usar el fin nominal (arranque + duración) o `nowTs` —que es
        // cuando terminó la ÚLTIMA— le regalaba a esos carriles el tiempo que su
        // caja ya llevaba parada, y su coma se saturaba a 0.99. En un empate a
        // vueltas eso decide posiciones.
        const finNominal = c ? c.startTime + (c.durationMs || this.session.durationMs) : nowTs;
        const endTs = c ? Math.min(nowTs, c.endTime || finNominal) : nowTs;
        const refAvg = ld.cleanAvgMs > 0 ? ld.cleanAvgMs : ld.lapAvgMs;
        let coma = 0;
        if (ld.lapCount > 0 && refAvg > 0 && ld.lastCrossing) {
          coma = Math.min(0.99, Math.max(0, (endTs - ld.lastCrossing) / refAvg));
        }
        try {
          comaStmt.run(+coma.toFixed(3), this.session.manga.id, ld.lane);
        } catch (err) { console.error('[TimingService] persist coma error:', err.message); }
      }

      // ── Snapshot para la reconciliación del cruce "en la bandera" ──────────
      // El frame de FIN de manga (0xA4) se procesa µs ANTES que el frame del
      // último cruce; ese cruce llega con el circuito ya 'finished' y se
      // descarta (reason 'circuit_not_running') → se pierde 1 vuelta que el DS
      // SÍ contó (byte12). Guardamos aquí lo necesario para, ~1.5 s después,
      // comparar byte12 con lo persistido y reponer la(s) vuelta(s) que falten.
      // Solo aplica al DS-300 REAL (no simulación ni BART).
      const simNow = SerialService.getLinkStatus().simulating;
      if (!simNow && !SerialService.isBart) {
        reconcileData = {
          mangaId: this.session.manga.id,
          raceId:  this.session.race.id,
          lanes: Object.values(this.session.laneMap).map(ld => {
            const ci = this.session.laneToCircuit[ld.lane];
            const c  = ci != null ? this.session.circuits[ci] : null;
            return {
              lane:             ld.lane,
              teamId:           ld.teamId,
              driverId:         ld.driverId,
              refAvgMs:         ld.cleanAvgMs > 0 ? ld.cleanAvgMs : ld.lapAvgMs,
              lastCrossing:     ld.lastCrossing,
              circuitStartTime: c ? c.startTime : null,
            };
          }),
        };
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

    } catch (err) {
      // La manga ya está cerrada en lo que importa (hardware parado, timers
      // fuera, handler desenganchado). Que falle la BD no puede dejar el motor
      // en un estado del que no se pueda arrancar la manga siguiente.
      console.error('[TimingService] Error cerrando la manga:', err.message);
      DebugLogger.log('manga', { event: 'stop_error', error: err.message });
    } finally {
      this.invalidateStandingsCaches();
      // OJO: aquí NO se toca `_pendingSetup`. El bloque de arriba lo arma con la
      // manga SIGUIENTE para que el próximo GO del DS la encadene solo; borrarlo
      // rompería la cadena de mangas de toda la carrera.
      this.session = null;
      this._activeShiftsByLane = {};
    }

    // Reconciliación diferida del cruce "en la bandera": esperamos ~1.5 s a que
    // el frame del último cruce actualice byte12 en SerialService y entonces
    // reponemos en BD la(s) vuelta(s) que la caja contó pero que se descartaron
    // por llegar con el circuito ya 'finished'. Se hace tras cerrar/persistir la
    // manga y con la sesión ya vaciada (trabaja 100% sobre BD).
    if (reconcileData) {
      setTimeout(() => {
        try { this._reconcileFinalLaps(reconcileData); }
        catch (err) { console.error('[TimingService] reconcile error:', err.message); }
      }, 1500);
    }
  }

  // ── Reconciliación del cruce "en la bandera" (DS-300 real) ──────────────────
  // Compara el contador de vueltas del DS (byte12) por carril con las vueltas
  // realmente persistidas de la manga y repone las que falten (típicamente 1: el
  // cruce que completó justo al caer la bandera). Cuadra EXACTO con el DS, sin
  // heurística de tiempo.
  _reconcileFinalLaps(data) {
    this.invalidateStandingsCaches();   // repone vueltas de una manga ya cerrada
    // Si ya arrancó otra manga, su GO (0xA1) habrá limpiado byte12 → abortar
    // para no reponer con contadores de la manga nueva.
    if (this.session) {
      console.log('[TimingService] Reconciliación abortada — ya hay otra manga activa');
      return;
    }
    // Solo DS-300 real (la simulación/BART no lo usan).
    if (SerialService.getLinkStatus().simulating || SerialService.isBart) return;

    const counters = SerialService.getDsLapCounters();   // { globalLane: byte12 }
    if (!counters || Object.keys(counters).length === 0) return;

    const db = require('../config/database');
    const countStmt = db.prepare(
      `SELECT COUNT(*) AS n, MAX(lap_number) AS maxNum
         FROM laps
        WHERE manga_id = ? AND lane = ? AND is_ghost = 0 AND lap_number > 0`
    );

    let inserted = 0;
    for (const ld of data.lanes) {
      const dsCount = counters[ld.lane];
      if (dsCount == null) continue;                 // el DS no reportó este carril
      const row = countStmt.get(data.mangaId, ld.lane);
      const registered = row?.n || 0;
      // byte12 es BCD de un byte: cuenta vueltas MÓDULO 100. Comparar el crudo
      // con las vueltas persistidas daba negativo en cuanto un carril pasaba de
      // 100 vueltas (130 → byte12=30 → 30-129 = -99 → `continue`), así que la
      // recuperación de la vuelta de bandera quedaba desactivada justo para los
      // coches que más vueltas dan. Reconstruimos el contador absoluto.
      let missing = TimingServiceClass.absoluteDsCount(dsCount, registered) - registered;
      if (missing <= 0) continue;                    // ya cuadra (o BD por delante)
      // Salvaguarda contra un byte12 anómalo: al cierre cada carril puede
      // completar como mucho ~1 vuelta extra (la de la bandera). Un desfase
      // grande sería un problema de sincronía previo, no un cruce en meta:
      // capamos para no inyectar vueltas fantasma en masa.
      if (missing > 3) {
        console.warn(`[TimingService] Reconciliación carril ${ld.lane}: desfase grande DS=${dsCount} BD=${registered} → capado a 3`);
        missing = 3;
      }
      const refAvg = ld.refAvgMs > 0 ? Math.round(ld.refAvgMs) : null;
      if (!refAvg) continue;                         // sin media no estimamos el tiempo
      let lapNum  = row?.maxNum || 0;
      // elapsed del último cruce conocido (relativo al GO del circuito) + media.
      let elapsed = (ld.circuitStartTime != null && ld.lastCrossing != null)
        ? Math.max(0, ld.lastCrossing - ld.circuitStartTime)
        : 0;
      for (let k = 0; k < missing; k++) {
        lapNum  += 1;
        elapsed += refAvg;
        try {
          Lap.create({
            race_id: data.raceId, manga_id: data.mangaId,
            team_id: ld.teamId, driver_id: ld.driverId,
            lane: ld.lane, lap_number: lapNum,
            lap_time_ms: refAvg, elapsed_ms: elapsed,
            is_exit: 0, is_ghost: 0, is_warmup: 0,
          });
          inserted++;
        } catch (err) { console.error('[TimingService] reconcile insert error:', err.message); }
      }
      console.log(`[TimingService] Reconciliación bandera: carril ${ld.lane} DS=${dsCount} BD=${registered} → +${missing} vuelta(s) @ ${refAvg}ms`);
    }

    if (inserted > 0) {
      DebugLogger.log('manga', { event: 'reconcile', mangaId: data.mangaId, insertedLaps: inserted });
      // Reflejar en resultados/estadísticas ya persistidos: reemitimos el
      // snapshot de stats (mismo canal que el cierre de tanda) — 100% desde BD,
      // sin depender de la sesión (ya vaciada).
      try {
        const MobileController = require('../controllers/MobileController');
        const snapshot = MobileController.buildStatsSnapshot(data.raceId);
        if (snapshot) SocketService.emit('race:stats-snapshot', snapshot);
      } catch (err) { console.error('[TimingService] reconcile snapshot failed:', err.message); }
      // Señal ligera para vistas abiertas (resultados/live-stats) por si quieren
      // refrescar; no colisiona con el handler frágil de 'standings'.
      SocketService.emit('manga:reconciled', {
        raceId: data.raceId, mangaId: data.mangaId, insertedLaps: inserted,
      });
      console.log(`[TimingService] Reconciliación completada: +${inserted} vuelta(s) repuesta(s) en manga ${data.mangaId}`);
    }
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
    // La 1ª vuelta tras el resume arranca desde parado + semáforo → su tiempo es
    // un artefacto: se marca warmup para NO contar como vuelta rápida (VR) ni en
    // la media (sí cuenta para el total). Aplica a cualquier fuente (DS/BART/sim).
    for (const ld of Object.values(this.session.laneMap)) {
      if (this.session.laneToCircuit[ld.lane] === ci) ld.resumeWarmup = true;
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

  /**
   * STOP forzado de una manga por su id, tenga o no sesión viva.
   *
   * Si el servidor se reinicia con una manga corriendo, la manga se queda
   * `active` en BD pero la sesión (que vive en memoria) se pierde. El STOP tiene
   * que dejarla igual que un stop forzado normal: vueltas fuera, manga a
   * `pending`, tiempo de ESA manga descartado y los pilotos conservados en su
   * carril, pre-armados. Antes esta rama borraba las vueltas y se olvidaba de los
   * turnos: el piloto se quedaba con el tiempo de una manga anulada y con el
   * turno abierto, sin poder volver a fichar.
   *
   * `force` incluye también las mangas ya terminadas (lo usa el reset de
   * diagnóstico); sin él solo se toca una manga `active`.
   *
   * @returns {'session'|'stale'|'noop'} qué camino se tomó.
   */
  cancelMangaById(mangaId, race = null, { force = false } = {}) {
    if (this.activeMangaId === mangaId) { this.cancelManga(); return 'session'; }

    const manga = Manga.findById(mangaId);
    if (!manga) return 'noop';
    if (manga.status === 'pending') return 'noop';          // nada que cancelar
    if (manga.status !== 'active' && !force) return 'noop';  // terminada: solo con force

    // Manga huérfana: la sesión murió con el proceso.
    Lap.deleteByManga(mangaId);
    Manga.updateStatus(mangaId, 'pending');

    const r = race || (manga.race_id ? require('../models/Race').findById(manga.race_id) : null);
    if (r && r.type === 'championship') DriverShift.resetForRestart(mangaId);

    console.log(`[TimingService] Manga ${mangaId} sin sesión (${manga.status}) → cancelada y devuelta a pending`);
    return 'stale';
  }

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

    // Igual que en stopManga: si la BD falla a mitad, la sesión no puede quedar
    // viva con el motor ya desmontado. Ver el comentario de allí.
    try {

    // Delete all laps recorded in this session and reset manga to pending
    Lap.deleteByManga(mangaId);
    Manga.updateStatus(mangaId, 'pending');
    // STOP FORZADO: se descarta el tiempo acumulado EN ESTA MANGA (el total de
    // las mangas anteriores no se toca, porque los turnos son por manga) pero se
    // CONSERVA qué piloto está en cada carril, de nuevo pre-armado: no hay que
    // re-escanear los QR, volverán a contar con el próximo GO. Solo campeonato.
    if (this._isChampionship) {
      DriverShift.resetForRestart(mangaId);
      this._activeShiftsByLane = {};
    }

    // Re-register as pending setup so DS-300 GO can restart it immediately
    const { manga, race, lanes, teams, drivers } = this.session;
    this._pendingSetup = { manga: { ...manga, status: 'pending' }, race, lanes, teams, drivers };

    DebugLogger.log('manga', { event: 'cancel', mangaNumber: this.session.manga.number, mangaId, raceId });
    DebugLogger.endMangaLog();
    SocketService.emit('manga:cancelled', { mangaId, raceId });
    console.log(`[TimingService] Manga ${this.session.manga.number} cancelled — reset to pending`);

    } catch (err) {
      console.error('[TimingService] Error cancelando la manga:', err.message);
      DebugLogger.log('manga', { event: 'cancel_error', mangaId, error: err.message });
    } finally {
      this.invalidateStandingsCaches();
      this.session = null;
      this._activeShiftsByLane = {};
    }
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
    // warmup = vuelta de salida (1ª de la manga) O 1ª vuelta tras un resume: en
    // ambos casos el tiempo es un artefacto (arranque desde parado) → fuera de VR
    // y de la media. Se persiste is_warmup=1; sigue contando para el total.
    const isWarmup = !ld.firstRealLapDone || ld.resumeWarmup;
    ld.firstRealLapDone = true;
    ld.resumeWarmup = false;
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
    // Agregados de las mangas ANTERIORES. Cacheados: no cambian mientras corre
    // esta manga, y en una 24 h son 153.000 filas (74 ms en cada cruce).
    const { priorByEntity, priorTimeByEntity } = this._priorAggregates(race.id, manga.id);
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
    //
    // Cacheada con TTL corto: cuesta 100 ms sobre las 160.000 vueltas de una 24 h
    // y llega ~1 cruce cada 0,8 s con 24 carriles. Es una ESTIMACIÓN a horas
    // vista; que se refresque cada segundo en vez de en cada cruce no cambia
    // nada de lo que ve el usuario, y libera el bucle para el serie y el tick.
    const projection = this._cachedProjection(race.id);

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

  // ── Cachés del camino caliente ────────────────────────────────────────────
  //
  // `getStandings()` se ejecuta en CADA cruce. Medido sobre las 160.000 vueltas
  // reales de la 24h de Modena, con 153.000 de mangas anteriores:
  //     media y tiempo por entidad ..... 74 ms
  //     proyección de carrera .......... 100 ms
  // Con 24 carriles llega ~1 cruce cada 0,8 s: el proceso pasaba >20 % del tiempo
  // bloqueado en SELECTs síncronos, y el bloqueo retrasa el tick de 1 s y el
  // procesado de tramas serie. Y empeora con cada hora de carrera.

  /**
   * Media y tiempo total por entidad de las mangas ANTERIORES a `mangaId`.
   *
   * No cambian mientras corre la manga: solo se insertan vueltas de la manga en
   * curso. La caché se invalida sola si alguien toca las vueltas de otra manga
   * (una corrección, una reconstrucción de tanda), gracias al contador de
   * mutaciones del modelo Lap — no depende de que nadie se acuerde de invalidar.
   */
  _priorAggregates(raceId, mangaId) {
    const Lap = require('../models/Lap');
    const mut = Lap.mutationsOutside(mangaId);
    const c = this._priorCache;
    if (c && c.raceId === raceId && c.mangaId === mangaId && c.mut === mut) return c;

    const db = require('../config/database');
    const priorByEntity = {};
    db.prepare(`
      SELECT CASE WHEN team_id IS NOT NULL THEN 't' || team_id ELSE 'd' || driver_id END AS ekey,
             COUNT(*) AS cnt, AVG(lap_time_ms) AS avg_ms
      FROM laps
      WHERE race_id = ? AND manga_id != ?
        AND is_ghost = 0 AND is_warmup = 0 AND lap_number > 0
      GROUP BY ekey
    `).all(raceId, mangaId).forEach(p => { priorByEntity[p.ekey] = { count: p.cnt, avg: p.avg_ms }; });

    const priorTimeByEntity = {};
    db.prepare(`
      SELECT CASE WHEN team_id IS NOT NULL THEN 't'||team_id ELSE 'd'||driver_id END AS ekey,
             SUM(lap_time_ms) AS sum_ms
      FROM laps
      WHERE race_id = ? AND manga_id != ? AND is_ghost = 0
      GROUP BY ekey
    `).all(raceId, mangaId).forEach(p => { priorTimeByEntity[p.ekey] = p.sum_ms || 0; });

    // Sumas crudas por entidad de las mangas anteriores, para la proyección: es
    // el escaneo caro (153.000 filas de 160.000 en una 24 h) que hacía que
    // buildRaceProjection costara 100 ms en cada cruce.
    const priorAggRaw = Lap._aggRaw(raceId, { excludeManga: mangaId });

    this._priorCache = { raceId, mangaId, mut, priorByEntity, priorTimeByEntity, priorAggRaw };
    return this._priorCache;
  }

  /**
   * Proyección de carrera con TTL corto. Es una ESTIMACIÓN a horas vista: que se
   * refresque cada `PROJECTION_TTL_MS` en vez de en cada cruce no cambia nada de
   * lo que ve el usuario. Las transiciones de manga la invalidan de inmediato,
   * para que nadie vea una proyección de la manga anterior.
   */
  _cachedProjection(raceId) {
    const c = this._projCache;
    const now = Date.now();
    if (c && c.raceId === raceId && (now - c.ts) < TimingServiceClass.PROJECTION_TTL_MS) return c.value;
    const value = this.buildRaceProjection(raceId);
    this._projCache = { raceId, ts: now, value };
    return value;
  }

  /** Tira las cachés del camino caliente. Las transiciones de manga la llaman. */
  invalidateStandingsCaches() {
    this._priorCache = null;
    this._projCache  = null;
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
    // Con una manga en curso, las mangas ya cerradas se reutilizan de la caché y
    // solo se agrega la manga viva: 100 ms → ~4 ms. Da EXACTAMENTE el mismo
    // resultado (comprobado entidad a entidad sobre las 22 mangas de Modena).
    const agg = (activeMangaId
      ? Lap.aggregateByRaceSplit(raceId, activeMangaId, this._priorAggregates(raceId, activeMangaId).priorAggRaw)
      : Lap.aggregateByRace(raceId)
    ).filter(p => p.entity_id != null);

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
    // Desempate por coma: la MEDIA por manga, no la suma. Es la misma regla que
    // usa el agregado de resultados (Lap.aggregateByRace). Divergían: dos
    // entidades empatadas a vueltas podían salir en orden OPUESTO según se mirara
    // el panel/Le Mans o la pantalla de resultados. Solo coincidían cuando todos
    // habían corrido el mismo número de mangas — es decir, nunca con descansos.
    const comaMedia = (r) => (r.mangasRaced ? r.comaTotal / r.mangasRaced : 0);
    proj.sort((a, b) => {
      if (a.projectedRaw == null && b.projectedRaw == null) return (a.name || '').localeCompare(b.name || '');
      if (a.projectedRaw == null) return 1;
      if (b.projectedRaw == null) return -1;
      return (b.projectedRaw - a.projectedRaw)
          || (b.totalLaps - a.totalLaps)
          || (comaMedia(b) - comaMedia(a))
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

  // El tiempo de un piloto NO se acumula sumando ticks: se DERIVA del reloj
  // efectivo de su circuito. Cada entrada guarda dónde empezó a contar
  // (`openElapsedMs`, en elapsed del circuito, no en wall-clock) y lo que ya
  // traía de antes (`baseMs`, > 0 solo al recuperar un turno abierto en BD):
  //
  //     drivingMs = baseMs + (circuitElapsed(ci) − openElapsedMs)
  //
  // Las pausas se descuentan solas (startTime del circuito ya las absorbe), el
  // GO escalonado sale gratis (un circuito pending tiene elapsed 0) y un
  // circuito finalizado deja de crecer (elapsed congelado en endTime). Al ser
  // elapsed relativo también es inmune a simSetClock(), que re-ancla startTime.
  _laneCircuit(lane) {
    return this.session && this.session.laneToCircuit ? this.session.laneToCircuit[lane] : null;
  }

  // Registra un turno abierto en el mapa en memoria, anclado al elapsed actual
  // de su circuito. `baseMs` es el tiempo que el turno ya tenía acumulado.
  _openShiftEntry(lane, shiftId, baseMs = 0) {
    const ci = this._laneCircuit(lane);
    this._activeShiftsByLane[lane] = {
      shiftId,
      baseMs,
      ci,
      openElapsedMs: this._circuitElapsedMs(ci) ?? 0,
      drivingMs: baseMs,   // caché derivada: la recalcula _drivingMsOf en cada tick
    };
    return this._activeShiftsByLane[lane];
  }

  // Tiempo del turno abierto en este instante. Fail-CLOSED: un carril sin
  // circuito conocido no suma (antes sumaba, aunque el circuito estuviera
  // pausado o finalizado), coherente con el descarte de cruces de _onCrossing.
  _drivingMsOf(entry) {
    if (!entry) return 0;
    const elapsed = this._circuitElapsedMs(entry.ci);
    if (elapsed == null) return entry.baseMs;
    return Math.max(entry.baseMs, entry.baseMs + (elapsed - entry.openElapsedMs));
  }

  // Refresca la caché `drivingMs` de cada turno abierto y devuelve el snapshot.
  _refreshDriverShifts() {
    for (const lane in this._activeShiftsByLane) {
      const e = this._activeShiftsByLane[lane];
      e.drivingMs = this._drivingMsOf(e);
    }
    return this._activeShiftsByLane;
  }

  // Recalcula y emite el snapshot por socket para que la vista de control
  // refresque cronómetros sin estimar en cliente. Persiste cada 5 ticks.
  _tickDriverShifts() {
    this._refreshDriverShifts();
    this._driverShiftTickN++;
    if (this._driverShiftTickN >= 5) {
      this._persistAllDriverShifts();
      this._driverShiftTickN = 0;
    }
    SocketService.emit('shifts:tick', {
      mangaId: this.session?.manga?.id,
      raceId:  this.session?.race?.id,
      active:  this._activeShiftsByLane,   // { lane: { shiftId, drivingMs, … } }
    });
  }

  // UPDATE de driving_ms en BD para cada shift abierto, en una sola transacción.
  // Se llama en el tick, pero también en pausa/reanudación/fin de circuito/swap:
  // así una caída pierde segundos, no la manga entera.
  _persistAllDriverShifts() {
    const lanes = Object.keys(this._activeShiftsByLane);
    if (!lanes.length) return;
    const db = require('../config/database');
    try {
      db.transaction(() => {
        for (const lane of lanes) {
          const e = this._activeShiftsByLane[lane];
          e.drivingMs = this._drivingMsOf(e);
          DriverShift.updateDrivingMs(e.shiftId, e.drivingMs);
        }
      })();
    } catch (e) {
      console.error('[TimingService] persist driver shift error', e.message);
    }
  }

  // Cierra los turnos abiertos de los carriles de un circuito, con el valor
  // calculado y el instante de fin de ESE circuito.
  _closeDriverShiftsForCircuit(ci) {
    const c = this.session && this.session.circuits[ci];
    const endedAt = (c && c.endTime) || Date.now();
    for (const lane of Object.keys(this._activeShiftsByLane)) {
      const e = this._activeShiftsByLane[lane];
      if (e.ci !== ci) continue;
      try { DriverShift.closeShift(e.shiftId, endedAt, this._drivingMsOf(e)); }
      catch (err) { console.error('[TimingService] closeShift', err.message); }
      delete this._activeShiftsByLane[lane];
    }
  }

  // Cambia el piloto de un carril en runtime: cierra el turno abierto con su
  // tiempo calculado (fracción de segundo incluida) y abre el del relevo. Si el
  // circuito está en pausa, el turno nuevo se crea pero no avanza hasta el
  // resume. Lo llama SessionController.driverCheckin con la manga ya corriendo
  // (el pre-arme va por otro camino).
  swapDriverOnLane({ lane, raceId, mangaId, teamId, driverId, driverName }) {
    if (!this.session || this.session.manga.id !== mangaId) return null;
    if (!this._isChampionship) return null;

    const now  = Date.now();
    const prev = this._activeShiftsByLane[lane];
    if (prev) {
      try { DriverShift.closeShift(prev.shiftId, now, this._drivingMsOf(prev)); }
      catch (e) { console.error('[TimingService] closeShift', e.message); }
    }

    const newId = DriverShift.openShift({
      mangaId, raceId, lane, teamId, driverId, driverName,
      startedAtMs: now, preArmed: false,
    });
    this._openShiftEntry(lane, newId, 0);
    return newId;
  }

  // Snapshot de shifts activos (lane → { shiftId, drivingMs, … }), con el
  // driving_ms recalculado al instante, no el de BD.
  getActiveShifts() {
    return { ...this._refreshDriverShifts() };
  }
}

module.exports = new TimingServiceClass();
