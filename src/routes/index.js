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
const TrainingController          = require('../controllers/TrainingController');
const MobileController            = require('../controllers/MobileController');
const LicenseController           = require('../controllers/LicenseController');
const { requireModule }           = require('../middleware/licenseGuard');

router.get('/', (req, res) => res.redirect('/races'));

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
router.post('/races/:id/mangas/:mangaId/start',        SessionController.start);
router.post('/races/:id/mangas/:mangaId/stop',         SessionController.stop);
router.post('/races/:id/mangas/:mangaId/repeat',       SessionController.repeat);

// ── Results ───────────────────────────────────────────────────────────────────
router.get( '/races/:id/results',      SessionController.results);
router.get( '/races/:id/results/xlsx', requireModule('export'), SessionController.excel);
router.post('/races/:id/complete',     RaceController.complete);

// ── Pole position ─────────────────────────────────────────────────────────────
router.get( '/races/:id/pole/setup',             requireModule('pole'), PoleController.setup);
router.post('/races/:id/pole/start',             requireModule('pole'), PoleController.startPole);
router.get( '/races/:id/pole/timing',            requireModule('pole'), PoleController.timing);
router.post('/races/:id/pole/participant/start', requireModule('pole'), PoleController.startParticipant);
router.post('/races/:id/pole/participant/stop',  requireModule('pole'), PoleController.stopParticipant);
router.post('/races/:id/pole/next',              requireModule('pole'), PoleController.advanceParticipant);
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
router.get(   '/races',      RaceController.index);
router.post(  '/races',      RaceController.create);
router.get(   '/races/:id',  RaceController.show);
router.delete('/races/:id',  RaceController.delete);

// ── Driver profiles ───────────────────────────────────────────────────────────
router.get(   '/drivers',           DriverProfileController.index);
router.get(   '/drivers/new',       DriverProfileController.newForm);
router.post(  '/drivers',           DriverProfileController.create);
router.post(  '/drivers/import',    DriverProfileController.importCsv);
router.get(   '/drivers/:id/edit',  DriverProfileController.editForm);
router.post(  '/drivers/:id',       DriverProfileController.update);
router.delete('/drivers/:id',       DriverProfileController.delete);

// ── Circuits ──────────────────────────────────────────────────────────────────
router.get(   '/circuits',            CircuitController.index);
router.get(   '/circuits/new',        CircuitController.newForm);
router.post(  '/circuits',            CircuitController.create);
router.get(   '/circuits/:id/edit',   CircuitController.editForm);
router.post(  '/circuits/:id',        CircuitController.update);
router.post(  '/circuits/:id/delete', CircuitController.delete);

// ── Training ──────────────────────────────────────────────────────────────────
router.get( '/training',       TrainingController.index);
router.get( '/training/live',  TrainingController.live);
router.post('/training/start', TrainingController.start);
router.post('/training/stop',  TrainingController.stop);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get( '/settings', SettingsController.index);
router.post('/settings', SettingsController.save);

// ── Mobile API ────────────────────────────────────────────────────────────────
router.get('/api/mobile/session', MobileController.session);

module.exports = router;
