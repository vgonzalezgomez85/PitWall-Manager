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
const { app, BrowserWindow, shell } = require('electron');
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const updateLogic = require('./updateLogic');

// Mismo sitio que `build.publish` de package.json (de ahí sale app-update.yml).
// PITWALL_UPDATE_FEED: otro servidor, para probar el ciclo completo en local.
const FEED_OVERRIDE = process.env.PITWALL_UPDATE_FEED || '';
const FEED = FEED_OVERRIDE || 'https://www.pitwall.es/software/pitwall-manager/';
const CHECK_FIRST_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// auto: descarga e instala electron-updater. manual: solo se avisa y se abre
// la web (portable de Windows, .deb, y sin empaquetar).
const mode = updateLogic.updateMode({
  packaged: app.isPackaged, platform: process.platform, env: process.env,
});

let state = {
  status: 'idle',          // idle | checking | none | available | downloading | ready | error
  mode,
  current: app.getVersion(),
  version: null,
  percent: 0,
  error: null,
  checkedAt: null,
};
let hooks = { guard: async () => null, beforeInstall: async () => {} };
let autoUpdater = null;
let logFile = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  if (!app.isPackaged) process.stdout.write('[updater] ' + line);
  if (logFile) fs.appendFile(logFile, line, () => {});
}

function set(patch) {
  state = { ...state, ...patch };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pitwall:update-state', state);
  }
}

function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  if (FEED_OVERRIDE) autoUpdater.setFeedURL({ provider: 'generic', url: FEED_OVERRIDE });
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => { log('descargada', info.version); set({ status: 'ready', percent: 100 }); });
  autoUpdater.on('error', (err) => {
    log('error', err?.message || err);
    if (state.status === 'downloading') set({ status: 'error', error: 'download' });
  });
  return autoUpdater;
}

// La comprobación la hacemos nosotros (un .yml y comparar versiones): así
// funciona igual en los modos auto y manual. electron-updater solo descarga.
async function check() {
  if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
  set({ status: 'checking', error: null });
  try {
    const url = `${FEED}${updateLogic.channelFile(process.platform)}?noCache=${Date.now().toString(32)}`;
    const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const info = yaml.load(await r.text());
    if (!info || typeof info.version !== 'string') throw new Error('respuesta sin versión');
    const newer = updateLogic.isNewer(info.version, state.current);
    log('comprobado:', info.version, newer ? '(nueva)' : '(al día)');
    set({ status: newer ? 'available' : 'none', version: newer ? info.version : null, checkedAt: Date.now() });
  } catch (err) {
    log('no se pudo comprobar:', err.message);
    set({ status: 'error', error: 'check', checkedAt: Date.now() });
  }
  return state;
}

async function download() {
  if (mode !== 'auto' || state.status !== 'available') return state;
  set({ status: 'downloading', percent: 0, error: null });
  try {
    const u = getAutoUpdater();
    const res = await u.checkForUpdates();
    if (!res || !res.isUpdateAvailable) { set({ status: 'none', version: null }); return state; }
    await u.downloadUpdate();
  } catch (err) {
    log('descarga:', err?.message || err);
    set({ status: 'error', error: 'download' });
  }
  return state;
}

async function install() {
  if (mode !== 'auto' || state.status !== 'ready') return { ok: false, reason: 'not_ready' };
  const busy = await hooks.guard();
  if (busy) return { ok: false, reason: 'busy', busy };
  try {
    await hooks.beforeInstall(state.current);
  } catch (err) {
    log('antes de instalar:', err.message);
    return { ok: false, reason: 'backup' };
  }
  log('instalando', state.version);
  setImmediate(() => getAutoUpdater().quitAndInstall(false, true));
  return { ok: true };
}

function openDownloadPage(lang) {
  shell.openExternal(updateLogic.downloadPage(lang));
}

function init(opts) {
  hooks = { ...hooks, ...opts };
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'updater.log');
  } catch {}
  setTimeout(() => { check(); setInterval(check, CHECK_EVERY_MS); }, CHECK_FIRST_MS);
}

module.exports = { init, check, download, install, openDownloadPage, getState: () => state };
