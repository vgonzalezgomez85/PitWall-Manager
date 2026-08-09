/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
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
// Importador de verificaciones desde PitWall Control. A partir de un payload
// `pitwall.verificaciones/v1` (ver generador_verificaciones_json.dart en
// Control) liga las verificaciones a una carrera y las guarda a modo de SOLO
// CONSULTA (Manager nunca las edita).
//
// Resolución de la carrera (mismo criterio que se le explicó al usuario):
//   1) `race_id` explícito en el payload (Control lo manda siempre que el
//      usuario elige la carrera en el diálogo "Enviar verificaciones") → esa,
//      o error si no existe (el usuario la eligió a propósito; no adivinamos).
//   2) Sin race_id: se casa por NOMBRE de prueba (exacto, sin mayúsculas ni
//      espacios de sobra) con una carrera existente.
//   3) Si tampoco hay coincidencia: se crea una carrera "cáscara" mínima con
//      los metadatos de la prueba, para que las verificaciones tengan dónde
//      vivir (igual que TandaImport autocrea al enviar una tanda).

const db = require('../config/database');
const Race = require('../models/Race');
const Verification = require('../models/Verification');

const SCHEMA = 'pitwall.verificaciones/v1';

class VerificationImportError extends Error {}

function normNombre(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function asIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function asRealOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asText(v) {
  return v === null || v === undefined ? null : String(v);
}

// Encuentra una carrera existente por race_id, o casándola por nombre, o
// creando una "cáscara" mínima. Devuelve el id.
function resolveRaceId(payload) {
  const raceId = asIntOrNull(payload.race_id);
  if (raceId != null) {
    const race = Race.findById(raceId);
    if (!race) throw new VerificationImportError(`No existe ninguna carrera con id ${raceId} en PitWall.`);
    return race.id;
  }

  const prueba = payload.prueba || {};
  const nombre = String(prueba.nombre || '').trim();
  if (!nombre) throw new VerificationImportError('Falta el nombre de la prueba (prueba.nombre) o race_id.');

  const target = normNombre(nombre);
  const existente = Race.findAll().find(r => normNombre(r.name) === target);
  if (existente) return existente.id;

  const formato = String(prueba.formato || 'PAREJAS').toUpperCase();
  const isTeam = formato !== 'INDIVIDUAL';
  return Race.create({
    name: nombre, type: isTeam ? 'championship' : 'club', format: isTeam ? 'team' : 'individual',
    lanes_count: 8, lane_sequence: [], manga_duration_minutes: 5,
  });
}

// Valida y normaliza el payload → filas listas para Verification.replaceForRace
// (mismo shape que la tabla, *_json ya como STRING). No toca la BD.
function buildRows(payload) {
  if (!payload || typeof payload !== 'object') throw new VerificationImportError('Payload vacío o no es un objeto.');
  if (payload.schema && payload.schema !== SCHEMA) {
    throw new VerificationImportError(`Esquema no soportado: ${payload.schema} (se esperaba ${SCHEMA}).`);
  }
  const lista = Array.isArray(payload.verificaciones) ? payload.verificaciones : [];

  return lista.map((v, i) => {
    const equipo = v.equipo || {};
    const nombre = String(equipo.nombre || '').trim();
    if (!nombre) throw new VerificationImportError(`Verificación ${i + 1} sin nombre de equipo.`);
    const pinon  = v.pinon  || {};
    const corona = v.corona || {};
    const llDel  = v.llanta_delantera || {};
    const llTra  = v.llanta_trasera   || {};
    const pilotos = Array.isArray(equipo.pilotos) ? equipo.pilotos.map(p => String(p || '').trim()).filter(Boolean) : [];
    const fotos = Array.isArray(v.fotos)
      ? v.fotos
          .filter(f => f && f.datos_base64)
          .map(f => ({ nombre: String(f.nombre || ''), dataUrl: `data:image/jpeg;base64,${f.datos_base64}` }))
      : [];

    return {
      manga_numero:         asIntOrNull(v.manga) || (i + 1),
      equipo_nombre:        nombre,
      equipo_copa:          asText(equipo.copa),
      pilotos_json:         JSON.stringify(pilotos),
      coche:                asText(v.coche),
      validado:             v.validado ? 1 : 0,
      peso_inicial:         asRealOrNull(v.peso_inicial),
      peso_final:           asRealOrNull(v.peso_final),
      peso_min:             asRealOrNull(v.peso_min),
      peso_inicial_coche:   asRealOrNull(v.peso_inicial_coche),
      peso_final_coche:     asRealOrNull(v.peso_final_coche),
      motor:                asText(v.motor),
      motor_tipo:           asText(v.motor_tipo),
      motor_rpm:            asIntOrNull(v.motor_rpm),
      motor_ums:            asRealOrNull(v.motor_ums),
      pinon_marca:          asText(pinon.marca),
      pinon_dientes:        asIntOrNull(pinon.dientes),
      pinon_diametro:       asText(pinon.diametro),
      pinon_material:       asText(pinon.material),
      corona_marca:         asText(corona.marca),
      corona_dientes:       asIntOrNull(corona.dientes),
      corona_diametro:      asText(corona.diametro),
      corona_material:      asText(corona.material),
      llanta_del_marca:     asText(llDel.marca),
      llanta_del_dimension: asText(llDel.dimension),
      llanta_tra_marca:     asText(llTra.marca),
      llanta_tra_dimension: asText(llTra.dimension),
      trencilla:            asText(v.trencilla),
      suspension:           asText(v.suspension),
      bancada:              asText(v.bancada),
      chasis:               asText(v.chasis),
      neumatico:            asText(v.neumatico),
      observaciones:        asText(v.observaciones),
      fotos_json:           JSON.stringify(fotos),
    };
  });
}

// Importa el payload completo: resuelve la carrera, reemplaza sus
// verificaciones y devuelve { raceId, name, url, count }.
function importPayload(payload) {
  const rows = buildRows(payload);
  const run = db.transaction(() => {
    const raceId = resolveRaceId(payload);
    Verification.replaceForRace(raceId, rows);
    return raceId;
  });
  const raceId = run();
  const race = Race.findById(raceId);
  return { raceId, name: race ? race.name : null, url: `/races/${raceId}/verificaciones`, count: rows.length };
}

module.exports = { buildRows, resolveRaceId, importPayload, VerificationImportError, SCHEMA };
