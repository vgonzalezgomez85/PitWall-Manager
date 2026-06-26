const express  = require('express');
const router   = express.Router();
const RaceController              = require('../controllers/RaceController');
const TandaController             = require('../controllers/TandaController');
const SessionController           = require('../controllers/SessionController');
const SettingsController          = require('../controllers/SettingsController');
const DriverProfileController     = require('../controllers/DriverProfileController');
const PoleController              = require('../controllers/PoleController');
const LapCorrectionController     = require('../controllers/LapCorrectionController');
const CircuitController           = require('../controllers/CircuitController');
const CategoryController          = require('../controllers/CategoryController');
const CarController               = require('../controllers/CarController');
const ControlController           = require('../controllers/ControlController');
const TeamCatalogController       = require('../controllers/TeamCatalogController');
const TrainingController          = require('../controllers/TrainingController');
const MobileController            = require('../controllers/MobileController');
const LicenseController           = require('../controllers/LicenseController');
const DiagnosticsController       = require('../controllers/DiagnosticsController');
const LiveStatsController         = require('../controllers/LiveStatsController');
const DatabaseController          = require('../controllers/DatabaseController');
const { requireModule }           = require('../middleware/licenseGuard');

router.get('/', (req, res) => {
  const Race          = require('../models/Race');
  const DriverProfile = require('../models/DriverProfile');
  const TeamCatalog   = require('../models/TeamCatalog');
  const Car           = require('../models/Car');
  const Category      = require('../models/Category');
  const Circuit       = require('../models/Circuit');
  const SerialService = require('../services/SerialService');

  // Contadores ligeros (rápidos sobre tablas pequeñas) + race en curso
  const allRaces       = Race.findAll();
  const activeRaceCount = allRaces.filter(r => r.status === 'active').length;
  const counts = {
    drivers:    DriverProfile.findAll().length,
    teams:      TeamCatalog.findAll().length,
    cars:       (() => { try { return Car.findAll().length; } catch { return 0; } })(),
    categories: Category.findAll().length,
    circuits:   Circuit.findAll().length,
  };
  const serial = SerialService.getLinkStatus();

  // IP(s) por las que el server es accesible (para mostrarlas en la home).
  const net        = require('../utils/network');
  const Settings   = require('../models/Settings');
  const serverIps  = net.serverIPs(Settings.get('server_bind_iface', ''));
  const serverPort = parseInt(process.env.PORT || '3000', 10);

  res.render('home', { t: req.t, counts, activeRaceCount, serial, serverIps, serverPort });
});

// ── License ───────────────────────────────────────────────────────────────────
router.get( '/license',        LicenseController.index);
router.post('/license/upload', LicenseController.upload);
router.get( '/eula',           LicenseController.eula);

// ── Wizard ────────────────────────────────────────────────────────────────────
router.get('/races/new',         requireModule('races_basic'), RaceController.newStep1);
router.post('/races/new/step1',  requireModule('races_basic'), RaceController.postStep1);
router.get('/races/new/step2',   requireModule('races_basic'), RaceController.newStep2);
router.post('/races/new/step2',  requireModule('races_basic'), RaceController.postStep2);
router.get('/races/new/step3',   requireModule('races_basic'), RaceController.newStep3);
router.post('/races/new/step3',  requireModule('races_basic'), RaceController.postStep3);
router.get('/races/new/step4',   requireModule('races_basic'), RaceController.newStep4);
router.post('/races/new/step4',  requireModule('races_basic'), RaceController.postStep4);
router.get('/races/new/confirm', requireModule('races_basic'), RaceController.newConfirm);

// ── Lap corrections ───────────────────────────────────────────────────────────
router.get( '/races/:id/mangas/:mangaId/corrections',                LapCorrectionController.show);
router.post('/races/:id/mangas/:mangaId/corrections/ghost/:lapId',   LapCorrectionController.markGhost);
router.post('/races/:id/mangas/:mangaId/corrections/restore/:lapId', LapCorrectionController.restore);
router.post('/races/:id/mangas/:mangaId/corrections/transfer/:lapId',LapCorrectionController.transfer);
router.post('/races/:id/mangas/:mangaId/corrections/add',            LapCorrectionController.addManual);
router.post('/races/:id/mangas/:mangaId/corrections/delete/:lapId',  LapCorrectionController.deleteLap);

// ── Manga session ─────────────────────────────────────────────────────────────
router.get( '/races/:id/mangas/:mangaId/live',         SessionController.live);
router.get( '/races/:id/mangas/:mangaId/tv',           requireModule('tv'), SessionController.tv);
router.get( '/races/:id/mangas/:mangaId/panel/:type',  SessionController.panel);
router.post('/races/:id/circuit-orientation',          SessionController.saveCircuitOrientation);
router.post('/races/:id/mangas/:mangaId/start',        SessionController.start);
router.post('/races/:id/mangas/:mangaId/checkin',      requireModule('qr_checkin'), SessionController.driverCheckin);
router.post('/races/:id/mangas/:mangaId/correct-time', requireModule('qr_checkin'), SessionController.correctShiftTime);
router.post('/races/:id/mangas/:mangaId/stop',         SessionController.stop);
router.post('/races/:id/mangas/:mangaId/pause',        SessionController.pause);
router.post('/races/:id/mangas/:mangaId/resume',       SessionController.resume);
router.post('/races/:id/tandas/:tandaId/next-tanda',   SessionController.activateNextTanda);
router.post('/races/:id/mangas/:mangaId/repeat',       SessionController.repeat);

// ── QR shifts control ─────────────────────────────────────────────────────
router.get('/control/shifts',     ControlController.live);
router.get('/races/:id/shifts',   ControlController.raceHistory);

// ── Le Mans classification board ──────────────────────────────────────────────
router.get( '/races/:id/lemans',       requireModule('lemans'), SessionController.lemans);

// ── Results ───────────────────────────────────────────────────────────────────
router.get( '/races/:id/results',      SessionController.results);
router.get( '/races/:id/results/export.html', requireModule('export'), SessionController.exportResults);
router.get( '/races/:id/results/xlsx', requireModule('export'), SessionController.excel);
router.get( '/races/:id/results/points.xlsx', requireModule('export'), SessionController.pointsExcel);
router.get( '/races/:id/results/points.csv',  requireModule('export'), SessionController.pointsCsv);
router.get( '/races/:id/results/control.csv', requireModule('export'), SessionController.controlCsv);
router.post('/races/:id/complete',     RaceController.complete);

// ── Pole position ─────────────────────────────────────────────────────────────
router.get( '/races/:id/pole/setup',             requireModule('pole'), PoleController.setup);
router.post('/races/:id/pole/start',             requireModule('pole'), PoleController.startPole);
router.get( '/races/:id/pole/timing',            requireModule('pole'), PoleController.timing);
router.post('/races/:id/pole/participant/start', requireModule('pole'), PoleController.startParticipant);
router.post('/races/:id/pole/participant/stop',  requireModule('pole'), PoleController.stopParticipant);
router.post('/races/:id/pole/next',              requireModule('pole'), PoleController.advanceParticipant);
router.post('/races/:id/pole/omit-first',        requireModule('pole'), PoleController.setOmitFirstCrossing);
router.get( '/races/:id/pole/results',           requireModule('pole'), PoleController.results);
router.post('/races/:id/pole/times',             requireModule('pole'), PoleController.saveTimes);
router.get( '/races/:id/pole/lanes',             requireModule('pole'), PoleController.laneSelection);
router.post('/races/:id/pole/lanes',             requireModule('pole'), PoleController.assignLanes);

// ── Tandas ────────────────────────────────────────────────────────────────────
router.get(   '/races/:id/tandas/new',            TandaController.newForm);
router.post(  '/races/:id/tandas',                TandaController.create);
router.get(   '/races/:id/tandas/:tandaId/edit',  TandaController.editTanda);
router.post(  '/races/:id/tandas/:tandaId/edit',  TandaController.updateTanda);
router.delete('/races/:id/tandas/:tandaId',       TandaController.delete);
router.get(   '/races/:id/mangas/:mangaId/edit',  TandaController.editManga);
router.post(  '/races/:id/mangas/:mangaId/edit',  TandaController.updateManga);

// ── Races CRUD ────────────────────────────────────────────────────────────────
router.get(   '/races',          RaceController.index);
router.post(  '/races',          RaceController.create);
router.get(   '/races/:id/edit', requireModule('races_basic'), RaceController.editForm);
router.post(  '/races/:id/edit', requireModule('races_basic'), RaceController.update);
router.get(   '/races/:id',      RaceController.show);
router.delete('/races/:id',      RaceController.delete);

// ── Driver profiles ───────────────────────────────────────────────────────────
router.get(   '/drivers',           requireModule('driver_profiles'), DriverProfileController.index);
router.get(   '/drivers/new',       requireModule('driver_profiles'), DriverProfileController.newForm);
router.post(  '/drivers',           requireModule('driver_profiles'), DriverProfileController.create);
router.post(  '/drivers/import/preview', requireModule('driver_profiles'), DriverProfileController.importPreview);
router.post(  '/drivers/import',    requireModule('driver_profiles'), DriverProfileController.importConfirm);
router.get(   '/drivers/qr-all',    requireModule('driver_profiles'), DriverProfileController.qrAll);
router.get(   '/drivers/:id/qr',    requireModule('driver_profiles'), DriverProfileController.qrPage);
router.get(   '/drivers/:id/edit',  requireModule('driver_profiles'), DriverProfileController.editForm);
router.post(  '/drivers/:id',       requireModule('driver_profiles'), DriverProfileController.update);
router.delete('/drivers/:id',       requireModule('driver_profiles'), DriverProfileController.delete);

// ── Circuits ──────────────────────────────────────────────────────────────────
router.get(   '/circuits',            CircuitController.index);
router.get(   '/circuits/new',        CircuitController.newForm);
router.post(  '/circuits',            CircuitController.create);
router.get(   '/circuits/:id/edit',   CircuitController.editForm);
router.post(  '/circuits/:id',        CircuitController.update);
router.post(  '/circuits/:id/delete', CircuitController.delete);

// ── Categories ────────────────────────────────────────────────────────────────
router.get(   '/categories',            CategoryController.index);
router.get(   '/categories/new',        CategoryController.new);
router.post(  '/categories',            CategoryController.create);
router.get(   '/categories/:id/edit',   CategoryController.edit);
router.post(  '/categories/:id',        CategoryController.update);
router.post(  '/categories/:id/delete', CategoryController.delete);
router.post(  '/api/categories',        CategoryController.apiCreate);

// ── Cars ──────────────────────────────────────────────────────────────────────
router.get(   '/cars',            CarController.index);
router.get(   '/cars/new',        CarController.new);
router.post(  '/cars/import/preview', CarController.importPreview);
router.post(  '/cars/import',     CarController.importConfirm);
router.post(  '/cars',            CarController.create);
router.get(   '/cars/:id/edit',   CarController.edit);
router.post(  '/cars/:id',        CarController.update);
router.post(  '/cars/:id/delete', CarController.delete);

router.get(   '/teams',            requireModule('teams_catalog'), TeamCatalogController.index);
router.get(   '/teams/new',        requireModule('teams_catalog'), TeamCatalogController.newForm);
router.post(  '/teams/import/preview', requireModule('teams_catalog'), TeamCatalogController.importPreview);
router.post(  '/teams/import',     requireModule('teams_catalog'), TeamCatalogController.importConfirm);
router.post(  '/teams',            requireModule('teams_catalog'), TeamCatalogController.create);
router.get(   '/teams/:id/edit',   requireModule('teams_catalog'), TeamCatalogController.editForm);
router.post(  '/teams/:id',        requireModule('teams_catalog'), TeamCatalogController.update);
router.post(  '/teams/:id/delete', requireModule('teams_catalog'), TeamCatalogController.delete);

router.post('/api/teams-catalog/quick', requireModule('teams_catalog'), TeamCatalogController.quickCreate);

// ── Training ──────────────────────────────────────────────────────────────────
router.get( '/training',                      TrainingController.index);
router.get( '/training/free',                 TrainingController.free);
router.get( '/training/competition',          TrainingController.competition);
router.post('/training/competition/start',    TrainingController.competitionStart);
router.get( '/training/competition/live',     TrainingController.competitionLive);
router.post('/training/competition/stop',     TrainingController.competitionStop);
router.get( '/training/live',                 TrainingController.live);
router.post('/training/go',                   TrainingController.go);
router.post('/training/pause',                 TrainingController.pause);
router.post('/training/resume',                TrainingController.resume);
router.post('/training/halt',                  TrainingController.halt);
router.post('/training/start',                TrainingController.start);
router.post('/training/stop',                 TrainingController.stop);
router.post('/training/free/reset',           TrainingController.freeReset);
router.post('/training/exit',                 TrainingController.exit);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get( '/race-stats',                        LiveStatsController.index);
router.get( '/races/:id/live-stats',              LiveStatsController.show);
router.get( '/races/:id/live-stats.json',         LiveStatsController.json);

// Resultados públicos (consulta de carreras finalizadas, sin corrección)
router.get( '/results',                           SessionController.resultsIndex);
router.get( '/results/:id',                       SessionController.publicResults);

router.get( '/diagnostico',                       DiagnosticsController.index);
router.post('/diagnostico/clear-boundary',        DiagnosticsController.clearBoundary);
router.post('/diagnostico/cancel-active',         DiagnosticsController.cancelActive);
router.post('/diagnostico/clear-pending',         DiagnosticsController.clearPending);
router.post('/diagnostico/reset-manga/:mangaId',  DiagnosticsController.resetManga);
router.post('/diagnostico/reconnect-serial',      DiagnosticsController.reconnectSerial);

router.get( '/settings',           SettingsController.index);
router.post('/settings',           SettingsController.save);
router.get( '/api/settings/ports', SettingsController.listPorts);

// ── Gestión de base de datos ───────────────────────────────────────────────────
router.get( '/database',        DatabaseController.index);
router.get( '/database/backup', DatabaseController.backup);
router.get( '/api/serial/status', (req, res) => {
  const SerialService = require('../services/SerialService');
  res.json(SerialService.getLinkStatus());
});
router.post('/api/serial/close', async (req, res) => {
  const SerialService = require('../services/SerialService');
  await SerialService.closeAll();
  res.json(SerialService.getLinkStatus());
});

// ── Mobile API ────────────────────────────────────────────────────────────────
// IMPORTANT: las rutas específicas (`current`, `active`) deben ir ANTES
// de la genérica `:id` para que Express las matchee primero.
router.get('/api/mobile/session',            MobileController.session);
router.get('/api/mobile/training',           MobileController.training);
router.get('/api/mobile/races/current',      MobileController.racesCurrent);
router.get('/api/mobile/races/active',       MobileController.racesActive);
router.get('/api/mobile/races',              MobileController.racesList);
router.get('/api/mobile/races/:id/results',  MobileController.racesResults);
router.get('/api/mobile/races/:id',          MobileController.racesShow);
router.get('/api/mobile/races/:id/pole',     MobileController.racesPole);

// ── Test: simulate DS-300 events ─────────────────────────────────────────────
router.get('/api/test/go', (req, res) => {
  const SerialService = require('../services/SerialService');
  SerialService.emit('race_go', { durationMs: 6 * 60000 });
  setTimeout(() => SerialService.emit('race_started'), 6500);
  res.json({ ok: true, msg: 'GO emitted, race_started in 6.5s' });
});
router.get('/api/test/stop', (req, res) => {
  const SerialService = require('../services/SerialService');
  SerialService.emit('race_stopped');
  res.json({ ok: true, msg: 'race_stopped emitted' });
});
router.get('/api/test/finish', (req, res) => {
  const SerialService = require('../services/SerialService');
  SerialService.emit('race_finished');
  res.json({ ok: true, msg: 'race_finished emitted' });
});
router.get('/api/test/pause', (req, res) => {
  const SerialService = require('../services/SerialService');
  SerialService.emit('race_paused');
  res.json({ ok: true, msg: 'race_paused emitted' });
});
router.get('/api/test/resume', (req, res) => {
  const SerialService = require('../services/SerialService');
  SerialService.emit('race_resumed');
  res.json({ ok: true, msg: 'race_resumed emitted' });
});

// ── Debug: raw serial log ─────────────────────────────────────────────────────
router.get('/api/rawlog', (req, res) => {
  const SerialService = require('../services/SerialService');
  const log = SerialService.getRawLog();
  const hex = log.map(e => e.byte.toString(16).padStart(2, '0'));
  res.json({ count: hex.length, bytes: hex, raw: log });
});

module.exports = router;
