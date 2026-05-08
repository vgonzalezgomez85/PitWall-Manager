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

SerialService.on('race_started', () => {
  if (TimingService.isRunning) return;
  const setup = TimingService._pendingSetup;
  if (!setup) { console.log('[DS-300] GO received but no pending manga is set'); return; }
  TimingService.startManga(setup.manga, setup.race, setup.lanes, setup.teams, setup.drivers);
  TimingService.clearPendingManga();
});

SerialService.on('race_stopped', () => {
  if (TimingService.isRunning) TimingService.cancelManga();
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

// Expose license info and flash messages to all views
app.use((req, res, next) => {
  res.locals.license = LicenseService.info;
  res.locals.tier    = LicenseService.tier;
  res.locals.flash   = req.session.flash || null;
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
    console.log(`\n  Slot Timer Pro running at http://localhost:${PORT}\n`);
    announceBonjour(PORT);
  });
}

function announceBonjour(port) {
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    bonjour.publish({ name: 'Slot Timer Pro', type: 'slot-timer-pro', port });
    console.log(`  [mDNS] Slot Timer Pro announced on local network (port ${port})\n`);
    process.on('exit', () => bonjour.destroy());
  } catch (e) {
    console.warn('  [mDNS] Could not start Bonjour:', e.message);
  }
}
