const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

// In production (Electron), SLOTIME_DATA is set to app.getPath('userData')
const DB_PATH = process.env.SLOTIME_DATA
  ? path.join(process.env.SLOTIME_DATA, 'slotime.db')
  : path.join(__dirname, '../../database/slotime.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* already exists */ }
}

module.exports = db;
