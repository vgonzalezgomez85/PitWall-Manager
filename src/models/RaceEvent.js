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

  // Historial GLOBAL de la carrera, agrupado por manga (más reciente arriba
  // dentro de cada grupo). Incluye las mangas de la carrera aunque no tengan
  // sucesos, para ver el recorrido completo — mismo patrón que
  // TireChange.fullHistoryByRace. Los sucesos sin manga van a un grupo aparte.
  static groupedByRace(raceId) {
    const rows = db.prepare(`
      SELECT * FROM race_events WHERE race_id = ? ORDER BY created_at_ms DESC, id DESC
    `).all(raceId).map(RaceEvent._parse);

    const byManga = new Map();
    db.prepare('SELECT DISTINCT number FROM mangas WHERE race_id = ? ORDER BY number ASC')
      .all(raceId).forEach(m => byManga.set(m.number, []));

    const orphan = [];
    rows.forEach(r => {
      if (r.mangaNumber == null) { orphan.push(r); return; }
      if (!byManga.has(r.mangaNumber)) byManga.set(r.mangaNumber, []);
      byManga.get(r.mangaNumber).push(r);
    });

    const groups = [...byManga.entries()]
      .filter(([, items]) => items.length > 0)
      .sort((a, b) => b[0] - a[0])
      .map(([mangaNumber, items]) => ({ mangaNumber, items }));
    if (orphan.length) groups.push({ mangaNumber: null, items: orphan });

    return { totalEvents: rows.length, groups };
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
