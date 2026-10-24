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
// Nombres repetidos al crear o editar una tanda (idea de Emanuele Palena).
//  · Dos veces en la MISMA tanda: error, no se guarda (no se sabría quién es quién).
//  · Ya en OTRA tanda de la carrera: solo aviso (partials/tanda-name-check.ejs).
//    Repetir equipos entre tandas es legítimo, p. ej. entrenos en varias sesiones.
// Se compara sin mayúsculas, acentos ni espacios de más. La misma regla vive en
// el navegador (partials/tanda-name-check.ejs): mantenerlas iguales.

const db = require('../config/database');

function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Nombres que salen más de una vez en la lista (el primero de cada grupo, tal cual se escribió). */
function duplicatesIn(names) {
  const seen = new Map();
  const dup = new Set();
  names.forEach(n => {
    const k = normName(n);
    if (!k) return;
    if (seen.has(k)) dup.add(seen.get(k)); else seen.set(k, String(n).trim());
  });
  return [...dup];
}

/**
 * Participantes de las OTRAS tandas de la carrera: [{ key, name, tandas: [nº] }].
 * Equipos en carreras por equipos; pilotos sueltos en las individuales.
 */
function inOtherTandas(race, excludeTandaId = null) {
  const sql = race.format === 'team'
    ? `SELECT e.name, t.number FROM teams e JOIN tandas t ON t.id = e.tanda_id
       WHERE e.race_id = ? AND t.id != ? ORDER BY t.number`
    : `SELECT e.name, t.number FROM drivers e JOIN tandas t ON t.id = e.tanda_id
       WHERE e.race_id = ? AND e.team_id IS NULL AND t.id != ? ORDER BY t.number`;
  const byKey = new Map();
  db.prepare(sql).all(race.id, excludeTandaId ?? -1).forEach(r => {
    const key = normName(r.name);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, { key, name: r.name, tandas: [] });
    const e = byKey.get(key);
    if (!e.tandas.includes(r.number)) e.tandas.push(r.number);
  });
  return [...byKey.values()];
}

module.exports = { normName, duplicatesIn, inOtherTandas };
