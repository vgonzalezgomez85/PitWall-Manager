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
// Verificaciones técnicas de una carrera, enviadas por PitWall Control (LAN,
// POST /import/verificaciones). Tabla de SOLO CONSULTA: ninguna ruta de
// Manager escribe aquí salvo VerificationImport.replaceForRace.
const db = require('../config/database');

const COLUMNS = [
  'manga_numero', 'equipo_nombre', 'equipo_copa', 'pilotos_json', 'coche', 'validado',
  'peso_inicial', 'peso_final', 'peso_min', 'peso_inicial_coche', 'peso_final_coche',
  'motor', 'motor_tipo', 'motor_rpm', 'motor_ums',
  'pinon_marca', 'pinon_dientes', 'pinon_diametro', 'pinon_material',
  'corona_marca', 'corona_dientes', 'corona_diametro', 'corona_material',
  'llanta_del_marca', 'llanta_del_dimension', 'llanta_tra_marca', 'llanta_tra_dimension',
  'trencilla', 'suspension', 'bancada', 'chasis', 'neumatico', 'observaciones', 'fotos_json',
];

class Verification {
  // Todas las verificaciones de una carrera, agrupables por manga en el
  // controlador/vista. Los campos *_json se devuelven ya parseados.
  static findByRace(raceId) {
    const rows = db.prepare(`
      SELECT * FROM verifications WHERE race_id = ?
      ORDER BY manga_numero ASC, equipo_nombre ASC
    `).all(raceId);
    return rows.map(Verification._parse);
  }

  // Cuenta barata para decidir si mostrar el enlace "Verificaciones" en la
  // ficha de la carrera, sin cargar ni parsear todas las filas.
  static countByRace(raceId) {
    return db.prepare('SELECT COUNT(*) AS n FROM verifications WHERE race_id = ?').get(raceId).n;
  }

  static _parse(row) {
    let pilotos = [], fotos = [];
    try { pilotos = JSON.parse(row.pilotos_json || '[]'); } catch { /* deja [] */ }
    try { fotos   = JSON.parse(row.fotos_json   || '[]'); } catch { /* deja [] */ }
    return { ...row, validado: !!row.validado, pilotos, fotos };
  }

  // Reemplaza TODAS las verificaciones de una carrera por las de `rows`
  // (cada fila ya en snake_case, con *_json como STRING listo para guardar).
  // Transaccional: si algo falla no queda la carrera a medio reemplazar.
  static replaceForRace(raceId, rows) {
    const del = db.prepare('DELETE FROM verifications WHERE race_id = ?');
    const ins = db.prepare(`
      INSERT INTO verifications (race_id, ${COLUMNS.join(', ')})
      VALUES (@race_id, ${COLUMNS.map(c => '@' + c).join(', ')})
    `);
    const run = db.transaction((raceId, rows) => {
      del.run(raceId);
      for (const r of rows) ins.run({ race_id: raceId, ...r });
    });
    run(raceId, rows);
  }
}

module.exports = Verification;
