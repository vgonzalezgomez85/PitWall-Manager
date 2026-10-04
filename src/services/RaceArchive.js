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

const zlib   = require('zlib');
const crypto = require('crypto');
const db     = require('../config/database');

// ── RaceArchive ─────────────────────────────────────────────────────────────
// Archivo .pwrace: UNA carrera completa (configuración, tandas, mangas, equipos,
// pilotos, vueltas, turnos, neumáticos, sucesos, verificaciones, pole…) para
// llevársela a otro PitWall sin mover la base de datos entera.
//
// A diferencia de RaceTransfer (Race Link: solo la estructura, sin vueltas), aquí
// viajan las filas tal cual. Al importar se crean filas NUEVAS y se remapean todos
// los ids; lo único que se busca en el destino es el circuito y las categorías
// (por nombre). El race_key se conserva: si ya existe, la carrera ya está aquí.
//
// Columnas: se exportan todas (SELECT *) y al importar solo se escriben las que
// existen en la tabla de destino, así un archivo de una versión más nueva o más
// vieja de PitWall sigue entrando.

const FORMAT  = 'pitwall-race';
const VERSION = 1;

class RaceArchiveError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RaceArchiveError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function rows(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

const _colsCache = new Map();
function columnsOf(table) {
  if (!_colsCache.has(table)) {
    _colsCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)));
  }
  return _colsCache.get(table);
}

// Inserta `row` (con `overrides` encima) escribiendo solo columnas que existen en
// destino. `id` nunca se copia: lo asigna el autoincrement.
const _stmtCache = new Map();
function insertRow(table, row, overrides = {}) {
  const cols = columnsOf(table);
  const data = { ...row, ...overrides };
  const keys = Object.keys(data).filter(k => k !== 'id' && cols.has(k));
  const sig = table + '|' + keys.join(',');
  let stmt = _stmtCache.get(sig);
  if (!stmt) {
    stmt = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`);
    _stmtCache.set(sig, stmt);
  }
  const params = {};
  for (const k of keys) params[k] = data[k];
  return stmt.run(params).lastInsertRowid;
}

const remap = (map, oldId) => (oldId == null ? null : (map.get(oldId) ?? null));

const RaceArchive = {
  RaceArchiveError,
  FORMAT,
  VERSION,

  // ¿Se puede exportar? Una manga sin cerrar (active) dejaría la copia a medias
  // y, al importarla, el arranque la "recuperaría" como si estuviera corriendo.
  openMangaCount(raceId) {
    return db.prepare("SELECT COUNT(*) AS n FROM mangas WHERE race_id = ? AND status = 'active'").get(raceId).n;
  },

  exportRace(raceId) {
    const race = db.prepare('SELECT * FROM races WHERE id = ?').get(raceId);
    if (!race) throw new RaceArchiveError('not_found', `Carrera ${raceId} no encontrada`);
    if (this.openMangaCount(raceId) > 0) {
      throw new RaceArchiveError('open_manga', 'La carrera tiene una manga sin cerrar');
    }
    if (!race.race_key) {
      race.race_key = crypto.randomUUID();
      db.prepare('UPDATE races SET race_key = ? WHERE id = ?').run(race.race_key, race.id);
    }

    const mangaIds = `SELECT id FROM mangas WHERE race_id = ?`;
    const t = {
      tandas:         rows('SELECT * FROM tandas WHERE race_id = ? ORDER BY id', raceId),
      teams:          rows('SELECT * FROM teams WHERE race_id = ? ORDER BY id', raceId),
      drivers:        rows('SELECT * FROM drivers WHERE race_id = ? ORDER BY id', raceId),
      mangas:         rows('SELECT * FROM mangas WHERE race_id = ? ORDER BY id', raceId),
      manga_lanes:    rows(`SELECT * FROM manga_lanes WHERE manga_id IN (${mangaIds}) ORDER BY id`, raceId),
      manga_circuits: rows(`SELECT * FROM manga_circuits WHERE manga_id IN (${mangaIds})`, raceId),
      laps:           rows('SELECT * FROM laps WHERE race_id = ? ORDER BY id', raceId),
      driver_shifts:  rows('SELECT * FROM driver_shifts WHERE race_id = ? ORDER BY id', raceId),
      tire_changes:   rows('SELECT * FROM tire_changes WHERE race_id = ? ORDER BY id', raceId),
      race_events:    rows('SELECT * FROM race_events WHERE race_id = ? ORDER BY id', raceId),
      lap_tracking:   rows('SELECT * FROM lap_tracking WHERE race_id = ?', raceId),
      verifications:  rows('SELECT * FROM verifications WHERE race_id = ? ORDER BY id', raceId),
      pole_sessions:  rows('SELECT * FROM pole_sessions WHERE race_id = ? ORDER BY id', raceId),
      pole_entries:   rows(`SELECT * FROM pole_entries WHERE pole_session_id IN (SELECT id FROM pole_sessions WHERE race_id = ?) ORDER BY id`, raceId),
    };

    const circuit = race.circuit_id != null
      ? db.prepare('SELECT * FROM circuits WHERE id = ?').get(race.circuit_id) || null
      : null;
    const categories = rows(`
      SELECT c.name FROM race_categories rc JOIN categories c ON c.id = rc.category_id
      WHERE rc.race_id = ? ORDER BY c.name`, raceId).map(r => r.name);

    let appVersion = null;
    try { appVersion = require('../../package.json').version; } catch {}

    return {
      format: FORMAT,
      version: VERSION,
      appVersion,
      exportedAt: new Date().toISOString(),
      race,
      circuit,
      categories,
      tables: t,
    };
  },

  // Archivo comprimido listo para descargar.
  exportRaceFile(raceId) {
    const archive = this.exportRace(raceId);
    return { archive, buffer: zlib.gzipSync(Buffer.from(JSON.stringify(archive)), { level: 6 }) };
  },

  // Buffer (gzip o JSON plano) → objeto validado.
  parseFile(buffer) {
    let text;
    try {
      text = (buffer[0] === 0x1f && buffer[1] === 0x8b) ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
    } catch {
      throw new RaceArchiveError('bad_file', 'El archivo está dañado o no es una carrera de PitWall');
    }
    let archive;
    try { archive = JSON.parse(text); } catch {
      throw new RaceArchiveError('bad_file', 'El archivo está dañado o no es una carrera de PitWall');
    }
    if (!archive || archive.format !== FORMAT || !archive.race || !archive.tables) {
      throw new RaceArchiveError('bad_file', 'El archivo no es una carrera exportada de PitWall');
    }
    if (archive.version > VERSION) {
      throw new RaceArchiveError('newer_version', 'El archivo viene de una versión más nueva de PitWall; actualiza esta instalación');
    }
    return archive;
  },

  // Objeto → { raceId, name, laps } en ESTA BD. Todo en una transacción.
  importRace(archive) {
    const src = archive.race;
    const T = archive.tables || {};
    const list = name => (Array.isArray(T[name]) ? T[name] : []);

    if (src.race_key) {
      const existing = db.prepare('SELECT id, name FROM races WHERE race_key = ?').get(src.race_key);
      if (existing) {
        throw new RaceArchiveError('exists', 'Esta carrera ya está en este PC', { existingId: existing.id, existingName: existing.name });
      }
    }

    const run = db.transaction(() => {
      // Circuito: el del mismo nombre si ya existe aquí; si no, se crea.
      let circuitId = null, circuitCreated = false;
      if (archive.circuit && archive.circuit.name) {
        const found = db.prepare('SELECT id FROM circuits WHERE lower(trim(name)) = lower(trim(?))').get(archive.circuit.name);
        circuitCreated = !found;
        circuitId = found ? found.id : insertRow('circuits', archive.circuit);
      }

      // Una carrera "activa" importada se queda pendiente: así nunca se queda con
      // el próximo GO de este PC (app.js arma la 1ª manga pendiente de una activa).
      const raceId = insertRow('races', src, {
        circuit_id: circuitId,
        status: src.status === 'active' ? 'pending' : src.status,
        race_key: src.race_key || crypto.randomUUID(),
      });

      const tandaMap = new Map(), teamMap = new Map(), driverMap = new Map();
      const mangaMap = new Map(), lapMap = new Map(), poleMap = new Map();

      for (const r of list('tandas')) tandaMap.set(r.id, insertRow('tandas', r, { race_id: raceId }));
      for (const r of list('teams')) {
        teamMap.set(r.id, insertRow('teams', r, { race_id: raceId, tanda_id: remap(tandaMap, r.tanda_id) }));
      }
      for (const r of list('drivers')) {
        driverMap.set(r.id, insertRow('drivers', r, {
          race_id: raceId, tanda_id: remap(tandaMap, r.tanda_id), team_id: remap(teamMap, r.team_id),
        }));
      }
      for (const r of list('mangas')) {
        const tandaId = remap(tandaMap, r.tanda_id);
        if (tandaId == null) continue;
        mangaMap.set(r.id, insertRow('mangas', r, { race_id: raceId, tanda_id: tandaId }));
      }
      for (const r of list('manga_lanes')) {
        const mangaId = remap(mangaMap, r.manga_id);
        if (mangaId == null) continue;
        insertRow('manga_lanes', r, { manga_id: mangaId, team_id: remap(teamMap, r.team_id), driver_id: remap(driverMap, r.driver_id) });
      }
      for (const r of list('manga_circuits')) {
        const mangaId = remap(mangaMap, r.manga_id);
        if (mangaId != null) insertRow('manga_circuits', r, { manga_id: mangaId });
      }

      // Vueltas: source_lap_id apunta a otra vuelta → segunda pasada.
      const withSource = [];
      for (const r of list('laps')) {
        const newId = insertRow('laps', r, {
          race_id: raceId,
          manga_id: remap(mangaMap, r.manga_id),
          driver_id: remap(driverMap, r.driver_id),
          team_id: remap(teamMap, r.team_id),
          source_lap_id: null,
        });
        lapMap.set(r.id, newId);
        if (r.source_lap_id != null) withSource.push([newId, r.source_lap_id]);
      }
      if (withSource.length) {
        const setSource = db.prepare('UPDATE laps SET source_lap_id = ? WHERE id = ?');
        for (const [newId, oldSource] of withSource) setSource.run(remap(lapMap, oldSource), newId);
      }

      for (const r of list('driver_shifts')) {
        const mangaId = remap(mangaMap, r.manga_id);
        if (mangaId == null) continue;
        insertRow('driver_shifts', r, {
          race_id: raceId, manga_id: mangaId, team_id: remap(teamMap, r.team_id), driver_id: remap(driverMap, r.driver_id),
        });
      }
      for (const r of list('tire_changes')) {
        const teamId = remap(teamMap, r.team_id);
        if (teamId == null) continue;
        insertRow('tire_changes', r, { race_id: raceId, team_id: teamId, manga_id: remap(mangaMap, r.manga_id) });
      }
      for (const r of list('race_events')) {
        insertRow('race_events', r, { race_id: raceId, manga_id: remap(mangaMap, r.manga_id) });
      }
      for (const r of list('lap_tracking'))  insertRow('lap_tracking', r, { race_id: raceId });
      for (const r of list('verifications')) insertRow('verifications', r, { race_id: raceId });
      for (const r of list('pole_sessions')) poleMap.set(r.id, insertRow('pole_sessions', r, { race_id: raceId }));
      for (const r of list('pole_entries')) {
        const sessionId = remap(poleMap, r.pole_session_id);
        if (sessionId != null) insertRow('pole_entries', r, { pole_session_id: sessionId });
      }

      if (tableExists('race_categories')) {
        const findCat = db.prepare('SELECT id FROM categories WHERE name = ?');
        const linkCat = db.prepare('INSERT OR IGNORE INTO race_categories (race_id, category_id) VALUES (?, ?)');
        for (const name of (archive.categories || [])) {
          const cat = findCat.get(name);
          linkCat.run(raceId, cat ? cat.id : insertRow('categories', { name }));
        }
      }

      return { raceId, name: src.name, laps: lapMap.size, circuitCreated, circuitName: archive.circuit ? archive.circuit.name : null };
    });

    return run();
  },
};

module.exports = RaceArchive;
