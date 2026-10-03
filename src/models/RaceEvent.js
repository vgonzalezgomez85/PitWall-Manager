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
//
// Registro de sucesos de carrera (GO, pausa, reanudado, stop, cancelación,
// vuelta fantasma, reasignación, salida retroactiva, fichaje de piloto).
//
// Guarda hechos ESTRUCTURADOS, no prosa: el texto humano (es/en) se formatea
// en cliente desde `type` + `payload` — ver public/js/raceEvents.js — así el
// mismo registro sirve en cualquier idioma sin re-escribir filas antiguas.
//
// Las vueltas normales (no fantasma) NO viven aquí: ya están íntegras en
// `laps`. Duplicarlas doblaría el tamaño de la tabla más grande de la BD sin
// aportar nada nuevo (/corrections y los resultados ya las cubren).
const db = require('../config/database');

class RaceEvent {
  // Registra un suceso. `createdAtMs` se pasa siempre (Date.now() del
  // caller, nunca dentro del modelo) para que quede fijado en el instante
  // exacto en que ocurrió, no en el que se llama al modelo.
  static create({ raceId, mangaId = null, mangaNumber = null, type, circuit = null, lane = null, entityName = null, payload = null, createdAtMs }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO race_events
        (race_id, manga_id, manga_number, type, circuit, lane, entity_name, payload_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      raceId,
      mangaId ?? null,
      mangaNumber ?? null,
      type,
      circuit ?? null,
      lane ?? null,
      entityName ?? null,
      payload != null ? JSON.stringify(payload) : null,
      createdAtMs
    );
    return lastInsertRowid;
  }

  static _parse(row) {
    if (!row) return row;
    let payload = null;
    if (row.payload_json) { try { payload = JSON.parse(row.payload_json); } catch { payload = null; } }
    return {
      id: row.id, raceId: row.race_id, mangaId: row.manga_id, mangaNumber: row.manga_number,
      type: row.type, circuit: row.circuit, lane: row.lane, entityName: row.entity_name,
      payload, createdAtMs: row.created_at_ms,
    };
  }

  // Historial GLOBAL de la carrera, un grupo por manga (más reciente arriba,
  // también dentro de cada grupo). Agrupa por manga_id, NO por número: cada
  // tanda vuelve a numerar sus mangas desde 1, y agrupar por número mezclaba
  // en «Manga 1» las mangas 1 de todas las tandas. Los sucesos sin manga (o
  // cuya manga se borró) van a un grupo aparte, al final.
  static groupedByRace(raceId) {
    const rows = db.prepare(`
      SELECT * FROM race_events WHERE race_id = ? ORDER BY created_at_ms DESC, id DESC
    `).all(raceId).map(RaceEvent._parse);

    const mangas = db.prepare(`
      SELECT m.id, m.number, m.started_at, t.number AS tanda_number
      FROM mangas m JOIN tandas t ON t.id = m.tanda_id
      WHERE m.race_id = ?
    `).all(raceId);
    const tandaCount = new Set(mangas.map(m => m.tanda_number)).size;

    const byManga = new Map();
    mangas.forEach(m => byManga.set(m.id, {
      mangaId: m.id,
      mangaNumber: m.number,
      tandaNumber: m.tanda_number,
      startedAtMs: m.started_at ? Date.parse(m.started_at) || null : null,
      items: [],
    }));

    const orphan = [];
    rows.forEach(r => {
      const g = r.mangaId != null ? byManga.get(r.mangaId) : null;
      if (g) g.items.push(r); else orphan.push(r);
    });

    // Orden por arranque real de la manga; si no consta, por su último suceso.
    const sortKey = g => g.startedAtMs ?? g.items[0].createdAtMs;
    const groups = [...byManga.values()]
      .filter(g => g.items.length > 0)
      .sort((a, b) => sortKey(b) - sortKey(a) || b.mangaId - a.mangaId);
    if (orphan.length) groups.push({ mangaId: null, mangaNumber: null, tandaNumber: null, startedAtMs: null, items: orphan });

    return { totalEvents: rows.length, multiTanda: tandaCount > 1, groups };
  }

  // Últimos N sucesos de una manga (para el pintado inicial del panel en
  // vivo, en orden cronológico ascendente — el cliente los añade uno a uno).
  static recentByManga(mangaId, limit = 20) {
    return db.prepare(`
      SELECT * FROM race_events WHERE manga_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT ?
    `).all(mangaId, limit).reverse().map(RaceEvent._parse);
  }
}

module.exports = RaceEvent;
