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
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, ipcMain, screen } = require('electron');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const fs     = require('fs');
const net    = require('net');
const { fork } = require('child_process');
const placement = require('./windowPlacement');

const PORT = parseInt(process.env.PORT || '3000', 10);
let mainWindow = null;
let tray       = null;
let serverProc = null;

// ── Permitir audio sin gesto del usuario ──────────────────────────────────────
// Necesario para que el semáforo F1 (showSemaphore + beeps) suene aunque
// el GO entre por el DS-300 sin que se haya tocado nada en la ventana.
// IMPORTANTE: este flag debe aplicarse ANTES de app.whenReady().
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });

// ── Generate PNG icon in pure Node.js (no extra deps) ────────────────────────
function createAppIcon(size = 32) {
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0; // filter: None
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = 246; row[1 + x * 3 + 1] = 201; row[1 + x * 3 + 2] = 14; // #F6C90E
  }
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const T = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k=0; k<8; k++) c = (c&1)?(0xEDB88320^(c>>>1)):(c>>>1); T[i]=c; }
  const crc = b => { let c=0xFFFFFFFF; for (const v of b) c=T[(c^v)&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };
  const ch = (t, d) => { const tb=Buffer.from(t,'ascii'); const l=Buffer.alloc(4); l.writeUInt32BE(d.length); const c=Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([tb,d]))); return Buffer.concat([l,tb,d,c]); };
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(size,0); hdr.writeUInt32BE(size,4); hdr[8]=8; hdr[9]=2;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    ch('IHDR',hdr), ch('IDAT',idat), ch('IEND',Buffer.alloc(0))
  ]));
}

// ── Wait until TCP port accepts connections ───────────────────────────────────
function waitForPort(port, tries = 50) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const check = () => {
      const s = new net.Socket();
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error',   () => { s.destroy(); ++n < tries ? setTimeout(check, 300) : reject(new Error('Timeout')); });
      s.connect(port, '127.0.0.1');
    };
    check();
  });
}

// ── Persistent session secret ─────────────────────────────────────────────────
function getOrCreateSecret(userData) {
  const f = path.join(userData, '.session_secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(f, s);
    return s;
  }
}

// ── Migración de datos Voltrace Manager → PitWall ────────────────────────────
// El renombrado de la app cambió la carpeta userData (en Windows:
// %APPDATA%\Voltrace Manager → %APPDATA%\PitWall). Si la nueva carpeta aún no
// tiene base de datos y la antigua existe, copiamos la BD (con su -wal/-shm),
// el secreto de sesión y los logs para no perder carreras ni configuración.
// La carpeta antigua se conserva como respaldo (no se borra).
function migrateLegacyUserData(userData) {
  try {
    const newDb = path.join(userData, 'pitwall.db');
    if (fs.existsSync(newDb) || fs.existsSync(path.join(userData, 'slotime.db'))) return; // ya hay datos en PitWall — nada que hacer
    const oldDir = path.join(path.dirname(userData), 'Voltrace Manager');
    if (!fs.existsSync(path.join(oldDir, 'slotime.db'))) return;
    fs.mkdirSync(userData, { recursive: true });
    for (const f of ['slotime.db', 'slotime.db-wal', 'slotime.db-shm']) {
      const src = path.join(oldDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, f.replace('slotime.db', 'pitwall.db')));
    }
    { // .session_secret no lleva el nombre de la BD, se copia tal cual
      const src = path.join(oldDir, '.session_secret');
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, '.session_secret'));
    }
    const oldLogs = path.join(oldDir, 'logs');
    if (fs.existsSync(oldLogs)) {
      fs.cpSync(oldLogs, path.join(userData, 'logs'), { recursive: true, force: false });
    }
    console.log('[PitWall] Datos migrados desde "Voltrace Manager":', oldDir, '→', userData);
  } catch (err) {
    console.error('[PitWall] Error migrando datos antiguos:', err.message);
  }
}

// ── Start Express as forked child process ─────────────────────────────────────
function startServer(userData) {
  return new Promise((resolve, reject) => {
    serverProc = fork(path.join(__dirname, '..', 'src', 'app.js'), [], {
      env: {
        ...process.env,
        PORT:           String(PORT),
        PITWALL_DATA:   userData,
        SESSION_SECRET: getOrCreateSecret(userData),
      },
      silent: true,
    });

    // Sin esto, un fallo al arrancar solo se veía como «Timeout» y sin rastro en Windows.
    let logStream = null;
    try {
      const logDir = path.join(userData, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'w' });
    } catch {}
    let tail = '';
    const pipe = (src, dst) => src && src.on('data', (chunk) => {
      if (!app.isPackaged) { try { dst.write(chunk); } catch {} }
      if (logStream) logStream.write(chunk);
      tail = (tail + chunk.toString()).slice(-1500);
    });
    pipe(serverProc.stdout, process.stdout);
    pipe(serverProc.stderr, process.stderr);

    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    serverProc.on('error', fail);
    serverProc.once('exit', (code, signal) => {
      fail(new Error(`El servidor se cerró al arrancar (código ${code ?? signal}).\n\n${tail.trim()}`));
    });
    waitForPort(PORT, 200).then(() => { if (!settled) { settled = true; resolve(); } }).catch(fail);
  });
}

// ── Load packaged icon (build/icon.png) with fallback to generated solid ─────
// In production (asar-packed), the file is at process.resourcesPath/../build.
// In dev, it's at <repo>/build/icon.png.
function loadAppIcon() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'app', 'build', 'icon.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch {}
  }
  // Fallback: solid colour PNG generated in pure Node (legacy behaviour)
  return nativeImage.createFromBuffer(createAppIcon(256));
}

// ── Main window ───────────────────────────────────────────────────────────────
function windowOptions() {
  return {
    backgroundColor: '#0a0d13',
    icon: loadAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Permite que el AudioContext / <audio>.play() arranquen sin gesto del
      // usuario. Combinado con app.commandLine.appendSwitch arriba garantiza
      // que los pitidos del semáforo suenen al primer GO de la sesión.
      autoplayPolicy: 'no-user-gesture-required',
    },
  };
}

function createWindow(query = '') {
  mainWindow = new BrowserWindow({
    ...windowOptions(),
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'PitWall',
  });
  mainWindow.setMenuBarVisibility(false);
  trackFullScreen(mainWindow);
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/${query}`);
  mainWindow.on('close', e => { if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
// macOS usa el template (PNG monocromo @2x) para que la barra de menús lo
// renderice adaptado a modo claro/oscuro. Win/Linux usan el PNG blanco.
function loadTrayIcon() {
  const trayDir = path.join(__dirname, '..', 'build', 'tray');
  const altDir  = path.join(process.resourcesPath || '', 'build', 'tray');
  function pick(name) {
    for (const base of [trayDir, altDir]) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  if (process.platform === 'darwin') {
    const tplPath = pick('pitwallTemplate.png');
    if (tplPath) {
      const img = nativeImage.createFromPath(tplPath);
      img.setTemplateImage(true);
      return img;
    }
  }
  const pngPath = pick('tray-white-32.png') || pick('tray-white-22.png');
  if (pngPath) return nativeImage.createFromPath(pngPath);
  // Fallback al icono general redimensionado
  return loadAppIcon().resize({ width: 32, height: 32 });
}

function createTray() {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('PitWall');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir PitWall', click: () => mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow() },
    { label: 'Abrir en navegador',     click: () => shell.openExternal(`http://127.0.0.1:${PORT}`) },
    { type: 'separator' },
    { label: 'Salir',                  click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow());
}

// Ver preload.js: devuelve el foco de teclado tras un diálogo nativo (fallo de
// Electron en Windows). En macOS no pasa y el blur/focus haría parpadear.
ipcMain.on('pitwall:refocus', (e) => {
  if (process.platform === 'darwin') return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  win.blur();
  win.focus();
  e.sender.focus();
});

// ── Ventanas secundarias ──────────────────────────────────────────────────────
// La home abre cada sección en su propia ventana (window.open con nombre fijo)
// para poder seguir trabajando con una manga en marcha. Sin este handler
// Electron las crearía con la barra de menú y sin el preload. Lo que no es del
// servidor local (GitHub, manuales…) va al navegador del sistema.
const isAppUrl = (url) => url === 'about:blank' || url.startsWith(`http://127.0.0.1:${PORT}/`) || url === `http://127.0.0.1:${PORT}`;

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    }
    const place = placementFor(url);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: childWindowOptions(place),
    };
  });
  contents.on('did-create-window', (win, details) => {
    win.setMenuBarVisibility(false);
    trackFullScreen(win);
    const place = placementFor(details.url);
    if (place) showPlaced(win, place);
    else if (!win.isVisible()) win.show();
  });
});

// ── Ventanas por pantalla (Ajustes → Ventanas y pantallas) ───────────────────
// Se guarda en la carpeta de datos de la app y no en la BD: los monitores son
// de cada ordenador, y la BD viaja (exportar, restaurar en otro equipo…).
let placementFile = null;
const CHILD_SIZE = { width: 1280, height: 860 };

function loadPlacement() {
  try { return placement.sanitize(JSON.parse(fs.readFileSync(placementFile, 'utf8'))); }
  catch { return placement.sanitize({}); }
}

function savePlacement(prefs) {
  const clean = placement.sanitize(prefs);
  fs.writeFileSync(placementFile, JSON.stringify(clean, null, 2));
  return clean;
}

function orderedDisplays() {
  return placement.orderDisplays(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
}

function placementFor(url) {
  const type = placement.classify(url);
  if (!type || !placementFile) return null;
  return placement.resolve(loadPlacement(), type, screen.getAllDisplays(), screen.getPrimaryDisplay().id, CHILD_SIZE);
}

function childWindowOptions(place) {
  return {
    ...windowOptions(), ...CHILD_SIZE, minWidth: 700, minHeight: 500,
    ...(place ? { ...place.bounds, show: false } : {}),
  };
}

// La ventana nace oculta y se enseña ya en su pantalla. Si la página no pinta
// en 3 s se enseña igual: una ventana que nunca aparece parece la app colgada.
// La posición se vuelve a fijar al enseñarla porque en Windows, con escalas
// distintas por monitor, la del constructor puede salir corrida.
function showPlaced(win, place) {
  let done = false;
  const go = () => {
    if (done || win.isDestroyed()) return;
    done = true;
    win.setBounds(place.bounds);
    win.show();
    if (place.mode === 'maximized') win.maximize();
    else if (place.mode === 'fullscreen') win.setFullScreen(true);
  };
  win.once('ready-to-show', go);
  setTimeout(go, 3000);
}

ipcMain.handle('pitwall:screens', () =>
  orderedDisplays().map((d, i) => ({
    n: i + 1, label: d.label || '', width: d.size.width, height: d.size.height, internal: !!d.internal,
  })));

ipcMain.handle('pitwall:placement', (_e, prefs) => (prefs === undefined ? loadPlacement() : savePlacement(prefs)));

// Un número grande en cada pantalla durante 3 s, para saber cuál es cuál.
ipcMain.handle('pitwall:screens-identify', () => {
  orderedDisplays().forEach((d, i) => {
    const size = 320;
    const win = new BrowserWindow({
      x: Math.round(d.bounds.x + (d.bounds.width - size) / 2),
      y: Math.round(d.bounds.y + (d.bounds.height - size) / 2),
      width: size, height: size,
      frame: false, transparent: true, resizable: false, movable: false, focusable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    });
    const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;' +
      'background:rgba(10,13,19,.88);border-radius:28px;color:#F6C90E;font:700 200px/1 system-ui,sans-serif">' + (i + 1);
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.once('ready-to-show', () => win.showInactive());
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 3000);
  });
  return true;
});

// Entreno libre al arrancar. Con una carrera o una pole en curso no se abre:
// entrar en el entreno lo arma para el próximo GO, y ese GO es de la carrera.
async function trainingAutostart() {
  if (!loadPlacement().training.autostart) return {};
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/windows/startup`);
    const d = await r.json();
    return d.busy ? { skipped: true } : { open: true };
  } catch { return {}; }
}

// Pantalla completa de la VENTANA, no la del documento: la del documento
// (Fullscreen API) se pierde en cada recarga y el directo se recarga tras el
// semáforo, al acabar la manga, en pausa… La de la ventana sobrevive.
// El estado sale del evento y no de isFullScreen(): en Windows el evento llega
// antes de que isFullScreen() cambie, y el directo creía seguir sin pantalla
// completa (el botón ya no sabía salir).
function trackFullScreen(win) {
  const notify = (on) => () => { if (!win.isDestroyed()) win.webContents.send('pitwall:fullscreen-changed', on); };
  win.on('enter-full-screen', notify(true));
  win.on('leave-full-screen', notify(false));
}

ipcMain.handle('pitwall:fullscreen', (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return false;
  if (typeof on !== 'boolean' || win.isFullScreen() === on) return win.isFullScreen();
  // Resuelve al terminar la transición (en macOS es una animación de cambio de
  // Space): quien abre una ventana justo después necesita que haya acabado.
  return new Promise((resolve) => {
    const t = setTimeout(() => { win.removeListener(evt, onEvt); resolve(!win.isDestroyed() && win.isFullScreen()); }, 1500);
    const evt = on ? 'enter-full-screen' : 'leave-full-screen';
    const onEvt = () => { clearTimeout(t); resolve(on); };
    win.once(evt, onEvt);
    win.setFullScreen(on);
  });
});

ipcMain.handle('pitwall:windows', () =>
  BrowserWindow.getAllWindows()
    .filter(w => w !== mainWindow && !w.isDestroyed())
    .map(w => ({ id: w.id, title: w.getTitle(), name: windowNames.get(w.id) || null })));

// Ventanas de la home por nombre. Se gestionan aquí y no con window.open(url,
// nombre): con el nombre, Electron devolvía la ventana vieja aunque el usuario
// hubiera navegado en ella (p. ej. «Volver» al inicio) y solo la enfocaba, así
// que la sección parecía no abrirse hasta cerrar esa ventana a mano.
const namedWindows = new Map();   // nombre → BrowserWindow
const windowNames  = new Map();   // id → nombre

function sameSection(currentUrl, target) {
  try {
    const cur = new URL(currentUrl).pathname.replace(/\/+$/, '') || '/';
    const tgt = new URL(target).pathname.replace(/\/+$/, '') || '/';
    return tgt !== '/' && (cur === tgt || cur.startsWith(tgt + '/'));
  } catch { return false; }
}

function bringToFront(win) {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

ipcMain.handle('pitwall:open-window', (_e, url, name) => {
  if (typeof url !== 'string' || typeof name !== 'string') return false;
  const target = new URL(url, `http://127.0.0.1:${PORT}`).href;
  if (!isAppUrl(target)) return false;
  let win = namedWindows.get(name);
  if (win && !win.isDestroyed()) {
    if (!sameSection(win.webContents.getURL(), target)) win.loadURL(target);
    bringToFront(win);
    return true;
  }
  openNamedWindow(target, name);
  return true;
});

function openNamedWindow(target, name) {
  const place = placementFor(target);
  const win = new BrowserWindow(childWindowOptions(place));
  win.setMenuBarVisibility(false);
  trackFullScreen(win);
  namedWindows.set(name, win);
  windowNames.set(win.id, name);
  const id = win.id;
  win.on('closed', () => { namedWindows.delete(name); windowNames.delete(id); });
  win.loadURL(target);
  if (place) showPlaced(win, place);
}

ipcMain.handle('pitwall:window-focus', (_e, id) => {
  const win = BrowserWindow.fromId(Number(id));
  if (!win || win.isDestroyed() || win === mainWindow) return false;
  bringToFront(win);
  return true;
});

ipcMain.handle('pitwall:window-close', (_e, id) => {
  const win = BrowserWindow.fromId(Number(id));
  if (!win || win.isDestroyed() || win === mainWindow) return false;
  win.close();
  return true;
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  migrateLegacyUserData(userData);
  try {
    await startServer(userData);
  } catch (err) {
    dialog.showErrorBox('PitWall', `No se pudo iniciar el servidor:\n${err.message}`);
    app.quit();
    return;
  }
  placementFile = path.join(userData, 'window-placement.json');
  createTray();
  const startup = await trainingAutostart();
  createWindow(startup.skipped ? '?notice=training_skipped' : '');
  // Mismo nombre que da el inicio a «Entreno libre»: un clic luego la trae al frente.
  if (startup.open) openNamedWindow(`http://127.0.0.1:${PORT}/training/free`, 'pw-training');
});

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('activate', () => mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow());
app.on('before-quit', () => { app.isQuiting = true; });
app.on('will-quit',   () => { serverProc?.kill(); });
