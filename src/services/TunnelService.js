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
// Seguimiento público por internet: PitWall gestiona un túnel de Cloudflare
// PROPIO de cada club/instalación (no depende de ninguna cuenta central).
// Dos modos, configurables en Ajustes:
//   - 'quick': túnel rápido de prueba (URL aleatoria *.trycloudflare.com).
//     No requiere cuenta ni dominio. La URL cambia en cada arranque.
//   - 'token': túnel con nombre del PROPIO club (cuenta Cloudflare + dominio).
//     Se crea en el dashboard de Cloudflare (Zero Trust → Tunnels) apuntando a
//     http://localhost:3000 y se pega aquí el token del conector.
// El acceso sigue gateado por accessControl: por el túnel solo se alcanzan las
// vistas públicas (isPublicPath); el control responde 403 (trust proxy).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Settings = require('../models/Settings');

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const LOG_MAX = 30;

// Rutas típicas del binario (las apps GUI de macOS no heredan el PATH del
// shell, así que 'cloudflared' a secas puede no resolverse en Electron).
const COMMON_PATHS = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
];

// Binario gestionado por PitWall: si el club pulsa "Instalar cloudflared", se
// descarga el release oficial a la carpeta de datos y se usa desde ahí.
function managedDir() {
  const base = process.env.SLOTIME_DATA || path.join(__dirname, '../../database');
  return path.join(base, 'bin');
}
function managedPath() {
  return path.join(managedDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

// Asset oficial según SO/arquitectura (releases de cloudflare/cloudflared).
function releaseAsset() {
  const arm = process.arch === 'arm64';
  if (process.platform === 'darwin') return arm ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (process.platform === 'win32')  return arm ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  return arm ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
}

class TunnelService {
  constructor() {
    this.child = null;
    this.publicUrl = null;   // quick: URL trycloudflare detectada
    this.lastError = null;
    this.log = [];
    this.startedAt = null;
    this.installing = false;
    this.installError = null;
  }

  _cfg() {
    return {
      mode:      Settings.get('tunnel_mode', 'off'),          // off | quick | token
      token:     String(Settings.get('tunnel_token', '') || '').trim(),
      hostname:  String(Settings.get('tunnel_hostname', '') || '').trim(), // solo informativo (modo token)
      autostart: Settings.get('tunnel_autostart', '0') === '1',
      binary:    String(Settings.get('tunnel_binary', '') || '').trim(),
    };
  }

  // Localiza el binario cloudflared: override de Ajustes → binario gestionado
  // (instalado por PitWall) → rutas típicas → PATH.
  resolveBinary() {
    const { binary } = this._cfg();
    if (binary) return fs.existsSync(binary) ? binary : null;
    try { if (fs.existsSync(managedPath())) return managedPath(); } catch {}
    for (const p of COMMON_PATHS) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return 'cloudflared'; // confiar en el PATH (el spawn fallará con ENOENT si no está)
  }

  binaryFound() {
    const { binary } = this._cfg();
    if (binary) return fs.existsSync(binary);
    try { if (fs.existsSync(managedPath())) return true; } catch {}
    if (COMMON_PATHS.some(p => { try { return fs.existsSync(p); } catch { return false; } })) return true;
    // Último recurso: buscar en el PATH.
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      require('child_process').execSync(`${which} cloudflared`, { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }

  // Descarga el release oficial de cloudflared para este SO/arquitectura a la
  // carpeta de datos de PitWall (no toca el sistema; sin permisos de admin).
  async install() {
    if (this.installing) return this.status();
    if (this.binaryFound()) { this.installError = null; return this.status(); }
    this.installing = true;
    this.installError = null;
    try {
      if (typeof fetch !== 'function') throw new Error('Se necesita Node 18+ para descargar.');
      const asset = releaseAsset();
      const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
      console.log(`[tunnel] descargando ${url}`);
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`Descarga fallida (HTTP ${r.status}).`);
      const buf = Buffer.from(await r.arrayBuffer());

      fs.mkdirSync(managedDir(), { recursive: true });
      const dest = managedPath();
      if (asset.endsWith('.tgz')) {
        // macOS: el release es un .tgz con el binario dentro → extraer con tar.
        const tmp = path.join(os.tmpdir(), asset);
        fs.writeFileSync(tmp, buf);
        const tar = spawnSync('tar', ['-xzf', tmp, '-C', managedDir()], { timeout: 60000 });
        try { fs.unlinkSync(tmp); } catch {}
        if (tar.status !== 0) throw new Error('No se pudo extraer el paquete descargado.');
      } else {
        fs.writeFileSync(dest, buf);
      }
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);

      // Comprobación: el binario responde a --version.
      const v = spawnSync(dest, ['--version'], { timeout: 20000 });
      if (v.status !== 0) throw new Error('El binario descargado no se puede ejecutar.');
      console.log(`[tunnel] cloudflared instalado en ${dest} (${String(v.stdout).trim()})`);
    } catch (e) {
      this.installError = `No se pudo instalar cloudflared: ${e.message}`;
      console.warn('[tunnel]', this.installError);
    } finally {
      this.installing = false;
    }
    return this.status();
  }

  _pushLog(line) {
    const s = String(line).trim();
    if (!s) return;
    this.log.push(s);
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  isRunning() { return !!this.child; }

  status() {
    const cfg = this._cfg();
    return {
      running:   this.isRunning(),
      mode:      cfg.mode,
      autostart: cfg.autostart,
      hostname:  cfg.hostname || null,
      // quick: URL detectada; token: el hostname que configuró el club.
      publicUrl: this.isRunning()
        ? (cfg.mode === 'quick' ? this.publicUrl : (cfg.hostname ? `https://${cfg.hostname}` : null))
        : null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      binaryFound: this.binaryFound(),
      installing: this.installing,
      installError: this.installError,
      log: this.log.slice(-8),
    };
  }

  start() {
    if (this.isRunning()) return this.status();
    const cfg = this._cfg();
    this.lastError = null;
    this.publicUrl = null;
    this.log = [];

    if (cfg.mode === 'off') {
      this.lastError = 'El túnel está desactivado en Ajustes.';
      return this.status();
    }
    if (cfg.mode === 'token' && !cfg.token) {
      this.lastError = 'Falta el token del túnel (Cloudflare → Zero Trust → Tunnels).';
      return this.status();
    }

    const bin = this.resolveBinary();
    if (!bin) {
      this.lastError = 'No se encuentra cloudflared en la ruta configurada.';
      return this.status();
    }

    const port = parseInt(process.env.PORT || '3000', 10);
    // Config VACÍA explícita: si el usuario tiene un ~/.cloudflared/config.yml
    // (p.ej. de otro túnel suyo), cloudflared lo cargaría por defecto y sus
    // reglas de ingress pisarían a este túnel (todo acabaría en 404). Cada
    // instalación de PitWall debe ser independiente de esa config.
    let emptyCfg = null;
    try {
      emptyCfg = require('path').join(require('os').tmpdir(), 'pitwall-cloudflared.yml');
      fs.writeFileSync(emptyCfg, '# config vacía: PitWall pasa todo por CLI\n');
    } catch { emptyCfg = null; }
    const base = emptyCfg ? ['--config', emptyCfg] : [];
    const args = cfg.mode === 'quick'
      ? [...base, 'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`]
      : [...base, 'tunnel', 'run', '--no-autoupdate', '--token', cfg.token];

    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.lastError = `No se pudo lanzar cloudflared: ${e.message}`;
      return this.status();
    }

    this.child = child;
    this.startedAt = new Date().toISOString();
    console.log(`[tunnel] cloudflared arrancado (pid ${child.pid}, modo ${cfg.mode})`);

    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        if (!line.trim()) continue;
        this._pushLog(line);
        if (cfg.mode === 'quick' && !this.publicUrl) {
          const m = QUICK_URL_RE.exec(line);
          if (m) {
            this.publicUrl = m[0];
            console.log(`[tunnel] URL pública: ${this.publicUrl}`);
          }
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData); // cloudflared escribe el log (y la URL) por stderr

    child.on('error', (e) => {
      this.lastError = e.code === 'ENOENT'
        ? 'cloudflared no está instalado (brew install cloudflared / https://developers.cloudflare.com/cloudflared/).'
        : `Error de cloudflared: ${e.message}`;
      this.child = null;
      this.publicUrl = null;
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        // Salida no pedida (stop() ya lo pone a null antes de matar).
        if (code !== 0 && !this.lastError) {
          this.lastError = `cloudflared terminó (código ${code ?? signal}). Revisa el log.`;
        }
        this.child = null;
        this.publicUrl = null;
        console.log(`[tunnel] cloudflared terminado (${code ?? signal})`);
      }
    });

    return this.status();
  }

  stop() {
    const child = this.child;
    if (!child) return this.status();
    this.child = null;          // marca parada intencionada antes de matar
    this.publicUrl = null;
    this.startedAt = null;
    try { child.kill(); } catch {}
    console.log('[tunnel] cloudflared parado');
    return this.status();
  }

  // Al arrancar el servidor: levanta el túnel si el club lo dejó en auto.
  autostart() {
    const cfg = this._cfg();
    if (cfg.autostart && cfg.mode !== 'off') {
      setTimeout(() => { try { this.start(); } catch (e) { console.warn('[tunnel] autostart falló:', e.message); } }, 1500);
    }
  }
}

module.exports = new TunnelService();
