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
 * Banco de estrés de la 24 h — ¿aguanta ESTA máquina?
 *
 * Levanta PitWall de verdad sobre una copia desechable de la BD, con una manga
 * viva, e inyecta cruces por el camino REAL (SerialService → TimingService → BD →
 * socket), mientras le echa encima la carga de un evento grande:
 *
 *   • N móviles con la app nativa   → socket.io, solo escuchan (así funciona)
 *   • Los equipos en el cliente Lap → login por PIN + refresco de /api/lap
 *   • Opcional: espectadores en la vista de estadísticas en vivo
 *
 * LO QUE IMPORTA es el bloqueo del bucle de eventos. El proceso es de UN SOLO
 * HILO y better-sqlite3 es síncrono: si algo lo bloquea más de FRAME_GAP_MS
 * (75 ms), se puede partir una trama del DS-300 en dos y PERDER UN CRUCE REAL —
 * que es lo único que no se puede arreglar después.
 *
 * NO toca la BD de producción: trabaja sobre una copia hecha con el backup de
 * SQLite (no `cp`, que se dejaría el -wal). Al terminar, la borra.
 *
 * Uso (igual en Windows, Mac y Linux):
 *   node scripts/stress-24h.js                            # carrera más larga de la BD
 *   node scripts/stress-24h.js --dur 60 --app 100         # 60 s y 100 móviles
 *   node scripts/stress-24h.js --livestats 2              # + 2 pantallas de estadísticas
 *   node scripts/stress-24h.js --race 31 --keep
 *
 * Opciones: --dur (30) · --app (100) · --livestats (0) · --race (la más larga)
 *           --port (3999) · --keep (no borrar la copia de la BD)
 *
 * También valen como variables de entorno (DUR_S, N_APP, N_LIVESTATS, RACE,
 * PORT, KEEP=1), pero en PowerShell la forma `VAR=x node ...` NO funciona: usa
 * los argumentos de arriba y te evitas el disgusto.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

const RAIZ = path.join(__dirname, '..');

// Argumentos antes que variables de entorno; ambos antes que el valor por defecto.
function opcion(nombre, env, pordefecto) {
  const i = process.argv.indexOf('--' + nombre);
  if (i !== -1) {
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) return true;      // bandera suelta
    return v;
  }
  return process.env[env] !== undefined ? process.env[env] : pordefecto;
}
const entero = (n, e, d) => parseInt(opcion(n, e, d), 10);

const DUR_S = entero('dur', 'DUR_S', '30');
const N_APP = entero('app', 'N_APP', '100');
const N_LS  = entero('livestats', 'N_LIVESTATS', '0');
const PORT  = entero('port', 'PORT', '3999');
const RACE  = opcion('race', 'RACE', null);
const KEEP  = opcion('keep', 'KEEP', null) !== null && opcion('keep', 'KEEP', null) !== false;
const FRAME_GAP_MS = 75;

// ── Copia desechable de la BD ───────────────────────────────────────────────
const Database = require(path.join(RAIZ, 'node_modules', 'better-sqlite3'));
const ORIGEN = process.env.PITWALL_DATA
  ? path.join(process.env.PITWALL_DATA, 'pitwall.db')
  : path.join(RAIZ, 'database', 'pitwall.db');

const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-stress-'));
const COPIA  = path.join(dirTmp, 'pitwall.db');

function limpiar() {
  if (KEEP) { console.log(`\n(copia conservada en ${dirTmp})`); return; }
  try { fs.rmSync(dirTmp, { recursive: true, force: true }); } catch {}
}

(async () => {
  if (!fs.existsSync(ORIGEN)) {
    console.error(`No encuentro la base de datos en ${ORIGEN}`);
    process.exit(1);
  }
  // .backup y no cp: con WAL, copiar el fichero a pelo se deja las escrituras
  // pendientes y la copia sale incoherente.
  const src = new Database(ORIGEN, { readonly: true });
  await src.backup(COPIA);
  src.close();

  process.env.PITWALL_DATA = dirTmp;
  process.env.NODE_ENV     = 'production';
  process.env.PORT         = String(PORT);

  const { server }      = require(path.join(RAIZ, 'src', 'app.js'));
  const db              = require(path.join(RAIZ, 'src', 'config', 'database'));
  const TimingService   = require(path.join(RAIZ, 'src', 'services', 'TimingService'));
  const SerialService   = require(path.join(RAIZ, 'src', 'services', 'SerialService'));
  const SocketService   = require(path.join(RAIZ, 'src', 'services', 'SocketService'));

  // Sin puertos de verdad, SerialService cae en simulación y se pone a reproducir
  // un fichero de tramas: inyectaría cruces suyos además de los del banco y la
  // medida saldría contaminada. Aquí los cruces los ponemos nosotros, al ritmo
  // real de la carrera elegida.
  //
  // `init()` es asíncrono (intenta abrir los puertos, falla y ENTONCES cae en
  // simulación), así que pararla aquí no sirve de nada: aún no ha arrancado. Se
  // para de verdad justo antes de medir — ver `pararSimulacion()`.
  const pararSimulacion = () => { try { SerialService.stopSimulation(); } catch {} };
  pararSimulacion();

  // ── Carrera: la que más vueltas tenga (la más dura) ───────────────────────
  const race = RACE
    ? db.prepare('SELECT * FROM races WHERE id = ?').get(parseInt(RACE, 10))
    : db.prepare(`SELECT * FROM races WHERE format = 'team'
                  ORDER BY (SELECT COUNT(*) FROM laps WHERE race_id = races.id) DESC LIMIT 1`).get();
  if (!race) { console.error('No hay ninguna carrera por equipos en la BD.'); limpiar(); process.exit(1); }

  const manga = db.prepare('SELECT * FROM mangas WHERE race_id = ? ORDER BY id DESC LIMIT 1').get(race.id);
  if (!manga) { console.error(`La carrera ${race.id} no tiene mangas.`); limpiar(); process.exit(1); }

  const nVueltas = db.prepare('SELECT COUNT(*) c FROM laps WHERE race_id = ?').get(race.id).c;
  db.prepare("UPDATE mangas SET status='active', started_at=? WHERE id=?").run(new Date().toISOString(), manga.id);
  db.prepare("UPDATE races  SET status='active' WHERE id=?").run(race.id);

  // ── Sesión viva con los carriles reales de esa manga ──────────────────────
  const laneMap = {}, laneToCircuit = {};
  db.prepare(`SELECT ml.lane, ml.team_id, t.name, t.color FROM manga_lanes ml
              JOIN teams t ON t.id = ml.team_id
              WHERE ml.manga_id = ? AND ml.is_rest = 0`).all(manga.id).forEach(r => {
    const s = db.prepare(`SELECT COUNT(*) c, MIN(lap_time_ms) best, SUM(lap_time_ms) suma,
      SUM(is_exit) ex, SUM(is_pit_stop) pit, MAX(lap_number) ml
      FROM laps WHERE manga_id = ? AND team_id = ? AND is_ghost = 0`).get(manga.id, r.team_id);
    const media = s.c ? s.suma / s.c : 10200;
    laneMap[r.lane] = {
      lane: r.lane, color: r.color, name: r.name, country: null,
      teamId: r.team_id, driverId: null,
      lapCount: s.ml || 0, lastLapMs: Math.round(media), bestLapMs: s.best,
      exitCount: s.ex || 0, pitStopCount: s.pit || 0,
      lapAvgMs: media, avgLapCount: s.c || 0, lapsMsSum: s.suma || 0,
      cleanAvgCount: s.c || 0, cleanLapsSum: s.suma || 0, cleanAvgMs: media,
      refAvgMs: media, raceBestLapMs: s.best, raceBestEntity: r.name,
      lastCrossing: Date.now(), lastLapId: null,
    };
    laneToCircuit[r.lane] = 0;
  });
  const carriles = Object.keys(laneMap).map(Number);
  if (!carriles.length) { console.error('Esa manga no tiene carriles con equipo.'); limpiar(); process.exit(1); }

  const mediaVuelta = Math.round(
    carriles.reduce((s, l) => s + laneMap[l].lapAvgMs, 0) / carriles.length) || 10200;

  TimingService.session = {
    race, manga, laneMap, laneToCircuit,
    startTime: Date.now() - 600000, durationMs: 3600000,
    circuits: [{ index: 0, status: 'running', startTime: Date.now() - 600000,
                 endTime: Date.now() + 3000000, durationMs: 3600000, lanes: carriles }],
  };
  if (!TimingService._lapHandler) {
    TimingService._lapHandler = (d) => TimingService._onCrossing(d.lane, d.timestamp, d.lapTimeMs, d.missed);
    SerialService.on('lane_crossing', TimingService._lapHandler);
  }

  // ── Vigilante del bucle de eventos ────────────────────────────────────────
  // Un timer de 20 ms: lo que se retrase de más es tiempo que el proceso estuvo
  // bloqueado y no pudo atender el serie.
  const lags = [];
  let midiendo = false, corriendo = true;
  (function tic() {
    const t0 = process.hrtime.bigint();
    setTimeout(() => {
      if (!corriendo) return;
      if (midiendo) lags.push(Number(process.hrtime.bigint() - t0) / 1e6 - 20);
      tic();
    }, 20);
  })();

  // ── Cruces por el camino real ─────────────────────────────────────────────
  let cruces = 0;
  carriles.forEach((lane, i) => {
    const paso = () => {
      if (!corriendo) return;
      const ms = Math.round(mediaVuelta * (1 + (Math.random() * 2 - 1) * 0.15));
      SerialService.emit('lane_crossing', { lane, timestamp: Date.now(), lapTimeMs: ms, missed: false });
      if (midiendo) cruces++;
      setTimeout(paso, ms);
    };
    setTimeout(paso, (i / carriles.length) * mediaVuelta);   // repartidos, no en bloque
  });
  setInterval(() => {
    if (corriendo && TimingService.session) {
      SocketService.emit('tick', { elapsedMs: Date.now() - TimingService.session.startTime });
    }
  }, 1000);

  await new Promise(r => server.listen(PORT, r));

  // ── Clientes ──────────────────────────────────────────────────────────────
  const io = require(path.join(RAIZ, 'node_modules', 'socket.io-client'));
  const BASE = `http://localhost:${PORT}`;
  const pedir = (metodo, ruta, o = {}) => new Promise((res, rej) => {
    const cuerpo = o.form ? new URLSearchParams(o.form).toString() : null;
    const u = new URL(BASE + ruta);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: metodo,
      headers: {
        ...(o.cookie ? { Cookie: o.cookie } : {}),
        ...(cuerpo ? { 'Content-Type': 'application/x-www-form-urlencoded',
                       'Content-Length': Buffer.byteLength(cuerpo) } : {}),
      },
    }, resp => { let n = 0, d = ''; resp.on('data', c => { n += c.length; if (d.length < 2e6) d += c; });
                 resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: d, bytes: n })); });
    r.on('error', rej); if (cuerpo) r.write(cuerpo); r.end();
  });

  console.log(`\n🏁 Banco de estrés de la 24 h — ${os.cpus()[0].model.trim()}`);
  console.log(`   ${os.cpus().length} núcleos · ${(os.totalmem() / 1073741824).toFixed(1)} GB · node ${process.version}`);
  console.log(`   Carrera "${race.name}" · ${nVueltas.toLocaleString('es')} vueltas · ${carriles.length} carriles`);
  console.log(`   Vuelta media ${(mediaVuelta / 1000).toFixed(1)}s → ~${(carriles.length / (mediaVuelta / 1000)).toFixed(1)} cruces/s`);
  console.log(`   ${N_APP} móviles (app nativa, socket) · ${N_LS} pantallas de estadísticas · ${DUR_S}s\n`);

  // Móviles con la app nativa: escuchan, no piden. Es como funciona de verdad.
  let bytesSocket = 0;
  const ev = { standings: 0, lap: 0, tick: 0 };
  const apps = [];
  for (let i = 0; i < N_APP; i++) {
    const s = io(BASE, { query: { view: 'lap' }, transports: ['websocket'], reconnection: false });
    const cuenta = (k) => (p) => { if (midiendo) { ev[k]++; bytesSocket += JSON.stringify(p).length; } };
    s.on('standings', cuenta('standings'));
    s.on('lap',  cuenta('lap'));
    s.on('tick', cuenta('tick'));
    apps.push(s);
  }
  await new Promise(r => setTimeout(r, 2500));
  const conectados = apps.filter(s => s.connected).length;

  // Equipos en el cliente Lap web: login por PIN + refresco real.
  const Team = require(path.join(RAIZ, 'src', 'models', 'Team'));
  try { Team.ensureLapPins(race.id); } catch {}
  const equipos = db.prepare('SELECT id, name, lap_pin FROM teams WHERE race_id = ? AND lap_pin IS NOT NULL').all(race.id);
  const sesiones = [];
  for (const t of equipos) {
    try {
      const r = await pedir('POST', `/lap/${race.id}/login`, { form: { teamId: t.id, pin: t.lap_pin } });
      const ck = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      if (ck) sesiones.push({ t, ck });
    } catch {}
  }
  console.log(`   ${conectados}/${N_APP} móviles conectados · ${sesiones.length} equipos en Lap web\n   midiendo ${DUR_S}s...\n`);

  // ── A medir ───────────────────────────────────────────────────────────────
  // Ahora sí: `init()` ya ha terminado de caer en simulación, así que se la puede
  // parar. A partir de aquí los únicos cruces son los del banco.
  pararSimulacion();
  const antesDeMedir = db.prepare('SELECT COUNT(*) c FROM laps WHERE manga_id = ?').get(manga.id).c;

  midiendo = true;
  const fin = Date.now() + DUR_S * 1000;
  const latLap = [], latLs = [];
  let okLap = 0, errLap = 0, okLs = 0, bytesHttp = 0;

  const tareas = sesiones.map(async s => {
    while (Date.now() < fin) {
      const t0 = process.hrtime.bigint();
      try {
        const r = await pedir('GET', `/api/lap/${race.id}/team/${s.t.id}`, { cookie: s.ck });
        if (r.status === 200) { okLap++; bytesHttp += r.bytes; } else errLap++;
      } catch { errLap++; }
      latLap.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await new Promise(r => setTimeout(r, 400));   // poll 5s + rebote por cruce
    }
  });

  for (let i = 0; i < N_LS; i++) {
    tareas.push((async () => {
      while (Date.now() < fin) {
        const t0 = process.hrtime.bigint();
        try {
          const r = await pedir('GET', `/races/${race.id}/live-stats.json?mangaId=${manga.id}`);
          if (r.status === 200) { okLs++; bytesHttp += r.bytes; }
        } catch {}
        latLs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        await new Promise(r => setTimeout(r, 400));
      }
    })());
  }
  await Promise.all(tareas);
  midiendo = false;
  corriendo = false;

  // ── Resultado ─────────────────────────────────────────────────────────────
  const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
  const bloqueos = lags.filter(x => x > 0);
  const maxBloq  = bloqueos.length ? Math.max(...bloqueos) : 0;
  const pasados  = bloqueos.filter(x => x > FRAME_GAP_MS).length;
  const linea = (k, v) => console.log('  ' + k.padEnd(34) + v);

  // Que las vueltas grabadas cuadren con los cruces que metimos. Si no cuadran,
  // alguien más está inyectando (la simulación por fichero de SerialService) y la
  // medida no vale: mejor decirlo que dar un veredicto falso.
  const grabadas = db.prepare('SELECT COUNT(*) c FROM laps WHERE manga_id = ?').get(manga.id).c - antesDeMedir;
  const descuadre = Math.abs(grabadas - cruces) > Math.max(5, cruces * 0.1);

  console.log('══════════════════════════════════════════════════════════');
  console.log(' BLOQUEO DEL BUCLE — lo que decide si se pierde un cruce');
  console.log('══════════════════════════════════════════════════════════');
  linea('Cruces inyectados', `${cruces}  (${(cruces / DUR_S).toFixed(1)}/s)`);
  linea('Bloqueo p50', `${pct(bloqueos, 0.50).toFixed(1)} ms`);
  linea('Bloqueo p95', `${pct(bloqueos, 0.95).toFixed(1)} ms`);
  linea('Bloqueo p99', `${pct(bloqueos, 0.99).toFixed(1)} ms`);
  linea('Bloqueo MÁXIMO', `${maxBloq.toFixed(1)} ms`);
  linea(`Veces por encima de ${FRAME_GAP_MS} ms`, `${pasados} de ${bloqueos.length} muestras`);
  console.log('');
  if (descuadre) {
    console.log(`  ⚠ MEDIDA NO FIABLE: se grabaron ${grabadas} vueltas para ${cruces} cruces inyectados.`);
    console.log('    Algo más está metiendo vueltas (¿la simulación por fichero?). Repite la prueba.');
  } else {
    console.log(pasados === 0
      ? '  ✔ APTO: nada bloqueó el proceso más que el hueco entre tramas.\n    Esta máquina no debería perder cruces por CPU.'
      : `  ⚠ RIESGO: ${pasados} bloqueos por encima de ${FRAME_GAP_MS} ms. Cada uno puede partir\n    una trama del DS-300 y costar un cruce real. Esta máquina va justa.`);
  }

  console.log('\n── Clientes ──');
  if (sesiones.length) {
    linea('Lap web: peticiones', `${okLap} ok, ${errLap} error  (${(okLap / DUR_S).toFixed(1)}/s)`);
    linea('Lap web: latencia p50/p95/máx', `${pct(latLap, 0.5).toFixed(1)} / ${pct(latLap, 0.95).toFixed(1)} / ${(latLap.length ? Math.max(...latLap) : 0).toFixed(1)} ms`);
  }
  if (N_LS) {
    linea('Estadísticas: peticiones', `${okLs}  (${(okLs / DUR_S).toFixed(1)}/s)`);
    linea('Estadísticas: latencia p50/máx', `${pct(latLs, 0.5).toFixed(1)} / ${(latLs.length ? Math.max(...latLs) : 0).toFixed(1)} ms`);
  }
  linea('Móviles: eventos', `standings ${ev.standings} · lap ${ev.lap} · tick ${ev.tick}`);
  linea('Tráfico a los móviles', `${(bytesSocket / 1048576 / DUR_S).toFixed(2)} MB/s`);
  linea('Tráfico HTTP', `${(bytesHttp / 1048576 / DUR_S).toFixed(2)} MB/s`);
  linea('Memoria del proceso (RSS)', `${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  console.log('');

  apps.forEach(s => s.close());
  limpiar();
  process.exit(descuadre ? 2 : (pasados === 0 ? 0 : 1));
})().catch(err => {
  console.error('\nEl banco falló:', err);
  limpiar();
  process.exit(1);
});
