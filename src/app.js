const http    = require('http');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const morgan  = require('morgan');
const path    = require('path');

// Anti-crash global: en Express 4 los errores asíncronos en handlers no
// propagan al middleware de error automáticamente. Si un controller async
// olvida try/catch o un next(err), el promise queda rechazado y Node mata
// el proceso. Estos handlers lo evitan y dejan el server en marcha; la
// petición concreta queda colgada (cliente verá timeout) pero las demás
// siguen funcionando. Los handlers individuales SIGUEN siendo responsables
// de hacer try/catch — esto es solo red de seguridad.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});

const i18n    = require('./middleware/i18n');
const routes  = require('./routes');

require('./config/database'); // init schema

const LicenseService = require('./services/LicenseService');
const dataDir = process.env.SLOTIME_DATA || require('path').join(__dirname, '..', 'database');
LicenseService.load(dataDir);

const app    = express();
const server = http.createServer(app);

// Socket.io must be initialised before routes import services that need it
const SocketService = require('./services/SocketService');
SocketService.init(server);

const SettingsModel = require('./models/Settings');
const DebugLogger   = require('./services/DebugLogger');
DebugLogger.setEnabled(SettingsModel.get('debug_mode', '0') === '1');

const SerialService = require('./services/SerialService');
SerialService.init(); // start with saved settings (or simulation if not configured)

// ── DS hardware GO/STOP ────────────────────────────────────────────────────────
const TimingService  = require('./services/TimingService');
const TrainingService = require('./services/TrainingService');

let _pendingGoDurationMs = null;

// ── De-dup del semáforo entre varios DS ──────────────────────────────────────
// Con varios circuitos, cada DS emite su propia secuencia de semáforo (en GO y
// en resume). Atendemos solo al PRIMER race:semaphore dentro de una ventana y
// los demás se ignoran, para que el overlay no se re-dispare a media secuencia
// (lo que congelaba la pantalla). La ventana cubre la secuencia completa (~3s)
// más margen para el desfase entre los GO/resume de los distintos DS.
const SEMA_DEDUP_MS = 5000;
let _lastSemaphoreAt = 0;
function emitSemaphoreOnce(reason) {
  const now = Date.now();
  if (now - _lastSemaphoreAt < SEMA_DEDUP_MS) {
    console.log(`[DS-300] race:semaphore ignorado (${reason}) — ya hay uno activo en la ventana`);
    return;
  }
  _lastSemaphoreAt = now;
  SocketService.emit('race:semaphore');
}

SerialService.on('race_go', ({ durationMs }) => {
  console.log(`[DS-300] race_go received (duration=${durationMs}ms) — emit race:semaphore @ ${Date.now()}`);
  if (TimingService._tandaBoundary) {
    console.log('[DS-300] GO ignored — tanda boundary, waiting for user to start next tanda');
    return;
  }
  _pendingGoDurationMs = durationMs || null;
  emitSemaphoreOnce('go');
});

SerialService.on('race_started', ({ circuit } = {}) => {
  const ci = circuit || 0;
  console.log(`[DS-300] race_started (circuit ${ci + 1}) @ ${Date.now()} → emit training:autostart`);
  SocketService.emit('training:autostart');

  // Si ya hay una manga en curso, este GO pertenece a OTRO circuito: arranca
  // solo ese circuito (con su propio reloj) sin reiniciar ni tocar los demás.
  if (TimingService.activeMangaId != null) {
    TimingService.startCircuit(ci, _pendingGoDurationMs);
    _pendingGoDurationMs = null;
    return;
  }

  if (TimingService._tandaBoundary) {
    console.log('[DS-300] STARTED ignored — tanda boundary, waiting for user to start next tanda');
    return;
  }
  // Race manga only starts when a localhost client is on the live view.
  // Training keeps working regardless (above autostart emit).
  if (!SocketService.hasLocalLiveViewer()) {
    console.log('[DS-300] GO ignored for race — no localhost client on live view');
    return;
  }

  let setup = TimingService._pendingSetup;

  // Auto-find first pending manga if none registered (e.g. after server restart)
  if (!setup) {
    const Race   = require('./models/Race');
    const Manga  = require('./models/Manga');
    const Team   = require('./models/Team');
    const Driver = require('./models/Driver');
    const db     = require('./config/database');

    const races = Race.findAll().filter(r => r.status === 'active');
    for (const race of races) {
      const manga = Manga.findFirstPending(race.id);
      if (!manga) continue;

      // Tanda-boundary guard (survives server restarts): if the most recently
      // finished manga of this race is in a different tanda than the pending
      // one, block the auto-GO. User must hit "▶ Tanda N" first.
      const lastFinished = db.prepare(
        `SELECT tanda_id FROM mangas
         WHERE race_id = ? AND status = 'finished' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 1`
      ).get(race.id);
      if (lastFinished && lastFinished.tanda_id !== manga.tanda_id) {
        console.log(`[DS-300] GO ignored — tanda boundary (last finished was tanda ${lastFinished.tanda_id}, pending in tanda ${manga.tanda_id})`);
        return;
      }

      const lanes   = Manga.getLanes(manga.id);
      const teams   = Team.findByTanda(manga.tanda_id);
      const drivers = Driver.findByTanda(manga.tanda_id);
      setup = { manga, race, lanes, teams, drivers };
      console.log(`[DS-300] Auto-found pending manga ${manga.id} for race ${race.id}`);
      break;
    }
  }

  if (!setup) { console.log('[DS-300] GO received but no pending manga found'); return; }
  TimingService.startManga(setup.manga, setup.race, setup.lanes, setup.teams, setup.drivers, _pendingGoDurationMs, ci);
  _pendingGoDurationMs = null;
  TimingService.clearPendingManga();
});

SerialService.on('race_stopped', () => {
  // STOP forzado = abortar TODA la manga (aunque haya circuitos en pausa).
  if (TimingService.activeMangaId != null) TimingService.cancelManga();
});

SerialService.on('race_finished', ({ circuit } = {}) => {
  // Fin (normal / tiempo agotado) de UN circuito: lo cierra. La manga se
  // finaliza de verdad cuando todos los circuitos han terminado (finishCircuit).
  if (TimingService.activeMangaId != null) TimingService.finishCircuit(circuit || 0);
});

SerialService.on('race_paused', ({ circuit } = {}) => {
  // Pausa POR CIRCUITO: solo afecta a los carriles de ese DS.
  if (TimingService.activeMangaId != null) TimingService.pauseCircuit(circuit || 0);
});

// Trama 1 of the resume sequence (0xA6): show the same semaphore animation
// used on GO so users see the ~3s countdown before the track is unlocked.
SerialService.on('race_resume_signal', () => {
  console.log(`[DS-300] race_resume_signal received — emit race:semaphore @ ${Date.now()}`);
  emitSemaphoreOnce('resume');
});

// Trama 2 (0xA2) of GO or resume: intermediate step of the DS semaphore.
// Re-emitted so the on-screen semaphore lights its "all reds" stage exactly
// when the physical DS does — keeps both in sync regardless of firmware timing.
SerialService.on('semaphore_step', () => {
  SocketService.emit('race:semaphore_step');
});

SerialService.on('race_resumed', ({ circuit } = {}) => {
  if (TimingService.activeMangaId != null) TimingService.resumeCircuit(circuit || 0);
});

const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
// Límite elevado para soportar payloads de trazado con imagen base64 del circuito
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(express.json({ limit: '8mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'slotime-dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(i18n);

// Expose license info, serial status and flash messages to all views
app.use((req, res, next) => {
  res.locals.license = LicenseService.info;
  res.locals.tier    = LicenseService.tier;
  res.locals.flash   = req.session.flash || null;
  // Serial port status (computed at render time, lightweight)
  const SerialService = require('./services/SerialService');
  res.locals.serialStatus = {
    simulating: SerialService.isSimulating,
    ports:      SerialService.connectedPorts || [],
  };
  delete req.session.flash;
  next();
});

app.use('/', routes);

app.use((req, res) => {
  res.status(404).render('error', { t: req.t, code: 404, message: 'Page not found' });
});
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { t: req.t, code: 500, message: err.message || 'Internal server error' });
});

module.exports = { app, server };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  Voltrace Manager running at http://localhost:${PORT}\n`);
    announceBonjour(PORT);
  });
}

function announceBonjour(port) {
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    bonjour.publish({ name: 'Voltrace Manager', type: 'voltrace-manager', port });
    console.log(`  [mDNS] Voltrace Manager announced on local network (port ${port})\n`);
    process.on('exit', () => bonjour.destroy());
  } catch (e) {
    console.warn('  [mDNS] Could not start Bonjour:', e.message);
  }
}
