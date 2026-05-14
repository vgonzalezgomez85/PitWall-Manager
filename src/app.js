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
  if (TimingService._tandaBoundary) {
    console.log('[DS-300] GO ignored — tanda boundary, waiting for user to start next tanda');
    return;
  }
  _pendingGoDurationMs = durationMs || null;
  SocketService.emit('race:semaphore');
});

SerialService.on('race_started', () => {
  console.log('[DS-300] race_started → emit training:autostart');
  SocketService.emit('training:autostart');
  if (TimingService.isRunning) return;
  if (TimingService._tandaBoundary) {
    console.log('[DS-300] STARTED ignored — tanda boundary, waiting for user to start next tanda');
    return;
  }

  let setup = TimingService._pendingSetup;

  // Auto-find first pending manga if none registered (e.g. after server restart)
  if (!setup) {
    const Race   = require('./models/Race');
    const Manga  = require('./models/Manga');
    const Team   = require('./models/Team');
    const Driver = require('./models/Driver');

    const races = Race.findAll().filter(r => r.status === 'active');
    for (const race of races) {
      const manga = Manga.findFirstPending(race.id);
      if (manga) {
        const lanes   = Manga.getLanes(manga.id);
        const teams   = Team.findByTanda(manga.tanda_id);
        const drivers = Driver.findByTanda(manga.tanda_id);
        setup = { manga, race, lanes, teams, drivers };
        console.log(`[DS-300] Auto-found pending manga ${manga.id} for race ${race.id}`);
        break;
      }
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
