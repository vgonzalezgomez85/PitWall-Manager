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
const express  = require('express');
const router   = express.Router();
const RaceController              = require('../controllers/RaceController');
const SimController               = require('../controllers/SimController');
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
const LapController               = require('../controllers/LapController');
const LicenseController           = require('../controllers/LicenseController');
const DiagnosticsController       = require('../controllers/DiagnosticsController');
const LiveStatsController         = require('../controllers/LiveStatsController');
const DatabaseController          = require('../controllers/DatabaseController');
const LinkController               = require('../controllers/LinkController');
const ImportController             = require('../controllers/ImportController');

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

// ── EULA ──────────────────────────────────────────────────────────────────────
router.get( '/eula',           LicenseController.eula);

// ── Historial de versiones ────────────────────────────────────────────────────
router.get( '/changelog',      require('../controllers/ChangelogController').page);

// ── Wizard ────────────────────────────────────────────────────────────────────
router.get('/races/new',         RaceController.newStep1);
router.post('/races/new/step1',  RaceController.postStep1);
router.get('/races/new/step3',   RaceController.newStep3);
router.post('/races/new/step3',  RaceController.postStep3);
router.get('/races/new/step4',   RaceController.newStep4);
router.post('/races/new/step4',  RaceController.postStep4);
router.get('/races/new/confirm', RaceController.newConfirm);

// ── Importar tanda desde PitWall Control (fichero JSON o LAN) ───────────────
router.get( '/import/tanda', ImportController.page);    // pantalla de subida (operador local)
router.post('/import/tanda', ImportController.create);  // crea la carrera (fichero o LAN + PIN)

// ── Carrera simulada (desde fichero de tramas DS-300) ───────────────────────
router.get( '/races/sim/new',     SimController.newForm);
router.post('/races/sim/analyze', SimController.upload.single('frames'),   SimController.analyze);
router.post('/races/sim/create',  SimController.upload.single('lane_csv'), SimController.create);
// Panel de simulación (fase 2) + controles
router.get( '/races/:id/sim',            SimController.panel);
router.get( '/races/:id/sim/status',     SimController.simStatus);
router.post('/races/:id/sim/start',      SimController.simStart);
router.post('/races/:id/sim/speed',      SimController.simSpeed);
router.post('/races/:id/sim/pause',      SimController.simPause);
router.post('/races/:id/sim/resume',     SimController.simResume);
router.post('/races/:id/sim/skip-manga', SimController.simSkip);
router.post('/races/:id/sim/stop',       SimController.simStop);

// ── Lap corrections ───────────────────────────────────────────────────────────
router.get( '/races/:id/mangas/:mangaId/corrections',                LapCorrectionController.show);
router.post('/races/:id/mangas/:mangaId/corrections/ghost/:lapId',   LapCorrectionController.markGhost);
router.post('/races/:id/mangas/:mangaId/corrections/restore/:lapId', LapCorrectionController.restore);
router.post('/races/:id/mangas/:mangaId/corrections/transfer/:lapId',LapCorrectionController.transfer);
router.post('/races/:id/mangas/:mangaId/corrections/add',            LapCorrectionController.addManual);
router.post('/races/:id/mangas/:mangaId/corrections/delete/:lapId',  LapCorrectionController.deleteLap);
router.post('/races/:id/mangas/:mangaId/corrections/edit/:lapId',    LapCorrectionController.editTime);

// ── Manga session ─────────────────────────────────────────────────────────────
router.get( '/races/:id/mangas/:mangaId/live',         SessionController.live);
router.get( '/races/:id/mangas/:mangaId/tv',           SessionController.tv);
router.get( '/races/:id/mangas/:mangaId/panel/:type',  SessionController.panel);
router.post('/races/:id/circuit-orientation',          SessionController.saveCircuitOrientation);
router.post('/races/:id/mangas/:mangaId/start',        SessionController.start);
router.post('/races/:id/mangas/:mangaId/checkin',      SessionController.driverCheckin);
router.post('/races/:id/mangas/:mangaId/correct-time', SessionController.correctShiftTime);
router.post('/races/:id/mangas/:mangaId/stop',         SessionController.stop);
router.post('/races/:id/mangas/:mangaId/pause',        SessionController.pause);
router.post('/races/:id/mangas/:mangaId/resume',       SessionController.resume);
router.post('/races/:id/tandas/:tandaId/next-tanda',   SessionController.activateNextTanda);
router.post('/races/:id/mangas/:mangaId/repeat',       SessionController.repeat);

// ── Race Link (maestro↔esclavo): provisión de carrera ─────────────────────
// MAESTRO expone la lista y el payload; ESCLAVO descarga+crea. Todo aditivo.
router.get( '/link',                       LinkController.page);           // pantalla operador del esclavo
router.get( '/link/races',                 LinkController.listRaces);
router.get( '/link/races/:id/export.json', LinkController.exportRace);
router.get( '/link/races/:id/results.json', LinkController.resultsRace); // resultados por tanda → Control
router.get( '/link/master/races',          LinkController.remoteRaces);   // proxy: lista del maestro remoto
router.post('/link/provision',             LinkController.provision);     // descarga del maestro + crea
router.post('/link/import',                LinkController.importPayload);  // crea desde payload/fichero
router.post('/link/config',                LinkController.saveConfig);    // rol/URL/token (operador local)
// Control maestro→esclavo (estado deseado). Exento de IP en accessControl;
// autorizado por token (role=slave + x-link-token) dentro del controlador.
router.post('/link/state',                 LinkController.state);
router.post('/link/event',                 LinkController.event);
// Comparador DS↔BART: /link/laps lo pide el otro sistema (read-only, exento de IP);
// /link/compare* los usa el operador local.
router.get( '/link/laps',                  LinkController.laps);
router.get( '/link/compare',               LinkController.comparePage);
router.get( '/link/compare/mangas',        LinkController.compareMangas);
router.get( '/link/compare/data',          LinkController.compareData);

// ── QR shifts control ─────────────────────────────────────────────────────
router.get('/control/shifts',     ControlController.live);
router.get('/races/:id/shifts',   ControlController.raceHistory);
// Informe final de turnos: pantalla, HTML autónomo (reclamaciones) y Excel.
// Las dos exportaciones van ANTES de nada que pueda tragarse la extensión.
router.get('/races/:id/shifts/report',      ControlController.shiftsReport);
router.get('/races/:id/shifts/report.html', ControlController.shiftsReportHtml);
router.get('/races/:id/shifts/report.xlsx', ControlController.shiftsReportExcel);

// ── Le Mans classification board ──────────────────────────────────────────────
router.get( '/races/:id/lemans',       SessionController.lemans);

// ── Results ───────────────────────────────────────────────────────────────────
router.get( '/races/:id/results',      SessionController.results);
router.get( '/races/:id/results/export.html', SessionController.exportResults);
router.get( '/races/:id/results/xlsx', SessionController.excel);
router.get( '/races/:id/results/points.xlsx', SessionController.pointsExcel);
router.get( '/races/:id/results/points.csv',  SessionController.pointsCsv);
router.get( '/races/:id/results/control.csv', SessionController.controlCsv);
router.post('/races/:id/complete',     RaceController.complete);

// ── Pole position ─────────────────────────────────────────────────────────────
router.get( '/races/:id/pole/setup',             PoleController.setup);
router.post('/races/:id/pole/start',             PoleController.startPole);
router.get( '/races/:id/pole/timing',            PoleController.timing);
router.post('/races/:id/pole/participant/start', PoleController.startParticipant);
router.post('/races/:id/pole/participant/stop',  PoleController.stopParticipant);
router.post('/races/:id/pole/next',              PoleController.advanceParticipant);
router.post('/races/:id/pole/omit-first',        PoleController.setOmitFirstCrossing);
router.get( '/races/:id/pole/results',           PoleController.results);
router.post('/races/:id/pole/times',             PoleController.saveTimes);
router.get( '/races/:id/pole/lanes',             PoleController.laneSelection);
router.post('/races/:id/pole/lanes',             PoleController.assignLanes);

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
router.get(   '/races/:id/edit', RaceController.editForm);
router.post(  '/races/:id/edit', RaceController.update);
router.get(   '/races/:id',      RaceController.show);
router.delete('/races/:id',      RaceController.delete);

// ── Driver profiles ───────────────────────────────────────────────────────────
router.get(   '/drivers',           DriverProfileController.index);
router.get(   '/drivers/new',       DriverProfileController.newForm);
router.post(  '/drivers',           DriverProfileController.create);
router.post(  '/drivers/import/preview', DriverProfileController.importPreview);
router.post(  '/drivers/import',    DriverProfileController.importConfirm);
router.get(   '/drivers/qr-all',    DriverProfileController.qrAll);
router.get(   '/drivers/:id/qr',    DriverProfileController.qrPage);
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

router.get(   '/teams',            TeamCatalogController.index);
router.get(   '/teams/new',        TeamCatalogController.newForm);
router.post(  '/teams/import/preview', TeamCatalogController.importPreview);
router.post(  '/teams/import',     TeamCatalogController.importConfirm);
router.post(  '/teams',            TeamCatalogController.create);
router.get(   '/teams/:id/edit',   TeamCatalogController.editForm);
router.post(  '/teams/:id',        TeamCatalogController.update);
router.post(  '/teams/:id/delete', TeamCatalogController.delete);

router.post('/api/teams-catalog/quick', TeamCatalogController.quickCreate);

// ── Training ──────────────────────────────────────────────────────────────────
router.get( '/training',                      TrainingController.index);
router.get( '/training/free',                 TrainingController.free);
router.get( '/training/competition',          TrainingController.competition);
router.post('/training/competition/start',    TrainingController.competitionStart);
router.get( '/training/competition/live',     TrainingController.competitionLive);
router.post('/training/competition/stop',     TrainingController.competitionStop);
router.get( '/training/competition/results',  TrainingController.competitionResults);
router.get( '/training/competition/results/:sessionId', TrainingController.competitionResultsShow);
router.post('/training/competition/results/:sessionId/delete', TrainingController.competitionResultsDelete);
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

// ── Túnel público (Cloudflare del propio club) — control LAN-only ────────────
const TunnelController = require('../controllers/TunnelController');
router.get( '/tunnel/status', TunnelController.status);
router.post('/tunnel/start',  TunnelController.start);
router.post('/tunnel/stop',   TunnelController.stop);
router.post('/tunnel/install', TunnelController.install);  // descarga cloudflared (opcional)

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

// ── Endpoints de banco de pruebas (DESACTIVADOS por defecto) ─────────────────
//
// `/api/test/stop` acaba llamando a TimingService.cancelManga(), que BORRA todas
// las vueltas de la manga activa — pueden ser horas de carrera. Al ser un GET sin
// autenticación, bastaba con que el navegador del PC de control abriera una
// página cualquiera con <img src="http://localhost:3000/api/test/stop"> para
// tirar la carrera: un `img` dispara el GET solo. Y cualquier tablet de la
// allowlist podía llamarlos a mano.
//
// Se activan solo con PITWALL_TEST_ENDPOINTS=1, que es como se lanza el banco.
// Nunca en la máquina de cronometraje de una carrera real.
if (process.env.PITWALL_TEST_ENDPOINTS === '1') {
  console.warn('[routes] ⚠ Endpoints de prueba ACTIVOS (/api/test/*, /api/rawlog) — no usar en carrera');

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

  // Volcado del puerto serie en crudo. No destruye nada, pero expone tráfico.
  router.get('/api/rawlog', (req, res) => {
    const SerialService = require('../services/SerialService');
    const log = SerialService.getRawLog();
    const hex = log.map(e => e.byte.toString(16).padStart(2, '0'));
    res.json({ count: hex.length, bytes: hex, raw: log });
  });
}

// ── PitWall Lap — cliente web del equipo (resistencia) ──────────────────────
// Rutas PÚBLICAS (accesibles desde el móvil de cualquier equipo): el acceso real
// a los datos lo gatea el PIN por equipo (sesión). Ver accessControl.isPublicPath.
router.get( '/lap',                              LapController.index);
router.post('/lap/:raceId/login',                LapController.login);
router.get( '/lap/:raceId/team/:teamId',         LapController.teamView);
// Hoja de PINs para la organización: vive en el espacio público /lap (no bajo
// /races) para que sea accesible desde la red del evento aunque el modo
// restringido esté activo. Ver accessControl.isPublicPath.
router.get( '/lap/:raceId/pins',                 LapController.pinsPage);
router.post('/lap/:raceId/pins/:teamId/regenerate', LapController.regeneratePin);
router.get( '/lap/:raceId',                      LapController.selectRace);
router.get( '/api/lap/:raceId/team/:teamId',     LapController.teamSnapshot);

module.exports = router;
