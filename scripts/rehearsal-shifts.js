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
// Ensayo comprimido del control de turnos sobre 3 DS-300 emulados, 8+8+8 = 24
// carriles: el montaje exacto de la 24h de Llinars.
//
// `npm test` prueba la lógica con el reloj rebobinado. Esto prueba lo otro: las
// transiciones llegan por TRAMAS DE VERDAD del puerto serie (el GO lo da la
// caja, el stop forzado es un `race_stopped` real), el tiempo pasa de verdad y
// el reparto carril→circuito lo hace SerialService. Caza lo que un reloj falso
// no puede ver: cableado, offsets de circuito y el flujo GO→manga:started.
//
//   1) node scripts/rehearsal-shifts.js --seed     ← con el servidor PARADO
//   2) arrancar el servidor apuntando a esa BD
//   3) node scripts/rehearsal-shifts.js            ← el ensayo
//
// Variables: SLOTIME_DATA (BD), PW (url), EMUS (puertos de los emuladores).

const path = require('node:path');

const PW   = process.env.PW || 'http://localhost:3010';
const EMUS = (process.env.EMUS || '3100,3101,3102').split(',').map(s => `http://localhost:${s.trim()}`);
const PTYS = (process.env.PTYS || '/tmp/ds1-app,/tmp/ds2-app,/tmp/ds3-app').split(',');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const S = (ms) => (ms / 1000).toFixed(1) + 's';

let fallos = 0;
const ok  = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const mal = (m) => { fallos++; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };
const paso = (m) => console.log(`\n\x1b[1m── ${m}\x1b[0m ${'─'.repeat(Math.max(0, 60 - m.length))}`);

const post = async (url, data) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                               body: JSON.stringify(data || {}) });
  const t = await r.text();
  let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, body: b };
};

// ── Siembra ────────────────────────────────────────────────────────────────
// 24 equipos (uno por carril), 2 pilotos cada uno: un TITULAR que ficha antes
// del GO y un SUPLENTE que solo releva en el carril 1. Los 23 suplentes que no
// relevan son la prueba de fuego del informe: nunca fichan, y deben salir.
function seed() {
  const db = require('../src/config/database');
  const Settings = require('../src/models/Settings');

  console.log(`BD: ${process.env.SLOTIME_DATA}`);
  for (const t of ['driver_shifts', 'laps', 'manga_lanes', 'drivers', 'teams', 'mangas', 'tandas',
                   'races', 'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }

  const LANES = 24;
  // status='active': el GO de la caja solo busca mangas pendientes de carreras activas.
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_max_runs, driver_change_lockout_ms)
    VALUES ('Ensayo turnos 24h', 'championship', 'team', 'active', ?, ?, '[8,8,8]', 4, 30000, 0, 0, 3000)
  `).run(LANES, JSON.stringify(Array.from({ length: LANES }, (_, i) => i + 1))).lastInsertRowid;

  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mangaId = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)')
    .run(tandaId, raceId).lastInsertRowid;

  const pilotos = [];
  for (let lane = 1; lane <= LANES; lane++) {
    const equipo = `Equipo ${String(lane).padStart(2, '0')}`;
    const miembros = [
      { nombre: `Titular ${lane}`,  qr: `QR-T${lane}`, titular: true },
      { nombre: `Suplente ${lane}`, qr: `QR-S${lane}`, titular: false },
    ];
    const catId = db.prepare('INSERT INTO teams_catalog (name) VALUES (?)').run(equipo).lastInsertRowid;
    const teamId = db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)')
      .run(raceId, tandaId, equipo).lastInsertRowid;

    miembros.forEach((m, i) => {
      const profileId = db.prepare('INSERT INTO driver_profiles (name, category, qr_code) VALUES (?, ?, ?)')
        .run(m.nombre, i === 0 ? 'oro' : 'plata', m.qr).lastInsertRowid;
      db.prepare('INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES (?, ?, ?, ?)')
        .run(catId, profileId, m.nombre, i);
      db.prepare('INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, ?)')
        .run(raceId, tandaId, teamId, m.nombre);
      pilotos.push({ ...m, lane, profileId });
    });
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, ?, ?, 0)')
      .run(mangaId, lane, teamId);
  }

  // Las 3 cajas, en el orden que fija el offset de carriles: 1-8, 9-16, 17-24.
  Settings.set('serial_mode', 'serial');
  Settings.set('circuits_serial', JSON.stringify(PTYS.map(p => ({ port: p, baud: 56000, lanes: 8 }))));

  console.log(`carrera ${raceId} · tanda ${tandaId} · manga ${mangaId}`);
  console.log(`${LANES} carriles · ${pilotos.length} pilotos · cajas: ${PTYS.join('  ')}`);
  console.log(`\nAhora arranca el servidor con esa BD y lanza el ensayo sin --seed.`);
  return { raceId, mangaId };
}

// ── Lecturas ───────────────────────────────────────────────────────────────
function abrirBd() {
  const Database = require('better-sqlite3');
  return new Database(path.join(process.env.SLOTIME_DATA, 'pitwall.db'), { readonly: true });
}
const turnos = (db, mangaId) =>
  db.prepare('SELECT * FROM driver_shifts WHERE manga_id = ? ORDER BY id').all(mangaId);

/**
 * Snapshot vivo de los contadores: el propio contrato `shifts:tick` del socket.
 *
 * Además emite `race:live:join`. No es un truco: PitWall exige a propósito un
 * navegador en la vista en directo antes de dejar que el GO de la caja arranque
 * una manga de carrera (SocketService.hasLocalLiveViewer). El ensayo hace de ese
 * navegador; sin esto la caja da el GO y la manga se queda en `pending`.
 */
function conectarSocket() {
  const io = require('socket.io-client');
  const sock = io(PW, { transports: ['websocket'] });
  const st = { active: {}, ticks: 0 };
  sock.on('shifts:tick', (d) => { st.active = d.active || {}; st.ticks++; });
  sock.on('connect', () => sock.emit('race:live:join'));
  return { sock, st };
}
/** Espera a que llegue un tick nuevo, para leer un snapshot fresco. */
async function tickFresco(st, timeoutMs = 3000) {
  const n = st.ticks, t0 = Date.now();
  while (st.ticks === n && Date.now() - t0 < timeoutMs) await sleep(80);
  return st.active;
}

// ── Ensayo ─────────────────────────────────────────────────────────────────
async function ensayo() {
  const db = abrirBd();
  const race  = db.prepare("SELECT * FROM races WHERE name = 'Ensayo turnos 24h'").get();
  if (!race) { console.error('No hay carrera de ensayo. Lanza primero con --seed.'); process.exit(1); }
  const manga = db.prepare('SELECT * FROM mangas WHERE race_id = ?').get(race.id);
  const perfiles = db.prepare('SELECT * FROM driver_profiles').all();
  const qrDe = (n) => perfiles.find(p => p.name === n).qr_code;

  const { sock, st } = conectarSocket();
  await sleep(800);

  const checkin = (qr) => post(`${PW}/races/${race.id}/mangas/${manga.id}/checkin`, { qr_code: qr });

  // ── 1. Pre-arme ──────────────────────────────────────────────────────────
  paso('1. Pre-arme: los 24 titulares escanean su QR antes del GO');
  for (let l = 1; l <= 24; l++) {
    const r = await checkin(qrDe(`Titular ${l}`));
    if (r.status !== 200) mal(`checkin Titular ${l} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  let sh = turnos(db, manga.id);
  sh.length === 24 ? ok('24 turnos registrados') : mal(`esperaba 24 turnos, hay ${sh.length}`);
  sh.every(s => s.pre_armed === 1 && s.driving_ms === 0 && s.started_at_ms == null)
    ? ok('pre-armados: nadie cuenta tiempo antes del GO')
    : mal('algún turno ya cuenta tiempo antes del GO');

  // ── 2. GO escalonado ─────────────────────────────────────────────────────
  paso('2. GO escalonado: cada caja arranca con SU propia trama');
  const DESFASE = 10000;
  for (let i = 0; i < EMUS.length; i++) {
    await post(`${EMUS[i]}/api/go`, { durationMin: 4 });
    console.log(`  caja ${i + 1} → GO`);
    if (i < EMUS.length - 1) await sleep(DESFASE);
  }
  await sleep(3000);

  let a = await tickFresco(st);
  const [c1, c9, c17] = [a['1'], a['9'], a['17']];
  if (!c1 || !c9 || !c17) mal(`faltan contadores vivos (hay ${Object.keys(a).length} de 24)`);
  else {
    console.log(`  caja1 ${S(c1.drivingMs)} · caja2 ${S(c9.drivingMs)} · caja3 ${S(c17.drivingMs)}`);
    (c1.drivingMs > c9.drivingMs && c9.drivingMs > c17.drivingMs)
      ? ok('cada caja cuenta desde su propio GO')
      : mal('los contadores no reflejan el GO escalonado');
    Math.abs((c1.drivingMs - c9.drivingMs) - DESFASE) < 2000
      ? ok(`el desfase caja1↔caja2 es el real (${S(c1.drivingMs - c9.drivingMs)})`)
      : mal(`desfase caja1↔caja2 = ${S(c1.drivingMs - c9.drivingMs)}, esperaba ~${S(DESFASE)}`);
    Object.keys(a).length === 24 ? ok('los 24 carriles tienen contador vivo') : mal(`${Object.keys(a).length}/24 contadores`);
  }

  // ── 3. Cambio en caliente ────────────────────────────────────────────────
  paso('3. Cambio de piloto en caliente (carril 1)');
  const antes = (await tickFresco(st))['1'].drivingMs;
  const rc = await checkin(qrDe('Suplente 1'));
  rc.status === 200 ? ok('entra Suplente 1') : mal(`checkin relevo → ${rc.status} ${JSON.stringify(rc.body)}`);
  await sleep(400);

  sh = turnos(db, manga.id);
  const saliente = sh.filter(s => s.lane === 1 && s.ended_at_ms != null).pop();
  const entrante = sh.find(s => s.lane === 1 && s.ended_at_ms == null);
  saliente && Math.abs(saliente.driving_ms - antes) < 1500
    ? ok(`el saliente cierra con su tiempo exacto (${S(saliente.driving_ms)})`)
    : mal(`saliente cerrado con ${saliente ? S(saliente.driving_ms) : '—'}, esperaba ~${S(antes)}`);
  entrante && entrante.driver_name === 'Suplente 1'
    ? ok('el entrante queda abierto y contando')
    : mal('el entrante no quedó abierto');

  // ── 4. Pausa parcial: solo la caja 2 ─────────────────────────────────────
  paso('4. Pausa parcial: se pausa SOLO la caja 2');
  await post(`${EMUS[1]}/api/pause`);
  await sleep(1500);
  const p1 = await tickFresco(st);
  await sleep(8000);
  const p2 = await tickFresco(st);

  const d9 = p2['9'].drivingMs - p1['9'].drivingMs;
  const d1 = p2['1'].drivingMs - p1['1'].drivingMs;
  Math.abs(d9) < 1200 ? ok(`la caja 2 queda congelada (Δ ${S(d9)})`) : mal(`la caja 2 siguió contando: Δ ${S(d9)}`);
  d1 > 6500 ? ok(`las cajas 1 y 3 siguen rodando (Δ ${S(d1)})`) : mal(`la caja 1 no avanzó: Δ ${S(d1)}`);

  // Reanudar NO es instantáneo: el DS-300 repite la secuencia de semáforo
  // (A6 → A2 → A3) y la carrera sigue lógicamente pausada hasta la última trama.
  // Que el contador del piloto no se mueva durante el semáforo es lo correcto:
  // el coche todavía no rueda. Así que medimos desde que el contador arranca.
  const congelado = p2['9'].drivingMs;
  await post(`${EMUS[1]}/api/resume`);

  const tArranque = Date.now();
  let v0 = congelado;
  while (Date.now() - tArranque < 8000) {
    v0 = (await tickFresco(st))['9'].drivingMs;
    if (v0 > congelado + 300) break;
  }
  v0 > congelado + 300
    ? ok(`el contador arranca tras el semáforo (${S(Date.now() - tArranque)} de secuencia)`)
    : mal('el contador no volvió a arrancar tras el resume');
  Math.abs(v0 - congelado) < 3000
    ? ok(`no se le cobra la pausa: reanuda en ${S(v0)}, congeló en ${S(congelado)}`)
    : mal(`al reanudar saltó de ${S(congelado)} a ${S(v0)}: se le cobró la pausa`);

  const t0v = Date.now();
  await sleep(3000);
  const v1 = (await tickFresco(st))['9'].drivingMs;
  const rodado = Date.now() - t0v;
  Math.abs((v1 - v0) - rodado) < 1500
    ? ok(`tras reanudar cuenta a ritmo real (+${S(v1 - v0)} en ${S(rodado)})`)
    : mal(`tras reanudar contó +${S(v1 - v0)} en ${S(rodado)}`);

  // ── 5. Stop forzado, por trama real ──────────────────────────────────────
  paso('5. STOP FORZADO (trama race_stopped de la caja)');
  const acumulado = (await tickFresco(st))['1'].drivingMs;
  console.log(`  el carril 1 llevaba ${S(acumulado)} acumulados`);
  for (const e of EMUS) await post(`${e}/api/stop`);
  await sleep(1500);

  sh = turnos(db, manga.id);
  const porCarril = {};
  sh.forEach(s => { porCarril[s.lane] = (porCarril[s.lane] || 0) + 1; });
  const multiples = Object.entries(porCarril).filter(([, n]) => n !== 1);
  multiples.length === 0
    ? ok('queda exactamente UN turno por carril')
    : mal(`carriles con más de un turno: ${JSON.stringify(multiples)}`);
  sh.every(s => s.driving_ms === 0 && s.pre_armed === 1 && s.started_at_ms == null && s.ended_at_ms == null)
    ? ok('todos a cero, pre-armados, esperando el nuevo GO')
    : mal('algún turno no quedó reiniciado');
  const l1 = sh.find(s => s.lane === 1);
  l1 && l1.driver_name === 'Suplente 1'
    ? ok('el carril 1 conserva a Suplente 1: no hay que reescanear el QR')
    : mal(`el carril 1 tiene a "${l1 ? l1.driver_name : '—'}"`);

  // ── 6. Nuevo GO: recuenta desde cero, y FIN escalonado ───────────────────
  paso('6. Nuevo GO tras el stop forzado, y fin escalonado de las cajas');
  for (let i = 0; i < EMUS.length; i++) {
    await post(`${EMUS[i]}/api/go`, { durationMin: 1 });
    if (i < EMUS.length - 1) await sleep(4000);   // fin escalonado: 4 s entre cajas
  }
  await sleep(6000);
  const nuevo = (await tickFresco(st))['1'];
  nuevo && nuevo.drivingMs < acumulado && Math.abs(nuevo.drivingMs - 14000) < 6000
    ? ok(`el carril 1 recuenta desde cero (${S(nuevo.drivingMs)}), no desde ${S(acumulado)}`)
    : mal(`tras el nuevo GO el carril 1 marca ${nuevo ? S(nuevo.drivingMs) : '—'}`);

  console.log('  esperando el fin natural de cada caja (1 min por caja, escalonado)…');
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const abiertos = turnos(db, manga.id).filter(s => s.ended_at_ms == null).length;
    if (abiertos === 0) break;
    await sleep(2000);
  }

  // ── 7. Fin de manga ──────────────────────────────────────────────────────
  paso('7. Fin de manga');
  sh = turnos(db, manga.id);
  sh.every(s => s.ended_at_ms != null)
    ? ok('todos los turnos quedan cerrados')
    : mal(`quedan ${sh.filter(s => s.ended_at_ms == null).length} turnos abiertos`);
  sh.every(s => s.driving_ms > 0)
    ? ok('todos los pilotos acumularon tiempo')
    : mal('algún turno cerró con 0 ms');

  // Los turnos de la caja 1 deben cerrar ANTES que los de la caja 3 (fin escalonado).
  const finCaja = (lo, hi) => Math.max(...sh.filter(s => s.lane >= lo && s.lane <= hi).map(s => s.ended_at_ms));
  const [f1, f2, f3] = [finCaja(1, 8), finCaja(9, 16), finCaja(17, 24)];
  (f1 < f2 && f2 < f3)
    ? ok(`cada caja cierra sus turnos en SU fin (Δ ${S(f2 - f1)} / ${S(f3 - f2)})`)
    : mal(`los cierres no están escalonados: ${f1} / ${f2} / ${f3}`);

  // Coherencia: el tiempo de un turno nunca puede pasarse de la duración de la manga.
  const durMs = 60000;
  const pasados = sh.filter(s => s.driving_ms > durMs + 5000);
  pasados.length === 0
    ? ok('ningún turno supera la duración de la manga')
    : mal(`${pasados.length} turnos cuentan más que la manga entera`);

  // ── 8. Informe final ─────────────────────────────────────────────────────
  paso('8. Informe final');
  const r = await fetch(`${PW}/races/${race.id}/shifts/report`);
  r.status === 200 ? ok('la pantalla del informe responde') : mal(`informe → HTTP ${r.status}`);
  const html = await r.text();

  const rx = await fetch(`${PW}/races/${race.id}/shifts/report.xlsx`);
  rx.status === 200 && (rx.headers.get('content-type') || '').includes('spreadsheet')
    ? ok('el Excel se descarga')
    : mal(`xlsx → HTTP ${rx.status} ${rx.headers.get('content-type')}`);

  // Los 23 suplentes que nunca ficharon TIENEN que salir, y bajo mínimo. En la
  // plantilla el nombre va seguido de salto de línea, de ahí el \b y el \s.
  const nuncaFicharon = Array.from({ length: 24 }, (_, i) => i + 1).filter(l => l !== 1);
  const ausentes = nuncaFicharon.filter(l => !new RegExp(`>Suplente ${l}\\s`).test(html));
  ausentes.length === 0
    ? ok('los 23 suplentes que nunca ficharon aparecen en el informe')
    : mal(`faltan del informe: ${ausentes.map(l => 'Suplente ' + l).join(', ')}`);

  // 24 = los 23 suplentes + el Titular 1, relevado a los ~21 s (mínimo: 30 s).
  const bajoMin = (html.match(/BAJO MÍNIMO/g) || []).length;
  bajoMin >= 23
    ? ok(`salen marcados BAJO MÍNIMO, no como "OK" (${bajoMin})`)
    : mal(`solo ${bajoMin} marcas de "BAJO MÍNIMO", esperaba ≥23`);

  const filas = (html.match(/vt-cat-dot/g) || []).length;
  filas === 48
    ? ok('el informe lista a los 48 pilotos inscritos')
    : mal(`el informe lista ${filas} pilotos, esperaba 48`);
  !/\d{3,}:\d{2}(?!:)/.test(html) ? ok('los tiempos van en h:mm:ss') : mal('hay tiempos con el formato roto (240:00)');

  sock.close();
  paso(fallos === 0 ? '\x1b[32mENSAYO SUPERADO\x1b[0m' : `\x1b[31mENSAYO CON ${fallos} FALLO(S)\x1b[0m`);
  process.exit(fallos === 0 ? 0 : 1);
}

if (!process.env.SLOTIME_DATA) { console.error('Define SLOTIME_DATA (BD del ensayo).'); process.exit(1); }
if (process.argv.includes('--seed')) seed();
else ensayo().catch(e => { console.error('\n✖ El ensayo se rompió:', e.stack); process.exit(1); });
