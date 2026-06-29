// Alta de la carrera real "24h Modena" (resistencia 24h, 22 equipos, 3 circuitos 8+8+6).
// Reconstruye las 21 rotaciones completas (parciales 1..21 del RegistroSucesos de TicTac;
// la 22ª se abortó). Por cada (rotación, equipo) genera las vueltas individuales de forma
// que el mínimo = Rápida, la media = Media y el máximo = Lenta coincidan con TicTac, por lo
// que la clasificación calculada reproduce el resultado oficial (PDF).
//
// Datos de entrada: modena.json (generado por scratchpad/parse-modena.js a partir de
// "info para proyecto infolap slot/RegistroSucesos.txt").
//
// Uso: node scripts/seed-modena-24h.js /ruta/a/modena.json

const path = require('path');
const fs = require('fs');
const db = require('../src/config/database');
const Race = require('../src/models/Race');
const Tanda = require('../src/models/Tanda');
const Team = require('../src/models/Team');

const DATA = process.argv[2] || path.join(__dirname, 'modena.json');
const { teams: TEAM_NAMES, parciales } = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const RACE_NAME = '24h Modena';
const LANE_SEQUENCE = [1,3,5,7,9,11,13,15,17,19,21,22,20,18,16,14,12,10,8,6,4,2];
const CIRCUITS = [8, 8, 6];           // 2 circuitos de 8 carriles + 1 de 6 = 22
const MIN_LAP_MS = 8500;              // "Tiempo mínimo por vuelta: 8.5s"
const MANGA_MIN = 57;                 // mangas de 57 minutos
const MANGA_MS = MANGA_MIN * 60 * 1000;

// Paleta de 22 colores bien diferenciados (HSL repartido).
const COLORS = Array.from({ length: 22 }, (_, i) => {
  const h = Math.round((i * 360) / 22);
  return `hsl(${h}, 70%, 50%)`;
});

// ── Generador de vueltas ────────────────────────────────────────────────────
// Devuelve N tiempos (ms) tal que las métricas de PitWall reproducen TicTac:
//   · aggregateByRace.best  = MIN(is_exit=0, is_warmup=0, lap_number>1)        = Rápida
//   · aggregateByRace.avg   = AVG(is_warmup=0)            [incluye la vuelta 1] = Media
//   · perLaneByEntity.avg   = AVG(lap_number>1)           [excluye la vuelta 1] = Media
//   · perLaneByEntity.worst = MAX(lap_number>1)           [excluye la vuelta 1] = Lenta
// Por eso: vuelta 1 = Media (neutra para ambos AVG), vuelta 2 = Rápida (mejor),
// vuelta 3 = Lenta (peor), y el resto rellenos para cuadrar la media exacta.
function genLaps(N, best, avg, worst) {
  if (N <= 0) return [];
  if (avg == null)   avg = (best != null && worst != null) ? Math.round((best + worst) / 2) : (best != null ? best : worst);
  if (best == null)  best = avg;
  if (worst == null) worst = avg;
  if (worst <= best) worst = best + 1;
  if (N === 1) return [avg];
  if (N === 2) return [avg, best];
  if (N === 3) return [avg, best, worst];

  const fillersCount = N - 3;
  const target = Math.round(avg * N);                  // suma total deseada (media exacta)
  let fillersSum = target - avg - best - worst;
  let base = Math.round(fillersSum / fillersCount);
  if (base <= best) base = best + 1;
  if (base >= worst) base = worst - 1;
  const fillers = new Array(fillersCount).fill(base);
  let diff = fillersSum - base * fillersCount;         // ajuste fino para cuadrar la suma
  let i = 0, guard = 0;
  while (diff !== 0 && guard < fillersCount * 4) {
    const step = diff > 0 ? 1 : -1;
    const v = fillers[i % fillersCount] + step;
    if (v > best && v < worst) { fillers[i % fillersCount] = v; diff -= step; }
    i++; guard++;
  }
  return [avg, best, worst, ...fillers];
}

// ── Fechas de cada rotación (la carrera cruza la medianoche) ─────────────────
// Sábado 20-jun-2026 (parcial 1 termina a las 12:42). finished_at = hora del
// parcial; started_at = finished_at − 57 min.
function buildDates(parciales) {
  let day = 20, prevSecs = null;
  return parciales.map(p => {
    const [hh, mm, rest] = p.time.split(':');
    const [ss, mmm] = rest.split('.');
    const h = +hh, m = +mm, s = +ss, ms = +mmm;
    const secs = h * 3600 + m * 60 + s;
    if (prevSecs != null && secs < prevSecs) day++;   // cambio de día
    prevSecs = secs;
    const finished = new Date(Date.UTC(2026, 5, day, h, m, s, ms));
    const started = new Date(finished.getTime() - MANGA_MS);
    return { started, finished };
  });
}

const dates = buildDates(parciales);

// ── Limpieza idempotente ─────────────────────────────────────────────────────
const existing = db.prepare('SELECT id FROM races WHERE name = ?').all(RACE_NAME);
if (existing.length) {
  const wipe = db.transaction(ids => {
    for (const { id } of ids) {
      db.prepare('DELETE FROM laps WHERE race_id=?').run(id);
      db.prepare('DELETE FROM manga_lanes WHERE manga_id IN (SELECT id FROM mangas WHERE race_id=?)').run(id);
      db.prepare('DELETE FROM mangas WHERE race_id=?').run(id);
      db.prepare('DELETE FROM driver_shifts WHERE race_id=?').run(id);
      db.prepare('DELETE FROM drivers WHERE race_id=?').run(id);
      db.prepare('DELETE FROM teams WHERE race_id=?').run(id);
      db.prepare('DELETE FROM tandas WHERE race_id=?').run(id);
      db.prepare('DELETE FROM races WHERE id=?').run(id);
    }
  });
  wipe(existing);
  console.log(`Borradas ${existing.length} carrera(s) "${RACE_NAME}" previas.`);
}

// ── Alta de carrera + tanda + equipos ────────────────────────────────────────
const raceId = Race.create({
  name: RACE_NAME,
  type: 'club',
  format: 'team',
  lanes_count: 22,
  lane_sequence: LANE_SEQUENCE,
  manga_duration_minutes: MANGA_MIN,
  circuits: CIRCUITS,
  has_pole: 0,
  min_lap_ms: MIN_LAP_MS,
});
const tandaId = Tanda.create(raceId);

const teamIdByName = {};
TEAM_NAMES.forEach((name, i) => {
  teamIdByName[name] = Team.create({
    race_id: raceId, tanda_id: tandaId, name, lane: 0, color: COLORS[i % COLORS.length],
  });
});
console.log(`Carrera #${raceId} "${RACE_NAME}" creada con ${TEAM_NAMES.length} equipos.`);

// ── Mangas (1 por rotación) + asignación de carriles + vueltas ────────────────
const insManga = db.prepare(
  `INSERT INTO mangas (tanda_id, race_id, number, status, started_at, finished_at, actual_duration_ms)
   VALUES (?, ?, ?, 'finished', ?, ?, ?)`);
const insLane = db.prepare(
  `INSERT INTO manga_lanes (manga_id, lane, team_id, driver_id, is_rest, coma) VALUES (?, ?, ?, NULL, 0, ?)`);
const insLap = db.prepare(
  `INSERT INTO laps (race_id, manga_id, team_id, driver_id, lane, lap_number, lap_time_ms, elapsed_ms,
                     is_exit, is_ghost, is_pit_stop, is_warmup, timestamp)
   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, 0, 0, ?)`);

let totalLaps = 0;
const run = db.transaction(() => {
  parciales.forEach((p, idx) => {
    const { started, finished } = dates[idx];
    const startMs = started.getTime();
    const { lastInsertRowid: mangaId } = insManga.run(
      tandaId, raceId, p.n, started.toISOString(), finished.toISOString(), MANGA_MS);

    p.rows.forEach(r => {
      const teamId = teamIdByName[r.name];
      insLane.run(mangaId, r.lane, teamId, (r.coma || 0) / 1000);
      if (!r.vp || r.vp <= 0) return;

      const times = genLaps(r.vp, r.rapida, r.media, r.lenta);
      let elapsed = 0;
      for (let k = 0; k < times.length; k++) {
        elapsed += times[k];
        const ts = new Date(startMs + elapsed).toISOString();
        insLap.run(raceId, mangaId, teamId, r.lane, k + 1, times[k], elapsed, ts);
        totalLaps++;
      }
    });
  });
});
run();

Race.updateStatus(raceId, 'finished');
Tanda.updateStatus(tandaId, 'finished');

console.log(`Insertadas ${parciales.length} mangas y ${totalLaps} vueltas.`);
console.log('Hecho.');
