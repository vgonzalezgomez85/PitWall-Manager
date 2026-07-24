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
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

// In production (Electron), SLOTIME_DATA is set to app.getPath('userData')
const DB_PATH = process.env.SLOTIME_DATA
  ? path.join(process.env.SLOTIME_DATA, 'slotime.db')
  : path.join(__dirname, '../../database/slotime.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── PRAGMAs de rendimiento ────────────────────────────────────────────────
// WAL + synchronous=NORMAL es la combinación recomendada para apps de
// escritura concurrente moderada y lecturas frecuentes (caso típico
// SloTime: writes ~1-5/s desde TimingService, reads ~100s/s desde clientes).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');     // antes FULL — same WAL safety, ~2-3× faster writes
db.pragma('temp_store  = MEMORY');     // sorts/temp en RAM
db.pragma('cache_size  = -65536');     // 64 MB cache (antes 16 MB) — cabe casi todo
db.pragma('mmap_size   = 268435456');  // 256 MB memory-map para reads paralelos
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');      // espera 5s antes de SQLITE_BUSY (mejor que fail rápido)

// ── Base schema (idempotent) ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS races (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT    NOT NULL,
    type                   TEXT    NOT NULL CHECK(type IN ('club','championship')),
    format                 TEXT    NOT NULL CHECK(format IN ('individual','team')),
    lanes_count            INTEGER NOT NULL DEFAULT 6,
    lane_sequence          TEXT    NOT NULL DEFAULT '[]',
    manga_duration_minutes INTEGER NOT NULL DEFAULT 5,
    status                 TEXT    NOT NULL DEFAULT 'pending',
    created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at             DATETIME,
    finished_at            DATETIME
  );

  CREATE TABLE IF NOT EXISTS tandas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id    INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    number     INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS teams (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id  INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    tanda_id INTEGER REFERENCES tandas(id) ON DELETE SET NULL,
    name     TEXT    NOT NULL,
    lane     INTEGER NOT NULL DEFAULT 0,
    color    TEXT    DEFAULT '#e63946'
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id    INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    tanda_id   INTEGER REFERENCES tandas(id) ON DELETE SET NULL,
    team_id    INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL,
    lane       INTEGER,
    car_number INTEGER
  );

  CREATE TABLE IF NOT EXISTS mangas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tanda_id    INTEGER NOT NULL REFERENCES tandas(id) ON DELETE CASCADE,
    race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    started_at  DATETIME,
    finished_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS manga_lanes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    manga_id  INTEGER NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    lane      INTEGER NOT NULL,
    team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    is_rest   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS laps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    manga_id    INTEGER REFERENCES mangas(id) ON DELETE SET NULL,
    driver_id   INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    lane        INTEGER NOT NULL,
    lap_number  INTEGER NOT NULL,
    lap_time_ms INTEGER NOT NULL,
    elapsed_ms  INTEGER NOT NULL DEFAULT 0,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS driver_profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT 'bronce'
                       CHECK(category IN ('platino','oro','plata','bronce')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Migrations (additive only, safe to re-run) ─────────────────────────────
const migrations = [
  `ALTER TABLE laps     ADD COLUMN elapsed_ms  INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE laps     ADD COLUMN manga_id    INTEGER REFERENCES mangas(id) ON DELETE SET NULL`,
  `ALTER TABLE laps     ADD COLUMN team_id     INTEGER REFERENCES teams(id)  ON DELETE SET NULL`,
  `ALTER TABLE teams    ADD COLUMN tanda_id    INTEGER REFERENCES tandas(id) ON DELETE SET NULL`,
  `ALTER TABLE teams    ADD COLUMN country     TEXT`,
  `ALTER TABLE drivers  ADD COLUMN tanda_id    INTEGER REFERENCES tandas(id) ON DELETE SET NULL`,
  `ALTER TABLE races    ADD COLUMN lane_sequence          TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE races    ADD COLUMN manga_duration_minutes INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE laps     ADD COLUMN is_exit INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE races    ADD COLUMN circuits_config TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE races ADD COLUMN has_pole INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS pole_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id     INTEGER NOT NULL UNIQUE,
    lane        INTEGER NOT NULL DEFAULT 1,
    status      TEXT    NOT NULL DEFAULT 'setup',
    current_idx INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS pole_entries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pole_session_id  INTEGER NOT NULL,
    entity_type      TEXT    NOT NULL,
    entity_name      TEXT    NOT NULL,
    members_json     TEXT,
    order_idx        INTEGER,
    lap_time_ms      INTEGER
  )`,
  `ALTER TABLE pole_sessions ADD COLUMN current_idx INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pole_entries  ADD COLUMN order_idx INTEGER`,
  `UPDATE pole_sessions SET status = 'in_progress' WHERE status = 'timing'`,
  `ALTER TABLE laps ADD COLUMN is_ghost INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE laps ADD COLUMN source_lap_id INTEGER REFERENCES laps(id) ON DELETE SET NULL`,
  `CREATE TABLE IF NOT EXISTS circuits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    circuits_count  INTEGER NOT NULL DEFAULT 1,
    circuits_config TEXT    NOT NULL DEFAULT '[]',
    lanes_count     INTEGER NOT NULL DEFAULT 6,
    min_lap_ms      INTEGER NOT NULL DEFAULT 0,
    description     TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE races ADD COLUMN circuit_id INTEGER REFERENCES circuits(id) ON DELETE SET NULL`,
  `ALTER TABLE races ADD COLUMN min_lap_ms INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE laps ADD COLUMN ghost_from_lane INTEGER`,
  // A pit-stop is a special kind of exit: lap_time ≥ 2 × avg (the car wasn't
  // just out, it stopped for a long-enough fix that we display a wrench icon).
  `ALTER TABLE laps ADD COLUMN is_pit_stop INTEGER NOT NULL DEFAULT 0`,

  // Primera vuelta REAL de cada manga por carril — NO compite por mejor vuelta
  // (el primer tiempo suele estar inflado/desinflado por el cruce inicial,
  // semáforo, etc.). Sí cuenta para totales, media y proyección.
  `ALTER TABLE laps ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0`,

  // Pasadas y repetir-carril (sprint + resistencia):
  //   passes      = nº de veces que se repite la SECUENCIA de carriles entera
  //                 (P pasadas → P× más mangas, la rotación encadenada).
  //   lane_repeat = cada carril se corre R veces como UN solo stint más largo
  //                 (la duración efectiva de cada manga = base × R).
  `ALTER TABLE races ADD COLUMN passes      INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE races ADD COLUMN lane_repeat INTEGER NOT NULL DEFAULT 1`,

  // ── Teams catalog ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS teams_catalog (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    color      TEXT    NOT NULL DEFAULT '#8b949e',
    notes      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS teams_catalog_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id    INTEGER NOT NULL REFERENCES teams_catalog(id) ON DELETE CASCADE,
    driver_id  INTEGER REFERENCES driver_profiles(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
  )`,
  `ALTER TABLE teams_catalog ADD COLUMN country TEXT`,
  `ALTER TABLE teams_catalog ADD COLUMN categoria TEXT`,
  `ALTER TABLE teams_catalog ADD COLUMN coche TEXT`,
  `ALTER TABLE teams_catalog ADD COLUMN car_photo TEXT`,
  `CREATE TABLE IF NOT EXISTS driver_shifts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    manga_id    INTEGER NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
    race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    lane        INTEGER NOT NULL,
    team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    driver_id   INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    driver_name TEXT    NOT NULL,
    started_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // OJO: SQLite no permite ADD COLUMN con UNIQUE en un solo ALTER. La
  // antigua migración `ALTER TABLE driver_profiles ADD COLUMN qr_code TEXT
  // UNIQUE` fallaba silenciosamente en BDs frescas → la columna no se
  // creaba. Se separa en dos pasos: ADD COLUMN + UNIQUE INDEX parcial
  // (parcial para que múltiples NULL no colisionen entre sí).
  `ALTER TABLE driver_profiles ADD COLUMN qr_code TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_profiles_qr_code
     ON driver_profiles(qr_code) WHERE qr_code IS NOT NULL`,
  `ALTER TABLE circuits ADD COLUMN lane_sequence TEXT NOT NULL DEFAULT '[]'`,

  // Track minimap: imagen del circuito (base64 data URL) + polilínea relativa
  // (array JSON de [x, y] en coords 0..1 sobre el ancho/alto de la imagen).
  `ALTER TABLE circuits ADD COLUMN track_image_b64    TEXT`,
  `ALTER TABLE circuits ADD COLUMN track_outline_json TEXT NOT NULL DEFAULT '[]'`,
  // Sentido del circuito para la simulación del minimapa: 'cw' (horario) o 'ccw' (antihorario)
  `ALTER TABLE circuits ADD COLUMN track_direction TEXT NOT NULL DEFAULT 'cw'`,

  // ── Categories & cars ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS cars (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    brand       TEXT NOT NULL,
    model       TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    description TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS circuit_category_times (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    circuit_id  INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    min_lap_ms  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(circuit_id, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS race_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(race_id, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS competition_training_results (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL,
    heat_number       INTEGER NOT NULL,
    lane              INTEGER NOT NULL,
    participant_name  TEXT NOT NULL,
    team_id           INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    driver_id         INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
    best_lap_ms       INTEGER,
    avg_lap_ms        INTEGER,
    lap_count         INTEGER DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // ── Índices de rendimiento sobre `laps` ───────────────────────────────────
  // Sin estos, raceBestByLane (subquery correlacionada) hace escaneo completo
  // y se vuelve O(N²) con miles de vueltas — medidos 642ms p50 con 4800 filas.
  // Con índice por (race_id, lane) y filtros, baja a sub-milisegundo.
  `CREATE INDEX IF NOT EXISTS idx_laps_race_lane         ON laps(race_id, lane)`,
  `CREATE INDEX IF NOT EXISTS idx_laps_manga             ON laps(manga_id)`,
  `CREATE INDEX IF NOT EXISTS idx_laps_race_flags        ON laps(race_id, is_ghost, is_exit, lap_number)`,
  `CREATE INDEX IF NOT EXISTS idx_laps_race_team_driver  ON laps(race_id, team_id, driver_id)`,
  // ORDER BY elapsed_ms es la consulta de "última vuelta por carril en manga"
  `CREATE INDEX IF NOT EXISTS idx_laps_manga_lane_elapsed ON laps(manga_id, lane, elapsed_ms)`,
  // source_lap_id usado para vincular vueltas reasignadas / restore
  `CREATE INDEX IF NOT EXISTS idx_laps_source            ON laps(source_lap_id)`,

  // ── Índices sobre el resto de tablas relacionales ────────────────────────
  // FKs muy consultadas en JOINs y filtros (CADA standings/live page lo usa)
  `CREATE INDEX IF NOT EXISTS idx_tandas_race            ON tandas(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mangas_tanda           ON mangas(tanda_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mangas_race            ON mangas(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mangas_race_status     ON mangas(race_id, status)`,

  `CREATE INDEX IF NOT EXISTS idx_manga_lanes_manga      ON manga_lanes(manga_id)`,
  `CREATE INDEX IF NOT EXISTS idx_manga_lanes_team       ON manga_lanes(team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_manga_lanes_driver     ON manga_lanes(driver_id)`,

  `CREATE INDEX IF NOT EXISTS idx_teams_race             ON teams(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_tanda            ON teams(tanda_id)`,

  `CREATE INDEX IF NOT EXISTS idx_drivers_race           ON drivers(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_tanda          ON drivers(tanda_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_team           ON drivers(team_id)`,

  `CREATE INDEX IF NOT EXISTS idx_cars_category          ON cars(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pole_sessions_race     ON pole_sessions(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pole_entries_session   ON pole_entries(pole_session_id, order_idx)`,
  `CREATE INDEX IF NOT EXISTS idx_race_categories_race   ON race_categories(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_race_categories_cat    ON race_categories(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tc_members_team        ON teams_catalog_members(team_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_ctr_session            ON competition_training_results(session_id, heat_number)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_shifts_manga    ON driver_shifts(manga_id)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_shifts_race     ON driver_shifts(race_id)`,

  // ── Driver shifts: precisión temporal ───────────────────────────────────
  // started_at_ms / ended_at_ms: epoch ms (más precisos que DATETIME ascii)
  // driving_ms: tiempo efectivo conducido por el piloto en ese turno,
  //             descontando pausas (incrementado por TimingService cada tick).
  // pre_armed: 1 si el shift se creó durante standby (manga aún pending).
  //            Al arrancar la manga se ponen a 0 y se setea started_at_ms.
  `ALTER TABLE driver_shifts ADD COLUMN started_at_ms INTEGER`,
  `ALTER TABLE driver_shifts ADD COLUMN ended_at_ms   INTEGER`,
  `ALTER TABLE driver_shifts ADD COLUMN driving_ms    INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE driver_shifts ADD COLUMN pre_armed     INTEGER NOT NULL DEFAULT 0`,
  // manual=1: turno creado a mano (corrección) porque el equipo olvidó fichar.
  `ALTER TABLE driver_shifts ADD COLUMN manual        INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_driver_shifts_open ON driver_shifts(manga_id, lane) WHERE ended_at_ms IS NULL`,

  // ── Race: límites de tiempo por piloto + ventana de bloqueo ─────────────
  // driver_min_total_ms / driver_max_total_ms: ms acumulados a lo largo de
  //   toda la carrera (suma de mangas). 0 = sin límite.
  // driver_change_lockout_ms: ms desde el final de la manga durante los que
  //   no se permite cambio de piloto. Default 120000 (2 minutos).
  `ALTER TABLE races ADD COLUMN driver_min_total_ms     INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE races ADD COLUMN driver_max_total_ms     INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE races ADD COLUMN driver_change_lockout_ms INTEGER NOT NULL DEFAULT 120000`,
  // driver_max_runs: nº máximo de turnos (relevos) que puede hacer un piloto a
  //   lo largo de toda la carrera. 0 = sin límite. Solo aviso visual.
  `ALTER TABLE races ADD COLUMN driver_max_runs INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_circuit_cat_times_circuit ON circuit_category_times(circuit_id, category_id)`,
  // Duración real (ms) que el DS-300 mandó al GO de cada manga. La escribe
  // TimingService.startManga. La usa la clasificación estimada para no caer al
  // placeholder manga_duration_minutes (p.ej. 99) en mangas terminadas/recargas.
  `ALTER TABLE mangas ADD COLUMN actual_duration_ms INTEGER`,
  // "Coma": fracción estimada de la vuelta en curso cuando cayó la bandera de
  // la manga (0..0.99). La escribe TimingService.stopManga. Con un solo sensor
  // en meta es una estimación: (fin − último cruce) / media limpia del carril.
  // Se acumula por entidad en la clasificación como desempate a igual vueltas.
  `ALTER TABLE manga_lanes ADD COLUMN coma REAL NOT NULL DEFAULT 0`,
  // PIN de 4 dígitos por equipo para el cliente web "Lap" (timing del equipo
  // desde el móvil). Se genera bajo demanda; ver Team.ensureLapPins.
  `ALTER TABLE teams ADD COLUMN lap_pin TEXT`,

  // race_key: identificador ESTABLE de la carrera (uuid) que sobrevive al
  // export/import entre instancias distintas (feature maestro/esclavo). El
  // `races.id` autoincrement NO sirve entre BDs; el par (race_key, tanda.number,
  // manga.number) sí identifica una manga de forma estable. Nullable + backfill
  // (SQLite no permite ADD COLUMN UNIQUE en un solo paso → índice único parcial).
  `ALTER TABLE races ADD COLUMN race_key TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_races_race_key
     ON races(race_key) WHERE race_key IS NOT NULL`,

  // ── Rehidratación de sesión tras una caída ────────────────────────────────
  //
  // El estado de cada circuito (si corre, si está en pausa, su ancla de tiempo ya
  // desplazada por las pausas, cuánto le queda) vivía SOLO en memoria. Si el
  // proceso moría con una manga corriendo, la manga quedaba 'active' en BD pero
  // sin cronometraje, y no había forma de recuperarla: solo de cancelarla.
  //
  // De `laps` se reconstruye todo lo demás (vueltas, medias, mejor vuelta, último
  // cruce). Esta tabla guarda lo único que faltaba. Se escribe en cada transición
  // (GO, pausa, reanudar, fin) y cada pocos segundos con el tick.
  `CREATE TABLE IF NOT EXISTS manga_circuits (
     manga_id        INTEGER NOT NULL,
     circuit_index   INTEGER NOT NULL,
     status          TEXT    NOT NULL,
     start_time_ms   INTEGER,
     end_time_ms     INTEGER,
     pause_start_ms  INTEGER,
     duration_ms     INTEGER NOT NULL,
     elapsed_ms      INTEGER NOT NULL DEFAULT 0,
     updated_at_ms   INTEGER NOT NULL,
     PRIMARY KEY (manga_id, circuit_index)
   )`,

  // Vueltas que PitWall no vio (estuvo caído, o llegaron con el circuito ya
  // cerrado) y se reponen con la media del carril. El equipo no pierde la vuelta
  // —que es lo que decide la carrera— pero queda constancia de que su tiempo es
  // una estimación. La reconciliación del cruce "en la bandera" también las marca.
  `ALTER TABLE laps ADD COLUMN is_estimated INTEGER NOT NULL DEFAULT 0`,

  // Transcurrido del circuito en el instante en que se persistió `driving_ms`.
  // Sin esto, al rehidratar un turno abierto no se sabría desde qué punto seguir
  // contando, y se le regalaría (o se le robaría) al piloto el tiempo de la caída.
  `ALTER TABLE driver_shifts ADD COLUMN elapsed_at_ms INTEGER`,

  // Qué hacer con los carriles libres cuando una tanda tiene MENOS participantes
  // que carriles activos:
  //   'fixed'  → los carriles de mayor número quedan siempre vacíos (nadie corre
  //              por ellos); comportamiento histórico (Manga.buildSchedule usaba
  //              activeLanes.slice(0, N)).
  //   'rotate' → el hueco rota manga a manga para que todos pasen por los mismos
  //              carriles (se rellena la rotación con huecos vacíos que NO generan
  //              fila en manga_lanes → ni vueltas ni clasificación).
  // Se lee al (re)generar el horario en creación y edición de la tanda.
  `ALTER TABLE tandas ADD COLUMN empty_lane_mode TEXT NOT NULL DEFAULT 'fixed'`,

  // Dotación de neumáticos por equipo en carreras de resistencia. Nº de PARES
  // (2 ruedas) que se suministran a CADA equipo para toda la carrera; igual para
  // todos. 0 = sin control de neumáticos (comportamiento histórico). Se fija en
  // el asistente de creación (solo championship/resistencia) y es la base del
  // control de cambios de neumáticos que se lleva durante la carrera.
  `ALTER TABLE races ADD COLUMN tire_pairs_per_team INTEGER NOT NULL DEFAULT 0`,

  // Registro de cambios de neumáticos durante la carrera (control de dotación).
  // Cada fila = UN juego entregado a un equipo. Los "disponibles" de un equipo
  // se DERIVAN: races.tire_pairs_per_team − COUNT(filas del equipo); los "usados"
  // son ese COUNT. No se guardan contadores, así deshacer = borrar la última fila
  // y nunca hay descuadre. `team_id` es el id CANÓNICO del equipo (el menor de
  // las filas con el mismo nombre en la carrera; una carrera con tandas tiene
  // varias filas por equipo), igual criterio que el cliente Lap. `manga_id`/
  // `manga_number`/`race_elapsed_ms` capturan cuándo se hizo el cambio: en qué
  // manga y en qué minuto:segundo de carrera; quedan NULL si no había manga viva.
  `CREATE TABLE IF NOT EXISTS tire_changes (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     race_id         INTEGER NOT NULL REFERENCES races(id)  ON DELETE CASCADE,
     team_id         INTEGER NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
     manga_id        INTEGER REFERENCES mangas(id) ON DELETE SET NULL,
     manga_number    INTEGER,
     race_elapsed_ms INTEGER,
     created_at_ms   INTEGER NOT NULL,
     note            TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tire_changes_race_team ON tire_changes(race_id, team_id)`,
];
for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (err) {
    // Errores esperados (la migración ya se aplicó): silencio.
    // Cualquier otro → log para no esconder bugs como el de ADD COLUMN UNIQUE.
    const msg = err.message || '';
    const expected = /duplicate column name|already exists/i.test(msg);
    if (!expected) {
      console.error('[migration] error en SQL:\n  ', sql.replace(/\s+/g, ' ').slice(0, 200));
      console.error('  →', msg);
    }
  }
}

// Assign qr_code to any driver_profile that doesn't have one yet
// (only runs if the column exists, i.e. migration already applied)
try {
  const profilesWithoutQR = db.prepare('SELECT id FROM driver_profiles WHERE qr_code IS NULL').all();
  const setQR = db.prepare('UPDATE driver_profiles SET qr_code = ? WHERE id = ?');
  for (const p of profilesWithoutQR) {
    setQR.run(`DRV:${p.id}`, p.id);
  }
} catch { /* column not yet created on very first run — migration handles it */ }

// Backfill race_key (uuid estable) para carreras que aún no lo tienen.
try {
  const { randomUUID } = require('crypto');
  const racesWithoutKey = db.prepare('SELECT id FROM races WHERE race_key IS NULL').all();
  const setKey = db.prepare('UPDATE races SET race_key = ? WHERE id = ?');
  for (const r of racesWithoutKey) setKey.run(randomUUID(), r.id);
} catch { /* columna aún no creada en primera ejecución — la migración la crea */ }

// ── Estadísticas para el planificador ──────────────────────────────────────
//
// Sin ANALYZE, SQLite planifica a ciegas y para las consultas que agregan una
// carrera entera elige `idx_laps_race_flags`. Es una mala elección: su segunda
// columna es `is_ghost`, y `is_ghost = 0` lo cumplen 178.807 de las 178.809
// vueltas reales de la BD — el índice no descarta NADA y encima se paga la
// indirección por cada fila. Con estadísticas, el planificador prefiere el
// escaneo directo. Medido sobre las 160.569 vueltas de la 24h de Modena:
//     mejor vuelta por carril ....... 78 ms → 18 ms
//     agregado de la carrera ........ 63 ms → 30 ms
//     agregado de mangas anteriores . 71 ms → 39 ms
// Ninguna de las consultas calientes empeora; las demás se quedan igual.
//
// Se rehace en CADA arranque (~45 ms con 180.000 vueltas; 0,05 ms en una BD
// vacía) en vez de una sola vez, para que las estadísticas sigan a la BD según
// crece. Dentro de una carrera de 24 h se quedan cortas —la carrera nueva crece
// bajo los pies del planificador—, pero el error cae del lado bueno: subestimar
// el tamaño de una carrera le hace preferir el índice, que es justo lo que elige
// hoy sin estadísticas. El caso peor es el comportamiento actual.
//
// `PRAGMA optimize` (lo que recomienda SQLite para esto) NO sirve aquí: cuesta
// 2 ms pero deja unas estadísticas que no cambian el plan — medido, 69 ms, lo
// mismo que sin nada.
try {
  db.exec('ANALYZE');
} catch (err) {
  // Es una optimización, no un requisito: si la BD está bloqueada o montada en
  // solo lectura, se arranca igual, con los planes de siempre.
  console.error('[db] ANALYZE no pudo ejecutarse:', err.message);
}

module.exports = db;
