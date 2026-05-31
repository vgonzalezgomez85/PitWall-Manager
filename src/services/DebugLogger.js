'use strict';

const fs   = require('fs');
const path = require('path');

// En Electron packageado (Windows / macOS firmado), la carpeta del proyecto
// va dentro de un `.asar` de solo lectura. Tenemos que escribir en una
// carpeta de datos del usuario. main.js pasa SLOTIME_DATA al fork con
// `app.getPath('userData')`:
//   Windows: C:\Users\<user>\AppData\Roaming\Voltrace Manager\logs\debug\
//   macOS:   ~/Library/Application Support/Voltrace Manager/logs/debug/
//   Linux:   ~/.config/Voltrace Manager/logs/debug/
// En dev (node src/app.js) caemos al fallback de la raíz del proyecto.
const DATA_BASE = process.env.SLOTIME_DATA || path.join(__dirname, '..', '..');
const LOG_DIR   = path.join(DATA_BASE, 'logs', 'debug');

// Singleton debug logger. Writes per-manga `.jsonl` and `.log` files when
// enabled via Settings (`debug_mode = '1'`). Until a manga is started, events
// are buffered into a "session" file pair so server-level activity is captured.
//
// Public API:
//   isEnabled()                — boolean
//   setEnabled(bool)           — toggle live; closes streams on disable
//   startMangaLog(manga, race) — rotates current streams to a new manga pair
//   endMangaLog()              — closes current streams, returns to session log
//   log(category, payload)     — write an event (no-op if disabled)
//   logError(origin, err)      — convenience for caught exceptions
class DebugLogger {
  constructor() {
    this._enabled  = false;
    this._jsonl    = null;   // WriteStream for .jsonl
    this._log      = null;   // WriteStream for .log
    this._filePath = null;   // base path (no ext) of current pair
    this._context  = null;   // { mangaId, raceId, mangaNumber }
  }

  isEnabled() { return this._enabled; }

  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (on) {
      this._openSessionLog();
      this.log('debug', { event: 'debug_enabled' });
    } else {
      this.log('debug', { event: 'debug_disabled' });
      this._close();
    }
  }

  startMangaLog(manga, race) {
    if (!this._enabled) return;
    this._close();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const raceId   = race?.id ?? 'noRace';
    const mangaId  = manga?.id ?? 'noManga';
    const mangaNum = manga?.number ?? '?';
    const base = path.join(LOG_DIR, `manga-r${raceId}-m${mangaId}-${ts}`);
    this._openPair(base);
    this._context = { mangaId, raceId, mangaNumber: mangaNum };
    this.log('manga', { event: 'log_open', mangaId, raceId, mangaNumber: mangaNum, raceName: race?.name ?? null });
  }

  endMangaLog() {
    if (!this._enabled) return;
    this.log('manga', { event: 'log_close', ...(this._context || {}) });
    this._close();
    this._context = null;
    this._openSessionLog();
  }

  log(category, payload) {
    if (!this._enabled || !this._jsonl) return;
    const now = Date.now();
    const evt = { ts: now, iso: new Date(now).toISOString(), category, ...(this._context || {}), ...payload };
    try {
      this._jsonl.write(JSON.stringify(evt) + '\n');
      this._log.write(this._fmtLine(evt) + '\n');
    } catch (e) {
      // Never let logging crash the app
      console.error('[DebugLogger] write failed:', e.message);
    }
  }

  logError(origin, err) {
    this.log('error', {
      origin,
      message: err?.message ?? String(err),
      stack:   err?.stack ?? null,
    });
  }

  _fmtLine(evt) {
    const { iso, category, ...rest } = evt;
    // Compact human-readable: ISO  [CAT]  key=val key=val ...
    const kv = Object.entries(rest)
      .filter(([k]) => k !== 'ts')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    return `${iso}  [${category.toUpperCase().padEnd(8)}] ${kv}`;
  }

  _openPair(basePath) {
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    this._filePath = basePath;
    this._jsonl = fs.createWriteStream(`${basePath}.jsonl`, { flags: 'a' });
    this._log   = fs.createWriteStream(`${basePath}.log`,   { flags: 'a' });
  }

  _openSessionLog() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this._openPair(path.join(LOG_DIR, `session-${ts}`));
  }

  _close() {
    try { this._jsonl?.end(); } catch {}
    try { this._log?.end();   } catch {}
    this._jsonl = null;
    this._log   = null;
    this._filePath = null;
  }
}

module.exports = new DebugLogger();
