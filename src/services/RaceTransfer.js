const db = require('../config/database');
const Race = require('../models/Race');

// ── RaceTransfer ────────────────────────────────────────────────────────────
// Serializa una carrera COMPLETA (config + tandas + equipos + pilotos + mangas
// + asignaciones de carril) a un JSON portable, y la recrea en otra BD de forma
// idéntica. La identidad estable entre instancias es (race_key, tanda.number,
// manga.number): los ids autoincrement NO se transfieren; equipos/pilotos se
// referencian por una clave de payload (Txx/Dxx) que se remapea al importar.
//
// Pensado para la feature MAESTRO/ESCLAVO (24h Llinars): el esclavo se provisiona
// la misma carrera que el maestro para que "manga N de la tanda T" signifique lo
// mismo en ambos. NO transfiere vueltas/resultados (cada instancia registra los
// suyos). Es aditivo y no toca ninguna carrera existente.

const PAYLOAD_VERSION = 1;

class RaceExistsError extends Error {
  constructor(raceKey, existingId) {
    super(`Ya existe una carrera con race_key ${raceKey} (id ${existingId})`);
    this.name = 'RaceExistsError';
    this.raceKey = raceKey;
    this.existingId = existingId;
  }
}

const teamRef   = id => (id == null ? null : `T${id}`);
const driverRef = id => (id == null ? null : `D${id}`);

const RaceTransfer = {
  RaceExistsError,

  // raceId → objeto payload serializable (JSON.stringify-able).
  exportRace(raceId) {
    const race = Race.findById(raceId);
    if (!race) throw new Error(`Carrera ${raceId} no encontrada`);

    // Aseguramos race_key (carreras muy antiguas podrían no tenerlo aún).
    if (!race.race_key) {
      const key = require('crypto').randomUUID();
      db.prepare('UPDATE races SET race_key = ? WHERE id = ?').run(key, race.id);
      race.race_key = key;
    }

    // Secuencia de carriles RESUELTA (si la carrera usa un circuito, su
    // secuencia; el esclavo importa con circuit_id=null y se apoya en esta).
    let resolvedSeq = '[]';
    try { resolvedSeq = JSON.stringify(Race.getLaneSequence(race)); } catch {}

    const tandas = db.prepare('SELECT number FROM tandas WHERE race_id = ? ORDER BY number ASC').all(race.id);
    const tandaNumById = {};
    db.prepare('SELECT id, number FROM tandas WHERE race_id = ?').all(race.id)
      .forEach(t => { tandaNumById[t.id] = t.number; });

    const teams = db.prepare('SELECT * FROM teams WHERE race_id = ? ORDER BY id ASC').all(race.id)
      .map(t => ({
        ref: teamRef(t.id),
        tandaNumber: t.tanda_id != null ? tandaNumById[t.tanda_id] ?? null : null,
        name: t.name, lane: t.lane, color: t.color, country: t.country,
      }));

    const drivers = db.prepare('SELECT * FROM drivers WHERE race_id = ? ORDER BY id ASC').all(race.id)
      .map(d => ({
        ref: driverRef(d.id),
        tandaNumber: d.tanda_id != null ? tandaNumById[d.tanda_id] ?? null : null,
        teamRef: teamRef(d.team_id),
        name: d.name, lane: d.lane, car_number: d.car_number,
      }));

    const mangaRows = db.prepare('SELECT * FROM mangas WHERE race_id = ? ORDER BY tanda_id ASC, number ASC').all(race.id);
    const getLanes = db.prepare('SELECT lane, team_id, driver_id, is_rest FROM manga_lanes WHERE manga_id = ? ORDER BY lane ASC');
    const mangas = mangaRows.map(m => ({
      tandaNumber: tandaNumById[m.tanda_id] ?? null,
      number: m.number,
      lanes: getLanes.all(m.id).map(l => ({
        lane: l.lane,
        teamRef: teamRef(l.team_id),
        driverRef: driverRef(l.driver_id),
        is_rest: l.is_rest,
      })),
    }));

    // Categorías de la carrera (por NOMBRE, portable entre BDs).
    let categories = [];
    try {
      categories = db.prepare(`
        SELECT c.name FROM race_categories rc
        JOIN categories c ON c.id = rc.category_id
        WHERE rc.race_id = ? ORDER BY c.name ASC
      `).all(race.id).map(r => r.name);
    } catch {}

    return {
      version: PAYLOAD_VERSION,
      exportedAt: new Date().toISOString(),
      raceKey: race.race_key,
      race: {
        name: race.name,
        type: race.type,
        format: race.format,
        lanes_count: race.lanes_count,
        lane_sequence: resolvedSeq,
        manga_duration_minutes: race.manga_duration_minutes,
        circuits_config: race.circuits_config,
        has_pole: race.has_pole,
        min_lap_ms: race.min_lap_ms,
        driver_min_total_ms: race.driver_min_total_ms,
        driver_max_total_ms: race.driver_max_total_ms,
        driver_change_lockout_ms: race.driver_change_lockout_ms,
        driver_max_runs: race.driver_max_runs,
        passes: race.passes,
        lane_repeat: race.lane_repeat,
      },
      tandas: tandas.map(t => ({ number: t.number })),
      teams,
      drivers,
      mangas,
      categories,
    };
  },

  // payload → nuevo raceId (en ESTA BD). Recrea todo con el MISMO race_key.
  // Lanza RaceExistsError si ya existe una carrera con ese race_key.
  importRace(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Payload inválido');
    if (!payload.raceKey) throw new Error('Payload sin raceKey');
    if (payload.version !== PAYLOAD_VERSION) {
      throw new Error(`Versión de payload no soportada: ${payload.version} (esperada ${PAYLOAD_VERSION})`);
    }

    const existing = db.prepare('SELECT id FROM races WHERE race_key = ?').get(payload.raceKey);
    if (existing) throw new RaceExistsError(payload.raceKey, existing.id);

    const r = payload.race || {};

    const run = db.transaction(() => {
      // 1) Carrera (circuit_id=null: el esclavo se apoya en lane_sequence)
      const { lastInsertRowid: raceId } = db.prepare(`
        INSERT INTO races (name, type, format, lanes_count, lane_sequence, manga_duration_minutes,
                           circuits_config, has_pole, circuit_id, min_lap_ms,
                           driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms,
                           driver_max_runs, passes, lane_repeat, race_key, status)
        VALUES (@name, @type, @format, @lanes_count, @lane_sequence, @manga_duration_minutes,
                @circuits_config, @has_pole, NULL, @min_lap_ms,
                @driver_min_total_ms, @driver_max_total_ms, @driver_change_lockout_ms,
                @driver_max_runs, @passes, @lane_repeat, @race_key, 'pending')
      `).run({
        name: r.name, type: r.type, format: r.format,
        lanes_count: r.lanes_count ?? 6,
        lane_sequence: r.lane_sequence || '[]',
        manga_duration_minutes: r.manga_duration_minutes ?? 5,
        circuits_config: r.circuits_config || '[]',
        has_pole: r.has_pole ? 1 : 0,
        min_lap_ms: r.min_lap_ms || 0,
        driver_min_total_ms: r.driver_min_total_ms || 0,
        driver_max_total_ms: r.driver_max_total_ms || 0,
        driver_change_lockout_ms: r.driver_change_lockout_ms != null ? r.driver_change_lockout_ms : 120000,
        driver_max_runs: r.driver_max_runs || 0,
        passes: Math.max(1, parseInt(r.passes, 10) || 1),
        lane_repeat: Math.max(1, parseInt(r.lane_repeat, 10) || 1),
        race_key: payload.raceKey,
      });

      // 2) Tandas (por number) → mapa number→id
      const tandaIdByNum = {};
      const insTanda = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)');
      for (const t of (payload.tandas || [])) {
        tandaIdByNum[t.number] = insTanda.run(raceId, t.number).lastInsertRowid;
      }

      // 3) Equipos → mapa ref→id
      const teamIdByRef = {};
      const insTeam = db.prepare(`
        INSERT INTO teams (race_id, tanda_id, name, lane, color, country)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const t of (payload.teams || [])) {
        const tandaId = t.tandaNumber != null ? tandaIdByNum[t.tandaNumber] ?? null : null;
        teamIdByRef[t.ref] = insTeam.run(raceId, tandaId, t.name, t.lane ?? 0, t.color || '#e63946', t.country ?? null).lastInsertRowid;
      }

      // 4) Pilotos → mapa ref→id
      const driverIdByRef = {};
      const insDriver = db.prepare(`
        INSERT INTO drivers (race_id, tanda_id, team_id, name, lane, car_number)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const d of (payload.drivers || [])) {
        const tandaId = d.tandaNumber != null ? tandaIdByNum[d.tandaNumber] ?? null : null;
        const teamId  = d.teamRef != null ? teamIdByRef[d.teamRef] ?? null : null;
        driverIdByRef[d.ref] = insDriver.run(raceId, tandaId, teamId, d.name, d.lane ?? null, d.car_number ?? null).lastInsertRowid;
      }

      // 5) Mangas + asignaciones de carril
      const insManga = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)');
      const insLane  = db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, driver_id, is_rest) VALUES (?, ?, ?, ?, ?)');
      for (const m of (payload.mangas || [])) {
        const tandaId = tandaIdByNum[m.tandaNumber];
        if (tandaId == null) continue; // manga sin tanda válida → se ignora
        const mangaId = insManga.run(tandaId, raceId, m.number).lastInsertRowid;
        for (const l of (m.lanes || [])) {
          const teamId   = l.teamRef   != null ? teamIdByRef[l.teamRef]     ?? null : null;
          const driverId = l.driverRef != null ? driverIdByRef[l.driverRef] ?? null : null;
          insLane.run(mangaId, l.lane, teamId, driverId, l.is_rest ? 1 : 0);
        }
      }

      // 6) Categorías (find-or-create por nombre) + vínculo race_categories
      try {
        const findCat = db.prepare('SELECT id FROM categories WHERE name = ?');
        const insCat  = db.prepare('INSERT INTO categories (name) VALUES (?)');
        const linkCat = db.prepare('INSERT OR IGNORE INTO race_categories (race_id, category_id) VALUES (?, ?)');
        for (const name of (payload.categories || [])) {
          let cat = findCat.get(name);
          const catId = cat ? cat.id : insCat.run(name).lastInsertRowid;
          linkCat.run(raceId, catId);
        }
      } catch { /* categorías opcionales */ }

      return raceId;
    });

    return run();
  },
};

module.exports = RaceTransfer;
