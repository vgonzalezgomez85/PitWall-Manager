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
// Arnés de instantáneas HTML para la extracción de i18n.
//
// POR QUÉ EXISTE: la suite (`npm test`) no renderiza la app — solo
// `test/shifts-report.test.js` compila un EJS de verdad. Convertir ~1.900
// ternarios de idioma a `t()` sin una red de seguridad es ir a ciegas: una
// vista rota no la detecta ningún test. Esto guarda el HTML de cada pantalla
// antes y después, y compara.
//
// Trabaja sobre una COPIA de la BD real (`database/pitwall.db`) hecha con
// `.backup`, nunca sobre la de verdad — la regla del proyecto es no escribir en
// la BD con el servidor abierto, y el arnés arranca el servidor.
//
//   node scripts/i18n-snapshot.js capture --out .tmp/i18n/base
//   node scripts/i18n-snapshot.js compare --a .tmp/i18n/base --b .tmp/i18n/despues
//
// La copia se reutiliza entre capturas mientras no pase `--fresh`, para no
// duplicar 92 MB cada vez.

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const { spawn } = require('child_process');

const ROOT     = path.resolve(__dirname, '..');
const DB_SRC   = path.join(ROOT, 'database', 'pitwall.db');
const WORK_DIR = path.join(ROOT, '.tmp', 'i18n');
const DB_COPY  = path.join(WORK_DIR, 'pitwall.db');

const args = process.argv.slice(2);
const cmd  = args[0];
const flag = (name, def = null) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? def : args[i + 1];
};
const has = (name) => args.includes('--' + name);

// ── Copia de la BD ────────────────────────────────────────────────────────

async function asegurarCopia({ fresh = false } = {}) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (fresh && fs.existsSync(DB_COPY)) fs.rmSync(DB_COPY, { force: true });
  if (fs.existsSync(DB_COPY)) return;

  if (!fs.existsSync(DB_SRC)) {
    throw new Error(`No existe ${DB_SRC}. El arnés necesita la BD real como fixture.`);
  }
  const Database = require('better-sqlite3');
  const src = new Database(DB_SRC, { readonly: true });
  await src.backup(DB_COPY);          // consistente aunque el server esté abierto
  src.close();
  console.log(`[snapshot] copia de la BD → ${path.relative(ROOT, DB_COPY)}`);
}

// Una manga en 'active' para que las pantallas de directo (live, TV, paneles,
// Lap) rendericen de verdad en vez de caer a su estado vacío. Se hace sobre la
// copia, nunca sobre la BD real.
function activarUnaManga() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_COPY);
  const ya = db.prepare("SELECT id FROM mangas WHERE status = 'active' LIMIT 1").get();
  if (ya) { db.close(); return; }
  const fin = db.prepare("SELECT id, race_id FROM mangas WHERE status = 'finished' ORDER BY race_id DESC, number ASC LIMIT 1").get();
  if (!fin) { db.close(); return; }
  db.prepare("UPDATE mangas SET status = 'active', started_at = datetime('now') WHERE id = ?").run(fin.id);
  db.close();
  console.log(`[snapshot] manga ${fin.id} marcada 'active' en la copia (para el directo)`);
}

// ── URLs a capturar ───────────────────────────────────────────────────────

function urlsA(capturar) {
  const Database = require('better-sqlite3');
  const db = new Database(DB_COPY, { readonly: true });
  const uno = (sql, ...p) => db.prepare(sql).get(...p);

  const carreraFin    = uno("SELECT id FROM races WHERE status = 'finished' ORDER BY id DESC LIMIT 1");
  const carreraActiva = uno("SELECT id FROM races WHERE status = 'active' ORDER BY id DESC LIMIT 1");
  const manga         = uno("SELECT id, race_id FROM mangas WHERE status = 'active' LIMIT 1");
  const tanda         = uno('SELECT id, race_id FROM tandas ORDER BY id DESC LIMIT 1');
  const equipo        = uno('SELECT id FROM teams_catalog ORDER BY id LIMIT 1');
  const piloto        = uno('SELECT id FROM driver_profiles ORDER BY id LIMIT 1');
  const circuito      = uno('SELECT id FROM circuits ORDER BY id LIMIT 1');
  db.close();

  const rf = carreraFin    && carreraFin.id;
  const ra = carreraActiva && carreraActiva.id;
  const rm = manga         && manga.race_id;
  const mid = manga        && manga.id;

  const rutas = [
    '/',
    '/races',
    '/races/new',
    '/races/new/step3',
    '/races/new/step4',
    '/races/new/confirm',
    '/results',
    '/race-stats',
    '/training/live',
    '/control/shifts',
    '/control/tires',
    '/teams',
    '/teams/new',
    '/teams/qr-export',
    '/drivers',
    '/drivers/new',
    '/drivers/qr-all',
    '/circuits',
    '/circuits/new',
    '/categories',
    '/categories/new',
    '/cars',
    '/cars/new',
    '/catalog-sync',
    '/import/tanda',
    '/link',
    '/link/compare',
    '/settings',
    '/diagnostico',
    '/diagnostico/tramas',
    '/database',
    '/cert',
    '/ecosystem',
    '/eula',
    '/changelog',
    '/lap',
  ];

  if (rf) rutas.push(
    `/races/${rf}`, `/races/${rf}/edit`, `/races/${rf}/results`, `/races/${rf}/live-stats`,
    `/races/${rf}/lemans`, `/races/${rf}/events`, `/races/${rf}/tires`,
    `/races/${rf}/tires/log`, `/races/${rf}/verificaciones`, `/races/${rf}/shifts`,
    `/races/${rf}/shifts/report`, `/races/${rf}/shifts/report.html`,
    `/races/${rf}/pole/setup`, `/races/${rf}/pole/timing`, `/races/${rf}/pole/results`,
    `/races/${rf}/pole/lanes`, `/races/${rf}/tandas/new`, `/races/${rf}/sim`,
    `/results/${rf}`,
  );
  if (ra) rutas.push(`/races/${ra}`, `/races/${ra}/results`, `/races/${ra}/live-stats`);
  if (rm && mid) rutas.push(
    `/races/${rm}/mangas/${mid}/live`, `/races/${rm}/mangas/${mid}/tv`,
    `/races/${rm}/mangas/${mid}/corrections`,
    `/races/${rm}/mangas/${mid}/panel/standings`,
    `/races/${rm}/mangas/${mid}/panel/projection`,
    `/races/${rm}/mangas/${mid}/panel/fastest`,
    `/races/${rm}/mangas/${mid}/edit`,
  );
  if (tanda) rutas.push(`/races/${tanda.race_id}/tandas/${tanda.id}/edit`);
  if (equipo && rf) rutas.push(`/races/${rf}/tires/${equipo.id}/history`);
  if (equipo) rutas.push(`/teams/${equipo.id}/edit`);
  if (piloto) rutas.push(`/drivers/${piloto.id}/edit`, `/drivers/${piloto.id}/qr`);
  if (circuito) rutas.push(`/circuits/${circuito.id}/edit`);
  if (rf && equipo) rutas.push(`/lap/${rf}`, `/lap/${rf}/pins`, `/lap/${rf}/team/${equipo.id}`);

  return rutas;
}

// ── Servidor ──────────────────────────────────────────────────────────────

function esperarServidor(port, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const intento = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/eula' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('el servidor no arrancó'));
        setTimeout(intento, 200);
      });
    };
    intento();
  });
}

function pedir(port, ruta) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: ruta, headers: { 'Accept-Language': 'es' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location || null }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
  });
}

function nombreDeRuta(ruta, lang) {
  return ruta.replace(/^\//, '').replace(/[/?=&]/g, '_') + '.' + lang + '.html';
}

// El HTML trae cosas que cambian entre dos capturas aunque el código no cambie.
// Se normalizan para que el diff solo muestre lo que de verdad ha cambiado.
//
// Los blobs de datos inyectados (`const RACE_DATA = {...}` y compañía) llevan la
// proyección, que se recalcula con `Date.now()` contra el arranque de la manga:
// sus números cambian entre dos capturas aunque el código sea idéntico. Se ha
// comprobado que la lista de claves que derivan va creciendo (remainingMs,
// projectedRaw/Total, projected, gapSec, gapSecLeader, gapV, gapVLeader,
// avgToCatch…), así que en vez de perseguir clave a clave se ciegan los DÍGITOS
// de esas líneas.
//
// OJO, y es importante: el arnés vigila TEXTO, no números. En esas vistas (y solo
// en ellas) un cambio numérico no se detecta. Además, buena parte del texto del
// directo y la TV lo pinta el JS de cliente en tiempo de ejecución, así que
// tampoco está en el HTML — eso se revisa a ojo.
const BLOB = /^(\s*(?:const|var|window\.)\s*[\w.]*(?:RACE_DATA|PANEL_DATA|LM_DATA|TV_DATA|TRAINING_DATA|STANDINGS_DATA)[\w.]*\s*=)/;

// Colapsa cada número a un único `0`, y solo FUERA de las cadenas: el texto
// (nombres de equipo, etiquetas) se sigue comparando carácter a carácter. No
// basta con cambiar dígitos por ceros porque lo que baila es la LONGITUD del
// número (4984.997647813356 en una captura, 4985 en la siguiente).
function cegarNumeros(linea) {
  let out = '', enStr = null, esc = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (enStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === enStr) enStr = null;
      continue;
    }
    if (c === '"' || c === "'") { enStr = c; out += c; continue; }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < linea.length && ((linea[j] >= '0' && linea[j] <= '9') || linea[j] === '.')) j++;
      out += '0';
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function normalizar(html) {
  return html
    .split('\n')
    .map(linea => BLOB.test(linea) ? cegarNumeros(linea) : linea)
    .join('\n')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b/g, '<FECHA>')
    .replace(/\b\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}(:\d{2})?\b/g, '<FECHA>')
    .replace(/\?v=\d+/g, '?v=0')                       // cache-busting de CSS/JS
    // Solo la ruta del transporte (`/socket.io/?EIO=4&transport=…`), que lleva
    // un id que cambia en cada conexión. Antes esto era `socket\.io[^"']*` y se
    // comía CUALQUIER texto que mencionara socket.io — incluidos comentarios de
    // dentro de los <script>, que quedaban mutilados en la captura.
    .replace(/\/socket\.io\/[^"'\s]*/g, '/socket.io/…')
    .replace(/\s+$/gm, '');
}

// ── Captura ───────────────────────────────────────────────────────────────

async function capturar() {
  const out   = path.resolve(ROOT, flag('out', path.join('.tmp', 'i18n', 'captura')));
  const langs = (flag('langs', 'es,en')).split(',').map(s => s.trim()).filter(Boolean);

  await asegurarCopia({ fresh: has('fresh') });
  activarUnaManga();

  // Puerto FIJO: el número sale en el HTML (home, ajustes → "http://IP:puerto"),
  // así que uno aleatorio metería ruido en el diff de cada captura.
  const port = parseInt(flag('port', '3999'), 10);
  fs.mkdirSync(out, { recursive: true });

  const hijo = spawn(process.execPath, [path.join(ROOT, 'src', 'app.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PITWALL_DATA: WORK_DIR,
      PORT: String(port),
      PITWALL_NO_WORKER: '1',          // determinismo: nada de cálculos en hilo aparte
      PITWALL_DISABLE_PASSWORD: '1',   // que ninguna pantalla redirija al login
      NODE_ENV: 'production',          // sin morgan (ruido en stdout)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logServidor = '';
  hijo.stdout.on('data', (d) => { logServidor += d; });
  hijo.stderr.on('data', (d) => { logServidor += d; });

  const parar = () => { try { hijo.kill('SIGTERM'); } catch {} };

  try {
    await esperarServidor(port);

    const rutas = urlsA();
    const resumen = [];
    for (const lang of langs) {
      for (const ruta of rutas) {
        const sep = ruta.includes('?') ? '&' : '?';
        let r;
        try {
          r = await pedir(port, `${ruta}${sep}lang=${lang}`);
        } catch (e) {
          resumen.push({ ruta, lang, status: 'ERROR', nota: e.message });
          continue;
        }
        const destino = path.join(out, nombreDeRuta(ruta, lang));
        const html = r.status === 200
          ? normalizar(r.body)
          : `<!-- status ${r.status}${r.location ? ' → ' + r.location : ''} -->\n`;
        fs.writeFileSync(destino, html);
        resumen.push({ ruta, lang, status: r.status, bytes: html.length });
      }
    }

    fs.writeFileSync(path.join(out, '_resumen.json'), JSON.stringify(resumen, null, 2));
    const ok = resumen.filter(x => x.status === 200).length;
    console.log(`[snapshot] ${ok}/${resumen.length} capturas en ${path.relative(ROOT, out)}`);
    const malas = resumen.filter(x => x.status !== 200);
    if (malas.length) {
      console.log('[snapshot] no-200:');
      malas.slice(0, 20).forEach(m => console.log(`   ${m.status}  ${m.lang}  ${m.ruta}${m.nota ? '  ' + m.nota : ''}`));
    }
  } finally {
    parar();
    if (process.env.PITWALL_SNAPSHOT_VERBOSE) console.log(logServidor);
  }
}

// ── Comparación ───────────────────────────────────────────────────────────

function comparar() {
  const a = path.resolve(ROOT, flag('a', path.join('.tmp', 'i18n', 'base')));
  const b = path.resolve(ROOT, flag('b', path.join('.tmp', 'i18n', 'captura')));
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    throw new Error('Faltan directorios de captura. Usa --a y --b.');
  }

  const ficheros = (d) => new Set(fs.readdirSync(d).filter(f => f.endsWith('.html')));
  const fa = ficheros(a), fb = ficheros(b);

  const soloA  = [...fa].filter(f => !fb.has(f));
  const soloB  = [...fb].filter(f => !fa.has(f));
  const comunes = [...fa].filter(f => fb.has(f));

  const distintas = [];
  for (const f of comunes) {
    const x = fs.readFileSync(path.join(a, f), 'utf8');
    const y = fs.readFileSync(path.join(b, f), 'utf8');
    if (x !== y) distintas.push(f);
  }

  console.log(`[compare] ${comunes.length} ficheros comunes`);
  console.log(`  idénticos: ${comunes.length - distintas.length}`);
  console.log(`  distintos: ${distintas.length}`);
  if (soloA.length) console.log(`  solo en A (desaparecidos): ${soloA.length}  ${soloA.slice(0, 10).join(', ')}`);
  if (soloB.length) console.log(`  solo en B (nuevos):        ${soloB.length}  ${soloB.slice(0, 10).join(', ')}`);
  if (distintas.length) {
    console.log('\n  Ficheros con diferencias:');
    distintas.slice(0, 40).forEach(f => console.log('   ' + f));
    if (distintas.length > 40) console.log(`   … y ${distintas.length - 40} más`);
    console.log(`\n  Para ver una:  diff -u "${path.join(a, distintas[0])}" "${path.join(b, distintas[0])}"`);
  }
  process.exitCode = (distintas.length || soloA.length || soloB.length) ? 1 : 0;
}

// ── Main ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (cmd === 'capture')      await capturar();
    else if (cmd === 'compare') comparar();
    else {
      console.log('Uso:');
      console.log('  node scripts/i18n-snapshot.js capture [--out DIR] [--langs es,en] [--fresh]');
      console.log('  node scripts/i18n-snapshot.js compare --a DIR --b DIR');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('[snapshot] error:', e.message);
    process.exitCode = 1;
  }
})();
