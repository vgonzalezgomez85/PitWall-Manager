const http    = require('http');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const morgan  = require('morgan');
const path    = require('path');

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

const SerialService = require('./services/SerialService');
SerialService.init(); // start with saved settings (or simulation if not configured)

// ── DS hardware GO/STOP ────────────────────────────────────────────────────────
const TimingService  = require('./services/TimingService');
const TrainingService = require('./services/TrainingService');

let _pendingGoDurationMs = null;

SerialService.on('race_go', ({ durationMs }) => {
  console.log(`[DS-300] race_go received (duration=${durationMs}ms) — emit race:semaphore @ ${Date.now()}`);
  if (TimingService._tandaBoundary) {
    console.log('[DS-300] GO ignored — tanda boundary, waiting for user to start next tanda');
    return;
  }
  _pendingGoDurationMs = durationMs || null;
  SocketService.emit('race:semaphore');
});

SerialService.on('race_started', () => {
  console.log(`[DS-300] race_started @ ${Date.now()} → emit training:autostart`);
  SocketService.emit('training:autostart');
  if (TimingService.isRunning) return;
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
  TimingService.startManga(setup.manga, setup.race, setup.lanes, setup.teams, setup.drivers, _pendingGoDurationMs);
  _pendingGoDurationMs = null;
  TimingService.clearPendingManga();
});

SerialService.on('race_stopped', () => {
  if (TimingService.isRunning) TimingService.cancelManga();
});

SerialService.on('race_finished', () => {
  if (TimingService.isRunning) TimingService.stopManga(true);
});

SerialService.on('race_paused', () => {
  if (TimingService.isRunning) TimingService.pauseManga();
});

// Trama 1 of the resume sequence (0xA6): show the same semaphore animation
// used on GO so users see the ~3s countdown before the track is unlocked.
SerialService.on('race_resume_signal', () => {
  console.log(`[DS-300] race_resume_signal received — emit race:semaphore @ ${Date.now()}`);
  SocketService.emit('race:semaphore');
});

// Trama 2 (0xA2) of GO or resume: intermediate step of the DS semaphore.
// Re-emitted so the on-screen semaphore lights its "all reds" stage exactly
// when the physical DS does — keeps both in sync regardless of firmware timing.
SerialService.on('semaphore_step', () => {
  SocketService.emit('race:semaphore_step');
});

SerialService.on('race_resumed', () => {
  TimingService.resumeManga();
});

const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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
