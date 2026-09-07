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

// Sincroniza el catálogo del club (teams_catalog / teams_catalog_members) con
// las COPIAS que cada carrera guarda en teams/drivers. Esas copias se hacen al
// crear la tanda y a partir de ahí van por libre: editar el catálogo no las
// toca. Este módulo vuelca los cambios del catálogo a las carreras que todavía
// NO han arrancado ninguna manga, sin pasar por «Editar tanda».
//
// Restricciones deliberadas:
//   · Solo carreras en formato EQUIPOS. En individual los pilotos SON las
//     entidades del horario; tocarlos exigiría regenerar mangas.
//   · Solo carreras con TODAS las mangas en 'pending'. Con una manga corrida
//     habría vueltas/turnos colgando de esas filas.
//   · NO añade ni elimina equipos (eso cambiaría la parrilla). Solo reconcilia
//     los pilotos DENTRO de equipos que ya están, y el país del equipo.
//   · Empareja por NOMBRE normalizado (case + tildes). Si el nombre no coincide
//     en ambos lados, ese equipo se ignora y se reporta como «sin emparejar».
//
// La categoría del equipo NO se sincroniza: ya se lee en vivo del catálogo por
// nombre en las vistas (Manga.getLanes, live-stats, …).

const db = require('../config/database');
const { normalize } = require('../utils/csv');

class CatalogSync {

  // Carreras candidatas: formato equipos, sin ninguna manga arrancada y con al
  // menos un equipo ya asignado a una tanda.
  static eligibleRaces() {
    return db.prepare(`
      SELECT r.id, r.name, r.status
      FROM races r
      WHERE r.format = 'team'
        AND r.status != 'finished'
        AND (SELECT COUNT(*) FROM mangas m
              WHERE m.race_id = r.id AND m.status != 'pending') = 0
        AND (SELECT COUNT(*) FROM teams te
              WHERE te.race_id = r.id AND te.tanda_id IS NOT NULL) > 0
      ORDER BY r.id DESC
    `).all();
  }

  static isEligible(raceId) {
    return this.eligibleRaces().some(r => r.id === Number(raceId));
  }

  // Índice { nombreNormalizado → fila teams_catalog (con members) }.
  static _catalogIndex() {
    const TeamCatalog = require('./TeamCatalog');
    const idx = new Map();
    for (const t of TeamCatalog.findAll()) idx.set(normalize(t.name), t);
    return idx;
  }

  // Diff sin aplicar de UNA carrera. Estructura pensada para pintarse tal cual.
  static computeDiff(raceId) {
    const race = db.prepare('SELECT id, name, format FROM races WHERE id = ?').get(raceId);
    if (!race) return null;

    const catIdx = this._catalogIndex();

    // Filas teams de la carrera agrupadas por nombre (puede haber varias: una
    // por tanda, más la "maestra" de la pole si la hubo).
    const teamRows = db.prepare(`
      SELECT id, name, tanda_id, country
      FROM teams WHERE race_id = ?
      ORDER BY id ASC
    `).all(raceId);

    const byName = new Map();
    for (const row of teamRows) {
      const key = normalize(row.name);
      if (!byName.has(key)) byName.set(key, { name: row.name, rows: [] });
      byName.get(key).rows.push(row);
    }

    const teams = [];
    const unmatched = [];
    let totalAdd = 0, totalRemove = 0, totalCountry = 0;

    for (const { name, rows } of byName.values()) {
      const cat = catIdx.get(normalize(name));
      if (!cat) { unmatched.push(name); continue; }

      const wantMembers = (cat.members || [])
        .map(m => (m.name || '').trim())
        .filter(Boolean);
      const wantNorm = new Set(wantMembers.map(normalize));

      // Pilotos actuales: los de la primera fila con tanda (todas las tandas
      // llevan la misma plantilla). Si no hay ninguna con tanda, no hay a quién
      // sincronizar pilotos, pero el país sí puede cambiar.
      const rowWithTanda = rows.find(r => r.tanda_id != null) || null;
      let add = [], remove = [];
      if (rowWithTanda) {
        const current = db.prepare(
          'SELECT name FROM drivers WHERE team_id = ? ORDER BY id ASC'
        ).all(rowWithTanda.id).map(d => d.name);
        const curNorm = new Set(current.map(normalize));
        add    = wantMembers.filter(n => !curNorm.has(normalize(n)));
        remove = current.filter(n => !wantNorm.has(normalize(n)));
      }

      // País: se compara contra el valor del catálogo (puede ser null).
      const currentCountries = [...new Set(rows.map(r => r.country || null))];
      const countryChanges = currentCountries.some(c => c !== (cat.country || null));

      totalAdd    += add.length;
      totalRemove += remove.length;
      if (countryChanges) totalCountry += 1;

      teams.push({
        name,
        add,
        remove,
        country: countryChanges
          ? { from: currentCountries.map(c => c || '—'), to: cat.country || '—' }
          : null,
        unchanged: add.length === 0 && remove.length === 0 && !countryChanges,
      });
    }

    teams.sort((a, b) => Number(a.unchanged) - Number(b.unchanged) || a.name.localeCompare(b.name));

    return {
      raceId: race.id,
      raceName: race.name,
      teams,
      unmatched,
      totalAdd,
      totalRemove,
      totalCountry,
      hasChanges: totalAdd + totalRemove + totalCountry > 0,
    };
  }

  // Aplica el diff de UNA carrera en una transacción. Devuelve los contadores
  // de lo que se tocó. Lanza si la carrera ya no es candidata.
  static apply(raceId) {
    if (!this.isEligible(raceId)) {
      throw new Error('La carrera ya no es candidata (formato o manga arrancada).');
    }

    const catIdx = this._catalogIndex();
    const raceIdNum = Number(raceId);

    const run = db.transaction(() => {
      const teamRows = db.prepare(
        'SELECT id, name, tanda_id, country FROM teams WHERE race_id = ?'
      ).all(raceIdNum);

      const insDriver = db.prepare(
        'INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, ?)'
      );
      const delDriver = db.prepare('DELETE FROM drivers WHERE id = ?');
      const updCountry = db.prepare('UPDATE teams SET country = ? WHERE id = ?');

      let added = 0, removed = 0, countryUpdated = 0;

      for (const row of teamRows) {
        const cat = catIdx.get(normalize(row.name));
        if (!cat) continue; // sin emparejar → no se toca

        // País (en todas las filas del equipo, con o sin tanda).
        const wantCountry = cat.country || null;
        if ((row.country || null) !== wantCountry) {
          updCountry.run(wantCountry, row.id);
          countryUpdated++;
        }

        // Pilotos: solo en filas que corren (con tanda).
        if (row.tanda_id == null) continue;

        const wantMembers = (cat.members || [])
          .map(m => (m.name || '').trim())
          .filter(Boolean);
        const wantNorm = new Set(wantMembers.map(normalize));

        const current = db.prepare(
          'SELECT id, name FROM drivers WHERE team_id = ?'
        ).all(row.id);
        const curNorm = new Map(current.map(d => [normalize(d.name), d]));

        for (const d of current) {
          if (!wantNorm.has(normalize(d.name))) { delDriver.run(d.id); removed++; }
        }
        for (const n of wantMembers) {
          if (!curNorm.has(normalize(n))) {
            insDriver.run(raceIdNum, row.tanda_id, row.id, n);
            added++;
          }
        }
      }

      return { added, removed, countryUpdated };
    });

    return run();
  }
}

module.exports = CatalogSync;
