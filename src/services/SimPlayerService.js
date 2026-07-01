// Reproductor de carreras simuladas: lee las tramas/cruces guardados de una
// carrera y los inyecta en SerialService (modo simulación) a la velocidad
// elegida. Control MANGA A MANGA desde el panel:
//   • Arrancar     → GO de la manga actual y empieza a reproducir sus tramas.
//   • Pausa        → congela la reproducción y el reloj.
//   • Reanudar     → sigue desde donde estaba.
//   • Final de manga → vuelca de golpe las tramas que queden, finaliza la manga
//                      y deja el estado LISTO para la siguiente (sin arrancarla:
//                      hay que volver a pulsar Arrancar para el GO siguiente).
//   • Parar        → aborta la simulación por completo.

const fs = require('fs');
const path = require('path');
const SerialService = require('./SerialService');
const TimingService = require('./TimingService');
const dsFrames = require('../lib/dsFrames');
const db = require('../config/database');
const Race = require('../models/Race');
const Manga = require('../models/Manga');
const Team = require('../models/Team');
const Driver = require('../models/Driver');

const SIM_DIR = path.join(__dirname, '..', '..', 'database', 'sim');
const DS_INDEX = { DS1: 0, DS2: 1, DS3: 2 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class SimPlayer {
  constructor() { this._clear(); }

  _clear() {
    this.raceId = null; this.meta = null;
    this.gos = []; this.windows = []; this.mangaIds = []; this.circuits = [];
    this.speed = 1; this.playing = false;
    this.rotation = 0; this.frameIdx = 0;
    this._armed = {}; this._skip = false; this._stop = false; this._running = false;
    this.phase = 'idle';   // idle | ready | playing | paused | done
  }

  get status() {
    const totalFrames = this.windows.reduce((s, w) => s + w.length, 0);
    return {
      active: this.raceId != null,
      raceId: this.raceId,
      raceName: this.meta && this.meta.name,
      playing: this.playing,
      phase: this.phase,
      speed: this.speed,
      // Manga "en juego" (la que corre o la que está lista para arrancar).
      rotation: this.raceId != null ? Math.min(this.rotation + 1, this.gos.length || 1) : 0,
      totalRotations: this.gos.length,
      mangaFrame: this.frameIdx,
      mangaFrames: this.windows[this.rotation] ? this.windows[this.rotation].length : 0,
      totalFrames,
    };
  }

  _load(raceId) {
    const metaP = path.join(SIM_DIR, `${raceId}.json`);
    const framesP = path.join(SIM_DIR, `${raceId}.frames`);
    if (!fs.existsSync(metaP) || !fs.existsSync(framesP)) {
      throw new Error('Esta carrera no tiene tramas de simulación.');
    }
    const meta = JSON.parse(fs.readFileSync(metaP, 'utf8'));
    const race = db.prepare('SELECT name, manga_duration_minutes FROM races WHERE id=?').get(raceId) || {};
    meta.name = race.name;
    const parsed = dsFrames.parse(fs.readFileSync(framesP, 'utf8'), meta.source);
    this.raceId = raceId;
    this.meta = meta;
    this.gos = parsed.gos.length ? parsed.gos : [parsed.frames[0] ? parsed.frames[0].ts : 0];
    const durMs = (meta.durationMin || race.manga_duration_minutes || 10) * 60000;
    // Ventana de cada rotación. Empieza un poco ANTES del GO de DS1 (gos[r]):
    // cada DS emite su propia trama a1 (GO+duración) que ARMA su circuito, y
    // las de DS2/DS3 llegan unos ms antes que la de DS1; si cortáramos justo en
    // gos[r] quedarían fuera y esos circuitos no arrancarían (se irían perdiendo
    // circuitos manga a manga: 3→2→1). El descanso entre mangas dura minutos,
    // así que 1,5 s de margen captura todas las a1 sin solaparse con la manga
    // anterior. Recortamos el final en la ÚLTIMA trama de "fin de manga" (0xa4)
    // para no reproducir los minutos muertos del descanso.
    const GO_LOOKBACK_MS = 1500;
    this.windows = this.gos.map((t0, r) => {
      const t1 = this.gos[r + 1] || (t0 + durMs + 10 * 60000);
      const win = parsed.frames.filter(f => f.ts >= t0 - GO_LOOKBACK_MS && f.ts < t1);
      let lastFinish = -1;
      for (let i = 0; i < win.length; i++) if (dsFrames.isFinish(win[i].bytes)) lastFinish = i;
      return lastFinish >= 0 ? win.slice(0, lastFinish + 1) : win;
    });
    this.mangaIds = db.prepare('SELECT id FROM mangas WHERE race_id=? ORDER BY number').all(raceId).map(r => r.id);
    this.circuits = (meta.circuits && meta.circuits.length ? meta.circuits : [meta.lanes || 8]).map(l => ({ lanes: l }));
  }

  // Arrancar: GO de la manga actual. En la primera llamada carga la carrera y
  // abre el modo simulación; en las siguientes (tras "final de manga") arranca
  // la manga que quedó preparada.
  async start(raceId, speed) {
    if (this.raceId !== raceId) {
      await this.stop();
      this._clear();
      this._load(raceId);
      await SerialService.startSimMode(this.circuits);
    }
    if (speed > 0) this.speed = speed;
    if (this.phase === 'playing' || this.phase === 'paused') return this.status;  // ya en marcha
    if (this.rotation >= this.windows.length) { this.phase = 'done'; return this.status; }
    this._stop = false; this._skip = false;
    this.playing = true; this.phase = 'playing';
    this._run();
    return this.status;
  }

  setSpeed(x) { if (x > 0) this.speed = x; return this.status; }

  // Pausa: congela reproducción + reloj (la manga sigue armada).
  pause() {
    if (this.phase !== 'playing') return this.status;
    this.playing = false; this.phase = 'paused';
    try { TimingService.pauseManga(); } catch {}
    return this.status;
  }

  // Reanudar tras pausa.
  resume() {
    if (this.phase !== 'paused' || this._running) return this.status;
    try { TimingService.simResumeManga(); } catch {}
    this.playing = true; this.phase = 'playing';
    this._run();
    return this.status;
  }

  // Final de manga: vuelca lo que queda al instante, finaliza y deja LISTA la
  // siguiente (no la arranca).
  skipMangaEnd() {
    if (this.phase !== 'playing' && this.phase !== 'paused') return this.status;
    this._skip = true;
    if (this.phase === 'paused') { try { TimingService.simResumeManga(); } catch {} }
    this.playing = true; this.phase = 'playing';
    if (!this._running) this._run();
    return this.status;
  }

  async stop() {
    this._stop = true; this.playing = false;
    await sleep(50);
    if (this.raceId) {
      // Cierra la manga en memoria (aborta sin persistir): si no, la sesión de
      // TimingService sigue viva y la vista en vivo muestra la carrera "en
      // marcha" con el reloj corriendo aunque el reproductor esté parado.
      try { TimingService.stopManga(false); } catch {}
      try { await SerialService.stopSimMode(); } catch {}
    }
    this._clear();
    return this.status;
  }

  // Reproduce UNA sola manga (la rotación actual) y para al terminarla,
  // dejándola lista para la siguiente. No auto-encadena.
  //
  // NO armamos la manga por HTTP: eso llamaría a SessionController.start, que
  // arranca la manga en el acto (emite manga:started ANTES de que las tramas
  // pinten el semáforo → overlay huérfano). En su lugar dejamos que la propia
  // trama de GO (a3) dispare race_started y app.js auto-arranque la primera
  // manga pendiente — así el semáforo (a1) va antes que el arranque (a3).
  async _run() {
    if (this._running) return;
    this._running = true;
    try {
      const r = this.rotation;
      const win = this.windows[r];
      if (!win) { this.phase = 'done'; this.playing = false; return; }

      // Al empezar una manga (frameIdx 0), dejamos preparado el setup EXACTO de
      // esta rotación para que la trama de GO (a3) arranque justo esta manga —
      // sin depender del auto-arranque de app.js, que elige "la primera
      // pendiente" y puede equivocarse de manga.
      if (this.frameIdx === 0 && TimingService.activeMangaId == null) {
        try {
          const manga = Manga.findById(this.mangaIds[r]);
          if (manga) {
            TimingService._pendingSetup = {
              manga, race: Race.findById(this.raceId),
              lanes: Manga.getLanes(manga.id),
              teams: Team.findByTanda(manga.tanda_id),
              drivers: Driver.findByTanda(manga.tanda_id),
            };
          }
        } catch (e) { /* si falla, app.js hará auto-arranque */ }
      }

      while (this.frameIdx < win.length) {
        if (this._stop || !this.playing) return;   // pausa/parada: conserva frameIdx
        const f = win[this.frameIdx];
        const prevTs = this.frameIdx > 0 ? win[this.frameIdx - 1].ts : f.ts;
        const dt = this._skip ? 0 : (f.ts - prevTs) / this.speed;
        if (dt >= 4) await sleep(dt);
        else if ((this.frameIdx & 255) === 0) await sleep(0);  // ráfaga rápida (skip o ×100): ceder el event loop para no bloquear el server
        if (this._stop || !this.playing) return;   // pudo pausarse durante el sleep
        // Ancla el reloj de la manga al tiempo virtual de la trama (ms desde el
        // GO de esta rotación) ANTES de inyectarla: el cronómetro va a ×N y el
        // elapsed_ms de la vuelta cae en su minuto real, incluso al volcar el
        // final de manga de golpe.
        TimingService.simSetClock(f.ts - this.gos[r]);
        SerialService.feedFrame(DS_INDEX[f.ds] != null ? DS_INDEX[f.ds] : 0, f.bytes);
        this.frameIdx++;
      }

      // Tramas agotadas → la manga ha terminado (la trama 0xa4 la cerró). Nos
      // aseguramos de finalizarla y dejamos preparada la siguiente.
      this._finishManga();
    } finally {
      this._running = false;
    }
  }

  _finishManga() {
    // Si por lo que sea la manga no se cerró con la trama de fin, la cerramos
    // ahora persistiendo resultados.
    try {
      if (TimingService.activeMangaId === this.mangaIds[this.rotation]) TimingService.stopManga(true);
    } catch {}
    this._skip = false;
    this.rotation++;
    this.frameIdx = 0;
    this.playing = false;
    this.phase = this.rotation >= this.windows.length ? 'done' : 'ready';
  }
}

module.exports = new SimPlayer();
