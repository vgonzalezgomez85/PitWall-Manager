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
// Categoría/copa y coche por participante (opcionales por carrera):
//   · captura al inscribir (tanda nueva) y al editar la tanda (los dos modos),
//     con el catálogo como valor de partida en los equipos;
//   · lectura: la del equipo/piloto de ESTA carrera manda y, si está vacía, se
//     cae a la del catálogo por nombre (carreras de antes de la v1.49);
//   · el agregado y el Excel llevan las dos columnas si la carrera las activa.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();
process.env.PITWALL_NO_WORKER = '1';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Race = require('../src/models/Race');
const Manga = require('../src/models/Manga');
const Lap = require('../src/models/Lap');
const Team = require('../src/models/Team');
const TeamCatalog = require('../src/models/TeamCatalog');
const TandaController = require('../src/controllers/TandaController');
const SessionController = require('../src/controllers/SessionController');

after(() => limpiarBdTemporal());

beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'mangas', 'drivers', 'teams', 'tandas', 'races',
                   'teams_catalog_members', 'teams_catalog', 'driver_profiles', 'settings']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

// ── Utilidades ───────────────────────────────────────────────────────────────

function carrera({ type = 'championship', format = 'team', lanes = 2, hasCat = 1, hasCoche = 1 } = {}) {
  const seq = JSON.stringify([...Array(lanes).keys()].map(i => i + 1));
  const cfg = JSON.stringify([lanes]);
  return db.prepare(`
    INSERT INTO races (name, type, format, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, min_lap_ms, has_categoria, has_coche)
    VALUES ('Test', ?, ?, ?, ?, ?, 10, 0, ?, ?)
  `).run(type, format, lanes, seq, cfg, hasCat, hasCoche).lastInsertRowid;
}

const fakeRes = () => ({
  code: 200, redirectTo: null, view: null, data: null,
  status(c) { this.code = c; return this; },
  redirect(u) { this.redirectTo = u; return this; },
  render(v, d) { this.view = v; this.data = d; return this; },
});
const fakeReq = (raceId, body) => ({ params: { id: String(raceId), tandaId: body.__tandaId }, body, t: k => k });

const equiposDe = (raceId) => db.prepare('SELECT * FROM teams WHERE race_id = ? ORDER BY id').all(raceId);
const pilotosDe = (raceId) => db.prepare('SELECT * FROM drivers WHERE race_id = ? ORDER BY id').all(raceId);

// ── Captura: tanda nueva ─────────────────────────────────────────────────────

test('los equipos del catálogo se inscriben con su categoría y coche (snapshot)', () => {
  const raceId = carrera();
  const catId = TeamCatalog.create({ name: 'E1', color: '#fff', categoria: 'LMGT3', coche: 'Ferrari 296' });

  const res = fakeRes();
  TandaController.create(fakeReq(raceId, { team_catalog_ids: [String(catId)] }), res);

  const [team] = equiposDe(raceId);
  assert.equal(team.categoria, 'LMGT3');
  assert.equal(team.coche, 'Ferrari 296');

  // Snapshot: editar el catálogo después ya no cambia la carrera.
  TeamCatalog.update(catId, { name: 'E1', color: '#fff', categoria: 'LMH', coche: 'Toyota' });
  assert.equal(equiposDe(raceId)[0].categoria, 'LMGT3');
});

test('en individual, cada piloto se inscribe con su categoría y coche', () => {
  const raceId = carrera({ type: 'club', format: 'individual', hasCat: 1, hasCoche: 1 });
  const res = fakeRes();
  TandaController.create(fakeReq(raceId, {
    drivers: { 0: { name: 'Ana', categoria: 'Copa A', coche: 'Coche 1' }, 1: { name: 'Beto', categoria: '', coche: 'Coche 2' } },
  }), res);

  const ds = pilotosDe(raceId);
  assert.equal(ds.length, 2);
  assert.equal(ds[0].name, 'Ana');
  assert.equal(ds[0].categoria, 'Copa A');
  assert.equal(ds[0].coche, 'Coche 1');
  assert.equal(ds[1].categoria, null, 'vacío = sin categoría (opcional)');
  assert.equal(ds[1].coche, 'Coche 2');
});

test('se sigue aceptando el formato antiguo de pilotos (array de nombres)', () => {
  const raceId = carrera({ type: 'club', format: 'individual' });
  const res = fakeRes();
  TandaController.create(fakeReq(raceId, { drivers: ['Ana', 'Beto'] }), res);
  const ds = pilotosDe(raceId);
  assert.deepEqual(ds.map(d => d.name), ['Ana', 'Beto']);
  assert.equal(ds[0].categoria, null);
});

// ── Captura: editar tanda ────────────────────────────────────────────────────

function tandaConMangasPendientes(raceId) {
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId);
  return tandaId;
}

test('editar la tanda (solo renombrar) cambia también categoría y coche', () => {
  const raceId = carrera();
  const tandaId = tandaConMangasPendientes(raceId);
  // Manga YA empezada → modo solo renombrar.
  db.prepare("UPDATE mangas SET status = 'finished' WHERE tanda_id = ?").run(tandaId);

  const teamId = Team.create({ race_id: raceId, tanda_id: tandaId, name: 'E1', lane: 0, color: '#fff', categoria: 'A', coche: 'C1' });
  const body = { teams: { 0: { id: String(teamId), name: 'E1', categoria: 'B', coche: 'C2' } } };
  TandaController.updateTanda({ params: { id: String(raceId), tandaId: String(tandaId) }, body, t: k => k }, fakeRes());

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  assert.equal(team.categoria, 'B');
  assert.equal(team.coche, 'C2');
});

test('un formulario sin los campos nuevos no los borra (guarda por undefined)', () => {
  const raceId = carrera();
  const tandaId = tandaConMangasPendientes(raceId);
  db.prepare("UPDATE mangas SET status = 'finished' WHERE tanda_id = ?").run(tandaId);
  const teamId = Team.create({ race_id: raceId, tanda_id: tandaId, name: 'E1', lane: 0, color: '#fff', categoria: 'A', coche: 'C1' });

  const body = { teams: { 0: { id: String(teamId), name: 'E1 (renombrado)' } } };
  TandaController.updateTanda({ params: { id: String(raceId), tandaId: String(tandaId) }, body, t: k => k }, fakeRes());

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  assert.equal(team.name, 'E1 (renombrado)');
  assert.equal(team.categoria, 'A', 'sin enviar el campo, se conserva');
  assert.equal(team.coche, 'C1');
});

test('la categoría se propaga a todas las filas del equipo con ese nombre (maestra de pole + tanda)', () => {
  const raceId = carrera();
  const tandaId = tandaConMangasPendientes(raceId);
  db.prepare("UPDATE mangas SET status = 'finished' WHERE tanda_id = ?").run(tandaId);
  const master = Team.create({ race_id: raceId, tanda_id: null, name: 'E1', lane: 0, color: '#fff' });
  const enTanda = Team.create({ race_id: raceId, tanda_id: tandaId, name: 'E1', lane: 0, color: '#fff' });

  const body = { teams: { 0: { id: String(enTanda), name: 'E1', categoria: 'GT3', coche: 'X' } } };
  TandaController.updateTanda({ params: { id: String(raceId), tandaId: String(tandaId) }, body, t: k => k }, fakeRes());

  assert.equal(db.prepare('SELECT categoria FROM teams WHERE id = ?').get(master).categoria, 'GT3');
  assert.equal(db.prepare('SELECT categoria FROM teams WHERE id = ?').get(enTanda).categoria, 'GT3');
});

test('al reestructurar la tanda, categoría y coche sobreviven al borrado y recreado', () => {
  const raceId = carrera();
  const tandaId = tandaConMangasPendientes(raceId);   // mangas pendientes → reestructurar
  const body = {
    teams: {
      0: { name: 'E1', categoria: 'LMH', coche: 'Ferrari', members: ['Ana'] },
      1: { name: 'E2', categoria: 'LMGT3', coche: 'Porsche', members: ['Beto'] },
    },
  };
  TandaController.updateTanda({ params: { id: String(raceId), tandaId: String(tandaId) }, body, t: k => k }, fakeRes());

  const teams = equiposDe(raceId);
  assert.equal(teams.length, 2);
  assert.deepEqual(teams.map(t => t.categoria), ['LMH', 'LMGT3']);
  assert.deepEqual(teams.map(t => t.coche), ['Ferrari', 'Porsche']);
});

// ── Lectura ──────────────────────────────────────────────────────────────────

function conCarriles(raceId, { teamCat = null, driverCat = null, individual = false } = {}) {
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mid = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  const teamId = individual ? null : Team.create({ race_id: raceId, tanda_id: tandaId, name: 'E1', lane: 1, color: '#fff', categoria: teamCat });
  db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, 1, ?, 0)').run(mid, teamId);
  const driverId = db.prepare('INSERT INTO drivers (race_id, tanda_id, team_id, name, categoria) VALUES (?, ?, ?, ?, ?)')
    .run(raceId, tandaId, teamId, 'Ana', driverCat).lastInsertRowid;
  db.prepare('UPDATE manga_lanes SET driver_id = ? WHERE manga_id = ? AND lane = 1').run(driverId, mid);
  return { tandaId, mid, teamId, driverId };
}

test('la categoría de la carrera manda; si está vacía, la del catálogo por nombre', () => {
  TeamCatalog.create({ name: 'E1', color: '#fff', categoria: 'DEL CATALOGO', coche: 'Coche cat' });
  const raceA = carrera();
  conCarriles(raceA, { teamCat: 'DE LA CARRERA' });
  assert.equal(Manga.getLanes(db.prepare('SELECT id FROM mangas WHERE race_id = ?').get(raceA).id)[0].team_categoria, 'DE LA CARRERA');

  const raceB = carrera();
  conCarriles(raceB, { teamCat: null });
  assert.equal(Manga.getLanes(db.prepare('SELECT id FROM mangas WHERE race_id = ?').get(raceB).id)[0].team_categoria, 'DEL CATALOGO',
    'sin valor propio cae al catálogo (carreras antiguas)');
});

test('en individual se lee la categoría del piloto', () => {
  const raceId = carrera({ type: 'club', format: 'individual' });
  const { mid } = conCarriles(raceId, { driverCat: 'COPA B', individual: true });
  const lane = Manga.getLanes(mid)[0];
  assert.equal(lane.team_id, null);
  assert.equal(lane.driver_categoria, 'COPA B');
});

test('el agregado y la proyección llevan categoría y coche (equipo y piloto)', () => {
  const raceId = carrera({ type: 'club', format: 'individual' });
  const { mid, driverId } = conCarriles(raceId, { driverCat: 'COPA B', individual: true });
  db.prepare('UPDATE drivers SET coche = ? WHERE id = ?').run('Coche B', driverId);
  db.prepare("UPDATE mangas SET status = 'finished' WHERE id = ?").run(mid);
  for (let i = 1; i <= 5; i++) {
    Lap.create({ race_id: raceId, manga_id: mid, driver_id: driverId, lane: 1,
                 lap_number: i, lap_time_ms: 9000, elapsed_ms: i * 9000 });
  }

  const rows = Lap.aggregateByRace(raceId);
  assert.equal(rows[0].categoria, 'COPA B');
  assert.equal(rows[0].coche, 'Coche B');
  // La vía troceada (manga viva) da lo mismo.
  const split = Lap.aggregateByRaceSplit(raceId, mid, []);
  assert.equal(split[0].categoria, 'COPA B');
  assert.equal(split[0].coche, 'Coche B');

  const { buildRaceProjection } = require('../src/engine/raceProjection');
  const proj = buildRaceProjection(raceId);
  assert.equal(proj[0].categoria, 'COPA B', 'la clasificación estimada también la lleva');
});

// ── Interruptores de carrera ─────────────────────────────────────────────────

test('Race.create y Race.update persisten los interruptores', () => {
  const raceId = Race.create({ name: 'R', type: 'club', format: 'individual', lanes_count: 2, has_categoria: 1 });
  let race = Race.findById(raceId);
  assert.equal(race.has_categoria, 1);
  assert.equal(race.has_coche, 0, 'por defecto apagado');

  Race.update(raceId, { has_coche: 1, has_categoria: 0 });
  race = Race.findById(raceId);
  assert.equal(race.has_categoria, 0);
  assert.equal(race.has_coche, 1);
});

// ── Excel ────────────────────────────────────────────────────────────────────

function seedCarreraExcel({ hasCat, hasCoche, teamCat = 'LMGT3', teamCoche = 'Ferrari' }) {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, min_lap_ms, has_categoria, has_coche)
    VALUES ('exp', 'championship', 'team', 'finished', 2, '[1,2]', '[2]', 10, 4000, ?, ?)
  `).run(hasCat, hasCoche).lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mid = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='finished', started_at='2020-01-01 00:00:00', finished_at='2020-01-01 00:10:00', actual_duration_ms=600000 WHERE id=?").run(mid);
  ['Uno', 'Dos'].forEach((name, i) => {
    const tid = Team.create({ race_id: raceId, tanda_id: tandaId, name, lane: 0, color: '#fff',
                              categoria: i === 0 ? teamCat : null, coche: i === 0 ? teamCoche : null });
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,?,?,0)').run(mid, i + 1, tid);
    for (let k = 0; k < 12; k++) {
      Lap.create({ race_id: raceId, manga_id: mid, team_id: tid, lane: i + 1,
                   lap_number: k + 1, lap_time_ms: 9000 + i * 200, elapsed_ms: 9000 * (k + 1) });
    }
  });
  return { raceId };
}

async function excelDe(raceId) {
  const ExcelJS = require('exceljs');
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader() { return this; },
    send(b) { this.body = b; return this; },
    render() { return this; },
  };
  await SessionController.excel({ params: { id: String(raceId) }, query: { lang: 'es' }, t: s => s }, res);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
}
// La cabecera no está en una fila fija (banda de título, banner de vuelta rápida…):
// se busca la fila que contiene el nombre de la primera columna de datos.
function filaCabecera(ws, marcador = 'Piloto / Equipo') {
  for (let i = 1; i <= ws.rowCount; i++) {
    const vals = ws.getRow(i).values;
    if (vals.some(v => v === marcador)) return ws.getRow(i);
  }
  throw new Error('cabecera no encontrada: ' + marcador);
}

test('Excel: sin los interruptores no hay columnas nuevas', async () => {
  const { raceId } = seedCarreraExcel({ hasCat: 0, hasCoche: 0 });
  const wb = await excelDe(raceId);
  const s1 = wb.getWorksheet('Clasificación');
  const header = filaCabecera(s1).values.join(',');
  assert.ok(header.includes('Piloto / Equipo'), 'es la cabecera de verdad: ' + header);
  assert.ok(!header.includes('Categoría') && !header.includes('Coche'), 'cabecera limpia: ' + header);
  assert.deepEqual(filaCabecera(s1).values.slice(1, 4), ['#', 'Piloto / Equipo', 'Total vueltas']);
});

test('Excel: con los interruptores, categoría y coche salen junto al nombre', async () => {
  const { raceId } = seedCarreraExcel({ hasCat: 1, hasCoche: 1, teamCat: 'LMGT3', teamCoche: 'Ferrari 296' });
  const wb = await excelDe(raceId);
  const s1 = wb.getWorksheet('Clasificación');
  const h1 = filaCabecera(s1);
  assert.deepEqual(h1.values.slice(1, 6), ['#', 'Piloto / Equipo', 'Categoría', 'Coche', 'Total vueltas']);
  const fila1 = s1.getRow(h1.number + 1).values.slice(1);
  assert.equal(fila1[1], 'Uno');
  assert.equal(fila1[2], 'LMGT3');
  assert.equal(fila1[3], 'Ferrari 296');

  // La comparativa mantiene alineadas sus columnas de carril.
  const s4 = wb.getWorksheet('Comparativa');
  const h4 = filaCabecera(s4, 'Equipo / Piloto');
  assert.deepEqual(h4.values.slice(1, 7), ['#', 'Equipo / Piloto', 'Categoría', 'Coche', 'Vueltas', 'Pista 1']);
  // Y los datos de la pista 1 siguen en su columna (offsets bien desplazados).
  const filaA = s4.getRow(h4.number + 1).values.slice(1);
  assert.ok(String(filaA[1]).startsWith('Uno'), 'nombre en su columna: ' + filaA[1]);
  assert.equal(filaA[2], 'LMGT3', 'categoría junto al nombre');
  assert.equal(filaA[3], 'Ferrari 296', 'coche junto al nombre');
  assert.equal(filaA[4], 12, 'vueltas totales en su columna');
  assert.ok(String(filaA[5]).startsWith('12'), 'la primera pista sigue alineada: ' + filaA[5]);
});
