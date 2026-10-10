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
// Importador de "tandas" desde PitWall Control. A partir de un payload
// `pitwall.tanda/v1` (una Prueba con sus Mangas + los equipos y su carril de
// salida) autocrea la carrera en Manager: cada Manga de Control → una tanda,
// con los equipos colocados en su carril de salida, y el motor de resistencia
// (Manga.buildSchedule) genera la rotación de mangas.
//
// Comparte el patrón de creación con SimController.create; ambos son consumidos
// por dos vías (subida de fichero JSON y POST directo por LAN) que solo cambian
// de dónde llega el payload.

const db = require('../config/database');
const Race = require('../models/Race');
const Tanda = require('../models/Tanda');
const Team = require('../models/Team');
const Driver = require('../models/Driver');
const Manga = require('../models/Manga');

const SCHEMA = 'pitwall.tanda/v1';

// El color de cada equipo sale de la paleta global de carriles (estable entre
// mangas de la rotación). La carrera importada no tiene circuito.
const LaneColors = require('./LaneColors');

// Secuencia de rotación por defecto: impares ascendente, pares descendente.
// 6 → [1,3,5,6,4,2]. Igual que RaceController.defaultSequence.
function defaultSequence(n) {
  const odds = [], evens = [];
  for (let i = 1; i <= n; i++) { (i % 2 ? odds : evens).push(i); }
  return [...odds, ...evens.reverse()];
}

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

// Lleva una clave del diccionario (`tandaimport.*`) y sus variables: quien lo
// muestra lo traduce por CÓDIGO, no por frase. El mensaje en español se queda
// para los registros y para quien no tenga traductor (p. ej. un test).
class TandaImportError extends Error {
  constructor(message, key = null, vars = {}) { super(message); this.key = key; this.vars = vars; }
}

// Valida el payload y devuelve una versión normalizada (o lanza
// TandaImportError con un mensaje legible). No toca la BD.
function validate(payload) {
  if (!payload || typeof payload !== 'object') throw new TandaImportError('Payload vacío o no es un objeto.', 'payload_vacio');
  if (payload.schema && payload.schema !== SCHEMA) {
    throw new TandaImportError(`Esquema no soportado: ${payload.schema} (se esperaba ${SCHEMA}).`, 'esquema', { schema: payload.schema, esperado: SCHEMA });
  }
  const prueba = payload.prueba || {};
  const nombre = String(prueba.nombre || '').trim();
  if (!nombre) throw new TandaImportError('Falta el nombre de la prueba (prueba.nombre).', 'falta_nombre');

  const carriles = asInt(payload.carriles);
  if (!(carriles >= 1 && carriles <= LaneColors.DEFAULT_LANE_COLORS.length)) {
    throw new TandaImportError(`Nº de carriles inválido: ${payload.carriles}.`, 'carriles_invalido', { v: payload.carriles });
  }

  const formato = String(prueba.formato || 'PAREJAS').toUpperCase();
  const isTeam = formato !== 'INDIVIDUAL';

  if (!Array.isArray(payload.tandas) || payload.tandas.length === 0) {
    throw new TandaImportError('El payload no contiene tandas.', 'sin_tandas');
  }

  // ¿La carrera tiene pole? Con pole, el ORDEN DE CARRIL se decide DESPUÉS de
  // correr la pole (flujo nativo: PoleController.assignLanes crea la tanda),
  // así que el carril_salida del payload se ignora y no se valida.
  const pole = payload.pole === true || payload.pole === 1 || payload.pole === '1';

  const tandas = payload.tandas.map((t, ti) => {
    const equipos = Array.isArray(t.equipos) ? t.equipos : [];
    if (equipos.length === 0) throw new TandaImportError(`La tanda ${ti + 1} no tiene equipos.`, 'tanda_sin_equipos', { n: ti + 1 });
    const seen = new Set();
    let racers = 0;
    const eqs = equipos.map((e, ei) => {
      const enombre = String(e.nombre || '').trim();
      if (!enombre) throw new TandaImportError(`Equipo sin nombre en la tanda ${ti + 1} (posición ${ei + 1}).`, 'equipo_sin_nombre', { n: ti + 1, pos: ei + 1 });
      // carril_salida 0 = DESCANSO (más equipos que carriles); 1..carriles = carril de carrera.
      const carril = asInt(e.carril_salida) || 0;
      const isRest = carril === 0;
      if (!isRest && !pole) {
        if (!(carril >= 1 && carril <= carriles)) {
          throw new TandaImportError(`Carril de salida inválido (${e.carril_salida}) para "${enombre}" en la tanda ${ti + 1}.`, 'carril_salida_invalido', { carril: e.carril_salida, equipo: enombre, n: ti + 1 });
        }
        if (seen.has(carril)) {
          throw new TandaImportError(`Carril ${carril} repetido en la tanda ${ti + 1} (dos equipos en el mismo carril).`, 'carril_repetido', { carril, n: ti + 1 });
        }
        seen.add(carril);
        racers++;
      }
      const descanso = asInt(e.descanso) || 0;
      const pilotos = Array.isArray(e.pilotos) ? e.pilotos.map(p => String(p || '').trim()).filter(Boolean) : [];
      return { nombre: enombre, copa: e.copa != null ? String(e.copa) : null, carril, isRest, descanso, pilotos };
    });
    if (!pole) {
      if (racers === 0) {
        throw new TandaImportError(`La tanda ${ti + 1} no tiene ningún equipo en carril (todos en descanso).`, 'todos_descanso', { n: ti + 1 });
      }
      if (racers > carriles) {
        throw new TandaImportError(`La tanda ${ti + 1} tiene ${racers} equipos en carril y solo ${carriles} carriles.`, 'demasiados', { n: ti + 1, equipos: racers, carriles });
      }
    }
    return { numero: asInt(t.numero) || ti + 1, equipos: eqs };
  });

  return { nombre, sede: prueba.sede ? String(prueba.sede) : null, carriles, isTeam, pole, tandas };
}

// Crea la carrera completa a partir del payload. Devuelve { raceId, url, ... }.
// Todo dentro de una transacción: si algo falla, no queda una carrera a medias.
function createFromPayload(payload) {
  const v = validate(payload);
  const laneSeqRace = defaultSequence(v.carriles);
  const format = v.isTeam ? 'team' : 'individual';
  const type = v.isTeam ? 'championship' : 'club';
  const minLapMs = Math.max(0, asInt(payload.min_lap_ms) || 0);
  const mangaMin = Math.max(1, asInt(payload.manga_minutes) || 5);

  const run = db.transaction(() => {
    const raceId = Race.create({
      name: v.nombre, type, format, lanes_count: v.carriles,
      lane_sequence: laneSeqRace, manga_duration_minutes: mangaMin,
      circuits: [v.carriles], has_pole: v.pole ? 1 : 0, min_lap_ms: minLapMs,
    });

    let teamCount = 0;
    // Crea el team (+ pilotos) o el driver de un equipo y devuelve su entidad.
    const palette = LaneColors.global();
    const crear = (tandaId, eq, colorSeed) => {
      const color = palette[((colorSeed % palette.length) + palette.length) % palette.length];
      if (v.isTeam) {
        const teamId = Team.create({ race_id: raceId, tanda_id: tandaId, name: eq.nombre, lane: 0, color });
        eq.pilotos.forEach((p, i) => Driver.create({
          race_id: raceId, tanda_id: tandaId, team_id: teamId, name: p, lane: null, car_number: i + 1,
        }));
        teamCount++;
        return { id: teamId, type: 'team', name: eq.nombre };
      }
      // INDIVIDUAL: cada equipo es un piloto suelto (usa su nombre).
      const driverId = Driver.create({
        race_id: raceId, tanda_id: tandaId, team_id: null, name: eq.nombre,
        lane: eq.carril || null, car_number: eq.carril || null,
      });
      teamCount++;
      return { id: driverId, type: 'driver', name: eq.nombre };
    };

    // CON POLE: el orden de carril se decide DESPUÉS de correr la pole, así que
    // NO se crean tandas/equipos aquí. Solo la sesión de pole con los equipos
    // como participantes (dedupe por nombre entre tandas); tras la pole, el
    // flujo nativo (PoleController.assignLanes) crea la tanda con la parrilla.
    if (v.pole) {
      const PoleSession = require('../models/PoleSession');
      const sessionId = PoleSession.create(raceId);
      const entityType = v.isTeam ? 'team' : 'driver';
      const vistos = new Set();
      for (const tanda of v.tandas) {
        for (const eq of tanda.equipos) {
          if (vistos.has(eq.nombre)) continue;
          vistos.add(eq.nombre);
          PoleSession.addEntry({
            poleSessionId: sessionId,
            entityType,
            entityName: eq.nombre,
            membersJson: eq.pilotos.length ? JSON.stringify(eq.pilotos) : null,
          });
        }
      }
      return { raceId, tandas: 0, teams: vistos.size, pole: true };
    }

    for (const tanda of v.tandas) {
      const tandaId = Tanda.create(raceId);

      const racers  = tanda.equipos.filter(e => !e.isRest);
      const resters = tanda.equipos.filter(e =>  e.isRest).sort((a, b) => a.descanso - b.descanso);

      // Orden de rotación = la secuencia por defecto restringida a los carriles
      // usados, MÁS una plaza de descanso (0) por cada equipo que descansa. Así
      // la entidad i arranca (manga 1, s=0) en extended[i]: los que corren en su
      // carril_salida y los que descansan en una plaza 0 (is_rest). El motor de
      // resistencia rota carriles y descansos entre todos.
      const usados = new Set(racers.map(e => e.carril));
      const rotationLanes = laneSeqRace.filter(l => usados.has(l));
      const extended = [...rotationLanes, ...Array(resters.length).fill(0)];
      const byLane = new Map(racers.map(e => [e.carril, e]));

      let restCursor = 0;
      const entities = extended.map((lane) => {
        if (lane !== 0) return crear(tandaId, byLane.get(lane), lane - 1);
        const eq = resters[restCursor];
        return crear(tandaId, eq, v.carriles + restCursor++);
      });

      const schedule = Manga.buildSchedule(extended, entities);
      Manga.persistSchedule(tandaId, raceId, schedule);
    }

    return { raceId, tandas: v.tandas.length, teams: teamCount, pole: false };
  });

  const out = run();
  return { ...out, name: v.nombre, url: `/races/${out.raceId}` };
}

module.exports = { validate, createFromPayload, TandaImportError, SCHEMA };
