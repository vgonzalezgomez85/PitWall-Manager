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

const app    = express();
// Confía SOLO en el proxy de loopback (127.0.0.1): un túnel público
// (cloudflared/ngrok) corre en la misma máquina y reenvía a localhost, así que
// sin esto TODA petición del túnel llegaría como 127.0.0.1 y el control de
// acceso la trataría como local/admin → expondría el control a internet. Con
// 'loopback', Express lee el X-Forwarded-For que pone el túnel y req.ip pasa a
// ser la IP real del cliente remoto, de modo que restrictAccess vuelve a
// bloquear todo salvo las vistas públicas. Los clientes de la LAN conectan
// directos (peer != loopback) y NO pueden falsear XFF, así que no cambian.
app.set('trust proxy', 'loopback');

// Versión de la app (package.json = fuente única). Visible en el pie de todas
// las páginas, enlazando al historial /changelog.
app.locals.appVersion = require('../package.json').version;

const server = http.createServer(app);

// Socket.io must be initialised before routes import services that need it
const SocketService = require('./services/SocketService');
SocketService.init(server);

const SettingsModel = require('./models/Settings');
const DebugLogger   = require('./services/DebugLogger');
DebugLogger.setEnabled(SettingsModel.get('debug_mode', '0') === '1');

const SerialService = require('./services/SerialService');
SerialService.init(); // start with saved settings (or simulation if not configured)

// ── Infolap server (opt-in en Settings) ────────────────────────────────────────
// Emula el protocolo Tic Tac Slot Infolap para que la app Android legacy se
// pueda conectar a PitWall y recibir vueltas en vivo. Es OPT-IN porque
// ocupa el puerto UDP 4441 y no lo queremos abierto si nadie lo usa.
const InfolapServer = require('./services/InfolapServer');
if (SettingsModel.get('infolap_enabled', '0') === '1') {
  try { InfolapServer.start(); }
  catch (e) { console.error('[Infolap] no se pudo arrancar:', e.message); }
}

// ── DS hardware GO/STOP ────────────────────────────────────────────────────────
const TimingService  = require('./services/TimingService');
const TrainingService = require('./services/TrainingService');

// ── Race Link (maestro↔esclavo) ────────────────────────────────────────────────
// Solo el MAESTRO necesita init: empuja el estado deseado por LAN. El esclavo
// reacciona a POST /link/state, no arranca nada. Detrás del flag link_role:
// con 'off' (default) NADA de esto se activa. Best-effort.
if (SettingsModel.get('link_role', 'off') === 'master') {
  try { require('./services/RaceLinkService').startMaster(); }
  catch (e) { console.error('[RaceLink] no se pudo arrancar el maestro:', e.message); }
}

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
  // Reset del estado por-carril en el server Infolap para que los clientes
  // Android vean los carriles como "primer reporte" en cada manga nueva.
  if (InfolapServer.isRunning) InfolapServer.resetSession();

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
  // EXCEPCIÓN: en una carrera simulada el GO viene del reproductor (no de una
  // caja DS real), así que no exigimos un navegador en la vista en vivo.
  if (!SerialService._simReplay && !SocketService.hasLocalLiveViewer()) {
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

// Expose serial status and flash messages to all views
app.use((req, res, next) => {
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

// Control de acceso "blando": bloquea la web salvo localhost + allowlist.
// Exime /api/mobile/* (app móvil) y rutas públicas. socket.io e Infolap aparte.
const accessControl = require('./middleware/accessControl');
app.use(accessControl.annotateAccess);   // res.locals.isAdminAccess / isGuestAccess
app.use(accessControl.restrictAccess);

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
  // Interfaz de red elegida en Settings (vacío = todas). Si la interfaz ya no
  // existe (cambió la red), fallback a TODAS para que el server arranque igual.
  const net      = require('./utils/network');
  const Settings = require('./models/Settings');
  const bindIface = Settings.get('server_bind_iface', '');
  const bindIp    = bindIface ? net.ipOfInterface(bindIface) : null;
  const listenArgs = bindIp ? [PORT, bindIp] : [PORT];

  server.listen(...listenArgs, () => {
    if (bindIface && !bindIp) {
      console.warn(`  [Red] Interfaz "${bindIface}" no encontrada → escuchando en TODAS las interfaces`);
    } else if (bindIp) {
      console.log(`  [Red] Atado solo a la interfaz "${bindIface}" (${bindIp})`);
    }
    console.log(`\n  PitWall running at http://localhost:${PORT}`);
    const ips = net.serverIPs(bindIface);
    if (ips.length) {
      console.log(`  En la red:  ${ips.map(i => `http://${i.ip}:${PORT} (${i.name})`).join('   ')}`);
    }
    console.log('');
    announceBonjour(PORT);
  });
}

function announceBonjour(port) {
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    // OJO: el `type` se mantiene como 'voltrace-manager' a propósito — es el
    // identificador de servicio que busca la app Android Infolap para
    // descubrir el servidor; cambiarlo rompería esa integración.
    bonjour.publish({ name: 'PitWall', type: 'voltrace-manager', port });
    console.log(`  [mDNS] PitWall announced on local network (port ${port})\n`);
    process.on('exit', () => bonjour.destroy());
  } catch (e) {
    console.warn('  [mDNS] Could not start Bonjour:', e.message);
  }
}
