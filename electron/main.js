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
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const fs     = require('fs');
const net    = require('net');
const { fork } = require('child_process');

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
      silent: false,
    });
    serverProc.on('error', reject);
    waitForPort(PORT).then(resolve).catch(reject);
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
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'PitWall',
    backgroundColor: '#0a0d13',
    icon: loadAppIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Permite que el AudioContext / <audio>.play() arranquen sin gesto del
      // usuario. Combinado con app.commandLine.appendSwitch arriba garantiza
      // que los pitidos del semáforo suenen al primer GO de la sesión.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
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
  createTray();
  createWindow();
});

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('activate', () => mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow());
app.on('before-quit', () => { app.isQuiting = true; });
app.on('will-quit',   () => { serverProc?.kill(); });
