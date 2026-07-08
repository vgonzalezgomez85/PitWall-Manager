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

// 24 equipos del catálogo elegidos al azar y una tanda con el orden de carriles
// sorteado. Usa los MISMOS modelos que TandaController, no SQL a mano.
process.chdir('/Users/victor/PitWall');

const db          = require('/Users/victor/PitWall/src/config/database');
const Race        = require('/Users/victor/PitWall/src/models/Race');
const Tanda       = require('/Users/victor/PitWall/src/models/Tanda');
const Manga       = require('/Users/victor/PitWall/src/models/Manga');
const Team        = require('/Users/victor/PitWall/src/models/Team');
const Driver      = require('/Users/victor/PitWall/src/models/Driver');
const TeamCatalog = require('/Users/victor/PitWall/src/models/TeamCatalog');

const NOMBRE = '24h-llinars test';
const LANES  = 24;
const H = 3600000;

const LANE_COLORS = ['#e63946','#457b9d','#2a9d8f','#e9c46a','#f4a261','#9d4edd','#ff70a6','#495057',
                     '#06d6a0','#118ab2','#ef476f','#ffd166','#8338ec','#3a86ff','#fb5607','#606c38',
                     '#bc6c25','#283618','#00b4d8','#7209b7','#f72585','#4cc9f0','#4361ee','#b5179e'];

const barajar = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

// Si ya existe, la borramos para poder repetir el seed.
const previa = db.prepare('SELECT id FROM races WHERE name = ?').get(NOMBRE);
if (previa) {
  for (const t of ['driver_shifts','laps','manga_lanes','mangas','drivers','teams','tandas'])
    { try { db.prepare(`DELETE FROM ${t} WHERE race_id = ?`).run(previa.id); } catch {} }
  try { db.prepare('DELETE FROM tandas WHERE race_id = ?').run(previa.id); } catch {}
  db.prepare('DELETE FROM races WHERE id = ?').run(previa.id);
  console.log(`(carrera previa ${previa.id} eliminada)`);
}

// Equipos del catálogo con al menos 2 pilotos DISTINTOS y TODOS con perfil y QR.
// Sin QR no se puede fichar, y sin perfil el piloto ni siquiera sale en el
// informe de turnos: un equipo así (p. ej. el equipo "test") arruinaría la prueba.
const elegibles = db.prepare(`
  SELECT tc.id
  FROM teams_catalog tc
  JOIN teams_catalog_members m ON m.team_id = tc.id
  LEFT JOIN driver_profiles p  ON p.id = m.driver_id
  GROUP BY tc.id
  HAVING COUNT(DISTINCT m.name) >= 2
     AND SUM(CASE WHEN m.driver_id IS NULL OR p.qr_code IS NULL OR p.qr_code = '' THEN 1 ELSE 0 END) = 0
     AND COUNT(m.id) = COUNT(DISTINCT m.name)
`).all().map(r => r.id);
if (elegibles.length < LANES) { console.error(`Solo hay ${elegibles.length} equipos válidos (2+ pilotos, todos con perfil y QR)`); process.exit(1); }
const catalogIds = barajar(elegibles).slice(0, LANES);

// Orden de carriles SORTEADO: es el "aleatorio" de la tanda.
const laneSequence = barajar(Array.from({ length: LANES }, (_, i) => i + 1));

const raceId = db.prepare(`
  INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                     manga_duration_minutes, has_pole, min_lap_ms,
                     driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms, driver_max_runs,
                     passes, lane_repeat)
  VALUES (?, 'championship', 'team', 'active', ?, ?, '[8,8,8]', 60, 0, 3000, ?, ?, 120000, 0, 1, 1)
`).run(NOMBRE, LANES, JSON.stringify(laneSequence), 2 * H, 8 * H).lastInsertRowid;

const race   = Race.findById(raceId);
const tandaId = Tanda.create(raceId);   // asigna el número siguiente él solo

const entities = [];
catalogIds.forEach((catalogId, idx) => {
  const ct = TeamCatalog.findById(catalogId);
  const teamId = Team.create({
    race_id: raceId, tanda_id: tandaId, name: ct.name, lane: 0,
    color: LANE_COLORS[idx % LANE_COLORS.length], country: ct.country || null,
  });
  (ct.members || []).forEach(m => {
    if (m.name && m.name.trim()) Driver.create({ race_id: raceId, tanda_id: tandaId, team_id: teamId, name: m.name.trim() });
  });
  entities.push({ id: teamId, type: 'team', name: ct.name });
});

Manga.persistSchedule(tandaId, raceId, Manga.buildSchedule(laneSequence, entities, race.passes, race.lane_repeat));

// ── Resumen ────────────────────────────────────────────────────────────────
const mangas = db.prepare('SELECT id, number FROM mangas WHERE race_id = ? ORDER BY number').all(raceId);
const lanes1 = db.prepare(`
  SELECT ml.lane, t.name, ml.is_rest FROM manga_lanes ml
  JOIN teams t ON t.id = ml.team_id WHERE ml.manga_id = ? ORDER BY ml.lane
`).all(mangas[0].id);
const pilotos = db.prepare('SELECT COUNT(*) c FROM drivers WHERE race_id = ?').get(raceId).c;
const conQr = db.prepare(`
  SELECT COUNT(DISTINCT d.id) c FROM drivers d
  JOIN teams t ON t.id = d.team_id
  JOIN teams_catalog tc ON tc.name = t.name
  JOIN teams_catalog_members m ON m.team_id = tc.id AND m.name = d.name
  JOIN driver_profiles p ON p.id = m.driver_id AND p.qr_code IS NOT NULL AND p.qr_code <> ''
  WHERE d.race_id = ?
`).get(raceId).c;

console.log(`\ncarrera ${raceId} — "${NOMBRE}"`);
console.log(`  campeonato por equipos · ${LANES} carriles · cajas 8+8+8 · manga de 60 min`);
console.log(`  reglas de turnos: mínimo 2 h · máximo 8 h · sin límite de turnos · bloqueo últimos 2 min`);
console.log(`  ${entities.length} equipos · ${pilotos} pilotos (${conQr} con QR)`);
console.log(`  tanda 1 · ${mangas.length} manga(s) de rotación`);
console.log(`\n  orden de carriles sorteado: ${laneSequence.join(' ')}`);
console.log(`\n  manga 1 — equipo en cada carril:`);
lanes1.forEach(l => console.log(`    carril ${String(l.lane).padStart(2)} (caja ${l.lane <= 8 ? 1 : l.lane <= 16 ? 2 : 3})  ${l.name}${l.is_rest ? '  [descanso]' : ''}`));
console.log(`\n  → http://localhost:3000/races/${raceId}`);
