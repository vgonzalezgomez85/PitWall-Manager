#!/usr/bin/env node
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
'use strict';

/*
 * Banco de estrés REMOTO — para una instancia de PitWall que YA está corriendo
 * en otra máquina, sin acceso al emulador DS-300 (ni al servidor por SSH).
 *
 * No arranca ningún proceso local: todo se hace por HTTP contra --base.
 *
 *   1. Sube un dataset de tramas DS-300 (real o sintético, --frames) como
 *      "carrera simulada" — la propia función de PitWall pensada para
 *      reproducir tramas DS-300 sin hardware. Crea una carrera temporal
 *      (__STRESS_REMOTE__).
 *   2. La reproduce a velocidad ×N: cruces por el camino real (SerialService
 *      → TimingService → BD → socket) en la máquina remota, encadenando
 *      mangas automáticamente durante toda la prueba.
 *   3. Le echa encima carga de espectadores concurrentes en los TRES canales
 *      públicos del evento:
 *        - Móviles con la app nativa (socket.io, view=lap, solo escuchan)
 *        - Equipos/familias en el cliente Lap web (login por PIN + polling
 *          de /api/lap, repartidos entre los equipos reales de la carrera)
 *        - Pantallas/espectadores de live-stats (socket.io, view=livestats,
 *          + GET a /races/:id/live-stats.json con el mismo rebote de 400ms
 *          que usa el cliente real — ver src/views/live-stats/show.ejs)
 *   4. Mide latencias/errores/tráfico de cada canal. Al terminar para la
 *      simulación y BORRA la carrera de prueba del remoto (--keep para
 *      conservarla).
 *
 * Uso:
 *   node scripts/stress-remote.js --base http://192.168.10.62:3000 \
 *        --frames database/sim/24lanes.frames --lanes 24 --duration-min 5 \
 *        --app 200 --web 200 --live 200 --dur 120 --speed 20
 *
 * Opciones:
 *   --base          http://192.168.10.62:3000 (obligatoria en la práctica)
 *   --frames        ruta al fichero de tramas TXT/CSV a subir (obligatoria)
 *   --teams         ruta a un JSON {"teams":[...]} con los nombres de equipo
 *                   (si se omite, se generan "Equipo 01".."Equipo NN")
 *   --lanes         nº de carriles (si se omite, lo detecta PitWall al analizar)
 *   --duration-min  minutos de manga (si se omite, lo detecta PitWall)
 *   --dur           duración de la prueba en segundos (120)
 *   --app           móviles con la app nativa (200)
 *   --web           espectadores en Lap web, repartidos entre los equipos (200)
 *   --live          espectadores de live-stats (200)
 *   --speed         velocidad de reproducción de las tramas (20)
 *   --keep          no borra la carrera de prueba al final
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const RAIZ = path.join(__dirname, '..');

function opcion(nombre, pordefecto) {
  const i = process.argv.indexOf('--' + nombre);
  if (i !== -1) {
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) return true;
    return v;
  }
  return pordefecto;
}

const BASE      = String(opcion('base', 'http://192.168.10.62:3000')).replace(/\/+$/, '');
const DUR_S     = parseInt(opcion('dur', '120'), 10);
const N_APP     = parseInt(opcion('app', '200'), 10);
const N_WEB     = parseInt(opcion('web', '200'), 10);
const N_LIVE    = parseInt(opcion('live', '200'), 10);
const SPEED     = parseFloat(opcion('speed', '20'));
const KEEP      = opcion('keep', false) !== false;
const FRAMES_PATH = path.resolve(RAIZ, String(opcion('frames', 'database/sim/42.frames')));
const TEAMS_PATH  = opcion('teams', null);
const LANES_OPT   = opcion('lanes', null);
const DURMIN_OPT  = opcion('duration-min', null);

// ── Cliente HTTP mínimo (con cookies y sin seguir redirecciones) ───────────
function pedir(metodo, ruta, o = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + ruta);
    const cuerpo = o.form ? new URLSearchParams(o.form).toString() : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: metodo,
      headers: {
        ...(o.cookie ? { Cookie: o.cookie } : {}),
        ...(cuerpo ? { 'Content-Type': 'application/x-www-form-urlencoded',
                       'Content-Length': Buffer.byteLength(cuerpo) } : {}),
      },
    }, (resp) => {
      let n = 0, d = '';
      resp.on('data', (c) => { n += c.length; if (d.length < 4e6) d += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: d, bytes: n }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

function generaEquipos(n) {
  return Array.from({ length: n }, (_, i) => `Equipo ${String(i + 1).padStart(2, '0')}`);
}

(async () => {
  console.log(`\n🏁 Banco de estrés REMOTO — ${BASE}`);
  console.log(`   tramas: ${FRAMES_PATH}`);
  console.log(`   ${DUR_S}s · ×${SPEED} · app ${N_APP} · lap web ${N_WEB} · live-stats ${N_LIVE}\n`);

  if (!fs.existsSync(FRAMES_PATH)) { console.error(`No encuentro ${FRAMES_PATH}`); process.exit(1); }

  // Nombres de equipo: fichero indicado o genéricos según --lanes (o 24 por defecto).
  let teamNames;
  if (TEAMS_PATH) {
    teamNames = JSON.parse(fs.readFileSync(path.resolve(RAIZ, TEAMS_PATH), 'utf8')).teams;
  } else {
    teamNames = generaEquipos(parseInt(LANES_OPT, 10) || 24);
  }

  // Sanity: ¿responde el remoto?
  let home;
  try { home = await pedir('GET', '/'); } catch (e) { console.error(`❌ No responde ${BASE}: ${e.message}`); process.exit(1); }
  if (home.status !== 200) { console.error(`❌ ${BASE} respondió HTTP ${home.status}`); process.exit(1); }
  console.log('✓ El remoto responde\n');

  // ── 1) Subir tramas → analizar (multipart, con fetch/FormData nativos) ───
  const framesBuf = fs.readFileSync(FRAMES_PATH);
  const fdA = new FormData();
  fdA.append('name', '__STRESS_REMOTE__');
  fdA.append('frames', new Blob([framesBuf]), path.basename(FRAMES_PATH));
  const rA = await fetch(`${BASE}/races/sim/analyze`, { method: 'POST', body: fdA });
  const htmlA = await rA.text();
  const mTok = htmlA.match(/name="token" value="([a-f0-9]+)"/);
  if (!mTok) {
    console.error('❌ El remoto no pudo analizar las tramas. Respuesta:');
    console.error(htmlA.slice(0, 500));
    process.exit(1);
  }
  const token = mTok[1];
  // Carriles/duración detectados en el análisis (para prerrellenar si no se han dado por CLI).
  const mLanes = htmlA.match(/name="lanes"[^>]*value="(\d+)"/);
  const mDur   = htmlA.match(/name="manga_minutes"[^>]*value="(\d+)"/);
  const lanes       = parseInt(LANES_OPT, 10)  || (mLanes && parseInt(mLanes[1], 10)) || teamNames.length;
  const mangaMinutes = parseInt(DURMIN_OPT, 10) || (mDur && parseInt(mDur[1], 10))     || 5;

  // ── 2) Crear la carrera de prueba ─────────────────────────────────────────
  const fdC = new FormData();
  fdC.append('token', token);
  fdC.append('source', 'txt');
  fdC.append('name', '__STRESS_REMOTE__');
  fdC.append('lanes', String(lanes));
  fdC.append('rests', '0');
  fdC.append('manga_minutes', String(mangaMinutes));
  fdC.append('min_lap_ms', '8500');
  fdC.append('lane_order', teamNames.join('\n'));
  const rC = await fetch(`${BASE}/races/sim/create`, { method: 'POST', body: fdC, redirect: 'manual' });
  const loc = rC.headers.get('location') || '';
  const mId = loc.match(/\/races\/(\d+)\/sim/);
  if (!mId) {
    console.error(`❌ No se pudo crear la carrera remota (HTTP ${rC.status}, Location="${loc}")`);
    process.exit(1);
  }
  const raceId = mId[1];
  console.log(`✓ Carrera de prueba creada en el remoto: id=${raceId} ("__STRESS_REMOTE__", ${lanes} carriles)\n`);

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (KEEP) { console.log(`\n(carrera ${raceId} conservada en el remoto — bórrala a mano cuando termines)`); return; }
    try { await pedir('POST', `/races/${raceId}/sim/stop`); } catch {}
    try {
      const rD = await pedir('DELETE', `/races/${raceId}`);
      console.log(rD.status < 400
        ? `✓ Carrera de prueba ${raceId} borrada del remoto.`
        : `⚠ No se pudo borrar la carrera ${raceId} (HTTP ${rD.status}) — bórrala a mano en /races/${raceId}.`);
    } catch { console.log(`⚠ No se pudo borrar la carrera ${raceId} — bórrala a mano en /races/${raceId}.`); }
  }
  process.on('SIGINT', async () => { console.log('\nInterrumpido, limpiando el remoto...'); await cleanup(); process.exit(1); });

  const sockets = [];
  try {
    // ── 3) PINs de equipo (se generan al pedir la página) ────────────────────
    const rPins = await pedir('GET', `/lap/${raceId}/pins`);
    const pinRe = /pin-name">([^<]*)<\/span>\s*<span class="pin-code">([^<]*)<\/span>[\s\S]*?pins\/(\d+)\/regenerate/g;
    const equipos = [];
    let m;
    while ((m = pinRe.exec(rPins.body))) equipos.push({ name: m[1], pin: m[2], teamId: m[3] });
    if (!equipos.length) console.log('⚠ No se pudieron leer los PINs de equipo (sigo sin espectadores de Lap web).\n');

    // ── 4) Espectadores de Lap web: N_WEB repartidos entre los equipos reales ─
    // (varias "personas" pueden compartir el PIN del mismo equipo — cada una
    // con su propia sesión/cookie, como pasaría con varios móviles de la
    // misma familia mirando el mismo equipo).
    const sesiones = [];
    if (equipos.length) {
      for (let i = 0; i < N_WEB; i++) {
        const eq = equipos[i % equipos.length];
        try {
          const r = await pedir('POST', `/lap/${raceId}/login`, { form: { teamId: eq.teamId, pin: eq.pin } });
          const ck = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
          if (ck) sesiones.push({ eq, ck });
        } catch {}
      }
    }
    console.log(`✓ ${sesiones.length}/${N_WEB} sesiones de Lap web logueadas (${equipos.length} equipos)\n`);

    // ── 5) Móviles con la app nativa (socket.io, solo escuchan) ──────────────
    const io = require(path.join(RAIZ, 'node_modules', 'socket.io-client'));
    const evApp = { standings: 0, lap: 0, tick: 0 };
    let bytesApp = 0;
    let midiendo = false;
    for (let i = 0; i < N_APP; i++) {
      const s = io(BASE, { query: { view: 'lap' }, transports: ['websocket'], reconnection: false });
      const cuenta = (k) => (p) => { if (midiendo) { evApp[k]++; bytesApp += JSON.stringify(p).length; } };
      s.on('standings', cuenta('standings'));
      s.on('lap', cuenta('lap'));
      s.on('tick', cuenta('tick'));
      sockets.push(s);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const appConectados = sockets.filter((s) => s.connected).length;
    console.log(`✓ ${appConectados}/${N_APP} móviles conectados por socket.io\n`);

    // ── 6) Espectadores de live-stats (socket.io view=livestats + polling) ───
    // Igual que el cliente real (src/views/live-stats/show.ejs): al recibir
    // standings/lap/manga:started/stopped, pide el JSON con un rebote de
    // 400ms (varios eventos seguidos → una sola petición). El JSON exige
    // ?mangaId=N (400 "mangaId_required" si no); la página real lo saca de
    // `MANGA_ID` (inyectado server-side) y se recarga entera al cambiar de
    // manga (`socket.once('manga:started', () => location.reload())`) — aquí
    // basta con UNA resolución compartida (no 200 recargas de página) para
    // que las 200 peticiones JSON lleven el id correcto.
    let currentMangaId = null;
    let refrescandoManga = false;
    async function refreshMangaId() {
      if (refrescandoManga) return;
      refrescandoManga = true;
      try {
        const r = await pedir('GET', `/races/${raceId}/live-stats`);
        const m = r.body.match(/MANGA_ID\s*=\s*(\d+)/);
        if (m) currentMangaId = parseInt(m[1], 10);
      } catch {} finally { refrescandoManga = false; }
    }
    await refreshMangaId();

    const liveSockets = [];
    let okLive = 0, errLive = 0, bytesLive = 0;
    const latLive = [];
    const timers = new Map();
    function pedirLiveStats(idx) {
      if (!currentMangaId) return;
      const t0 = process.hrtime.bigint();
      pedir('GET', `/races/${raceId}/live-stats.json?mangaId=${currentMangaId}`)
        .then((r) => {
          if (!midiendo) return;
          latLive.push(Number(process.hrtime.bigint() - t0) / 1e6);
          if (r.status === 200) { okLive++; bytesLive += r.bytes; } else errLive++;
        })
        .catch(() => { if (midiendo) errLive++; });
    }
    for (let i = 0; i < N_LIVE; i++) {
      const s = io(BASE, { query: { view: 'livestats' }, transports: ['websocket'], reconnection: false });
      const schedule = () => {
        if (!midiendo) return;
        clearTimeout(timers.get(i));
        timers.set(i, setTimeout(() => pedirLiveStats(i), 400));
      };
      s.on('standings', schedule);
      s.on('lap', schedule);
      s.on('manga:started', () => { if (midiendo) { refreshMangaId().then(() => pedirLiveStats(i)); } });
      s.on('manga:stopped', () => { if (midiendo) pedirLiveStats(i); });
      liveSockets.push(s);
      sockets.push(s);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const liveConectados = liveSockets.filter((s) => s.connected).length;
    console.log(`✓ ${liveConectados}/${N_LIVE} espectadores de live-stats conectados por socket.io (manga inicial=${currentMangaId})\n`);

    // ── 7) Arrancar la reproducción en el remoto (manga a manga) ─────────────
    const simStart = () => pedir('POST', `/races/${raceId}/sim/start`, { form: { speed: SPEED } });
    await simStart();
    console.log(`▶ Reproduciendo tramas en el remoto a ×${SPEED} durante ${DUR_S}s...\n`);

    let corriendo = true;
    // El reproductor va manga a manga y se queda "ready" al terminar cada una;
    // la re-arrancamos sola para que la prueba no se pare a mitad.
    const chainInt = setInterval(async () => {
      if (!corriendo) return;
      try {
        const r = await pedir('GET', `/races/${raceId}/sim/status`);
        const st = JSON.parse(r.body);
        if (st.phase === 'ready') await simStart();
      } catch {}
    }, 1000);

    // ── 8) A medir: latencia real de Lap web bajo la carga anterior ──────────
    midiendo = true;
    const fin = Date.now() + DUR_S * 1000;
    const latLap = [];
    let okLap = 0, errLap = 0, bytesHttp = 0;

    const tareas = sesiones.map(async (s) => {
      while (Date.now() < fin) {
        const t0 = process.hrtime.bigint();
        try {
          const r = await pedir('GET', `/api/lap/${raceId}/team/${s.eq.teamId}`, { cookie: s.ck });
          if (r.status === 200) { okLap++; bytesHttp += r.bytes; } else errLap++;
        } catch { errLap++; }
        latLap.push(Number(process.hrtime.bigint() - t0) / 1e6);
        await new Promise((r) => setTimeout(r, 400));
      }
    });
    if (!tareas.length) await new Promise((r) => setTimeout(r, DUR_S * 1000));
    await Promise.all(tareas);

    midiendo = false;
    corriendo = false;
    clearInterval(chainInt);
    for (const t of timers.values()) clearTimeout(t);
    await pedir('POST', `/races/${raceId}/sim/stop`).catch(() => {});

    // ── Resultado ──────────────────────────────────────────────────────────
    // Sin spread (Math.max(...arr)): con cientos de miles de muestras (pruebas
    // largas × 200 clientes) revienta la pila de llamadas.
    const maxOf = (a) => a.reduce((m, x) => (x > m ? x : m), 0);
    const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
    const linea = (k, v) => console.log('  ' + k.padEnd(34) + v);

    console.log('══════════════════════════════════════════════════════════');
    console.log(` RESULTADO — banco remoto contra ${BASE}`);
    console.log('══════════════════════════════════════════════════════════');
    linea('Móviles (app): conectados/objetivo', `${appConectados}/${N_APP}`);
    linea('Móviles (app): eventos', `standings ${evApp.standings} · lap ${evApp.lap} · tick ${evApp.tick}`);
    linea('Móviles (app): tráfico', `${(bytesApp / 1048576 / DUR_S).toFixed(2)} MB/s`);
    console.log('');
    if (sesiones.length) {
      linea('Lap web: sesiones/objetivo', `${sesiones.length}/${N_WEB}`);
      linea('Lap web: peticiones', `${okLap} ok, ${errLap} error  (${(okLap / DUR_S).toFixed(1)}/s)`);
      linea('Lap web: latencia p50/p95/máx', `${pct(latLap, 0.5).toFixed(1)} / ${pct(latLap, 0.95).toFixed(1)} / ${(latLap.length ? maxOf(latLap) : 0).toFixed(1)} ms`);
      linea('Lap web: tráfico', `${(bytesHttp / 1048576 / DUR_S).toFixed(2)} MB/s`);
    }
    console.log('');
    linea('Live-stats: conectados/objetivo', `${liveConectados}/${N_LIVE}`);
    linea('Live-stats: peticiones', `${okLive} ok, ${errLive} error  (${(okLive / DUR_S).toFixed(1)}/s)`);
    linea('Live-stats: latencia p50/p95/máx', `${pct(latLive, 0.5).toFixed(1)} / ${pct(latLive, 0.95).toFixed(1)} / ${(latLive.length ? maxOf(latLive) : 0).toFixed(1)} ms`);
    linea('Live-stats: tráfico', `${(bytesLive / 1048576 / DUR_S).toFixed(2)} MB/s`);
    console.log('');

    const totalOk = okLap + okLive, totalErr = errLap + errLive;
    const errPct = (totalOk + totalErr) ? (100 * totalErr / (totalOk + totalErr)) : 0;
    const p95 = Math.max(pct(latLap, 0.95), pct(latLive, 0.95));
    if (errPct > 1 || p95 > 800) {
      console.log(`⚠ RIESGO: ${errPct.toFixed(1)}% de errores, p95 ${p95.toFixed(1)} ms bajo carga.`);
    } else {
      console.log('✔ El remoto aguantó la carga sin errores relevantes ni latencia alta.');
    }
    console.log('');
  } finally {
    sockets.forEach((s) => { try { s.close(); } catch {} });
    await cleanup();
  }
})().catch(async (err) => {
  console.error('\nEl banco falló:', err);
  process.exit(1);
});
