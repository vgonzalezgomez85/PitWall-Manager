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
// El informe final es el documento con el que se resuelve una reclamación.
// Lo que se le exige: que NADIE se le escape (ni el que nunca fichó), que las
// infracciones sean las que son, y que el HTML autónomo se pueda adjuntar.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const DriverShift = require('../src/models/DriverShift');
const ControlController = require('../src/controllers/ControlController');
const { crearPerfil, crearEquipoCatalogo, crearCarreraConManga } = require('./helpers/seed');

after(limpiarBdTemporal);

const MIN = 60000;
const H   = 60 * MIN;

beforeEach(() => {
  for (const t of ['driver_shifts', 'manga_lanes', 'drivers', 'teams', 'mangas', 'tandas', 'races',
                   'teams_catalog_members', 'teams_catalog', 'driver_profiles']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

/**
 * Un equipo con 4 pilotos, uno de cada tipo:
 *   Ana   → se pasa de TIEMPO   (4 h de máximo)
 *   Bea   → se pasa de TURNOS   (5 de máximo)
 *   Caro  → cumple
 *   Dani  → NUNCA fichó         (bajo mínimo: 1 h)
 */
function escenarioInforme() {
  const perfiles = ['Ana', 'Bea', 'Caro', 'Dani'].map(n => ({ nombre: n, id: crearPerfil(n) }));
  crearEquipoCatalogo('Equipo A', perfiles);
  const { raceId, mangaId, teams } = crearCarreraConManga(
    [{ nombre: 'Equipo A', pilotos: perfiles }],
    { minMs: 1 * H, maxMs: 4 * H, maxRuns: 5 },
  );
  const team = teams[0];

  const turno = (nombre, ms, { manual = 0 } = {}) => {
    const d = team.drivers.find(x => x.name === nombre);
    db.prepare(`
      INSERT INTO driver_shifts (manga_id, race_id, lane, team_id, driver_id, driver_name,
                                 started_at_ms, ended_at_ms, driving_ms, pre_armed, manual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(mangaId, raceId, team.lane, team.id, d ? d.id : null, nombre, 1000, 2000, ms, manual);
  };

  turno('Ana', 4 * H);                       // exactamente el máximo → PASADO
  for (let i = 0; i < 5; i++) turno('Bea', 20 * MIN);   // 5 turnos → PASADO DE TURNOS (1h40, sobre mínimo)
  turno('Caro', 2 * H);                      // dentro de todo
  turno('Caro', 30 * MIN, { manual: 1 });    // + corrección manual
  // Dani: ni una fila.

  return { raceId, mangaId, team };
}

const porNombre = (summary, n) => summary.find(r => r.profile_name === n);

test('el informe incluye al piloto que NUNCA fichó, a 0:00 y bajo mínimo', () => {
  const { raceId } = escenarioInforme();
  const { summary } = ControlController._reportData(raceId);

  const dani = porNombre(summary, 'Dani');
  assert.ok(dani, 'el piloto que nunca fichó debe aparecer en el informe');
  assert.equal(dani.total_ms, 0);
  assert.equal(dani.runs_count, 0);
  assert.equal(dani.compliance.underMin, true);
  assert.equal(dani.compliance.status, 'bad');
});

test('las infracciones son exactamente las esperadas', () => {
  const { raceId } = escenarioInforme();
  const { summary, infracciones } = ControlController._reportData(raceId);

  assert.equal(porNombre(summary, 'Ana').compliance.overMax, true);
  assert.equal(porNombre(summary, 'Bea').compliance.overRuns, true);
  assert.equal(porNombre(summary, 'Caro').compliance.status, 'ok');
  assert.equal(porNombre(summary, 'Dani').compliance.underMin, true);

  assert.deepEqual(infracciones.map(r => r.profile_name).sort(), ['Ana', 'Bea', 'Dani']);
});

test('las correcciones manuales se cuentan y se marcan', () => {
  const { raceId } = escenarioInforme();
  const { summary, manuales } = ControlController._reportData(raceId);

  assert.equal(manuales, 1, 'hay exactamente una corrección manual en la carrera');
  assert.equal(porNombre(summary, 'Caro').manual_count, 1);
  assert.equal(porNombre(summary, 'Caro').total_ms, 2 * H + 30 * MIN, 'el tiempo manual suma al total');
  assert.equal(porNombre(summary, 'Ana').manual_count, 0);
});

test('los turnos rodados se cuentan por runs_count, no por filas', () => {
  const { raceId, mangaId, team } = escenarioInforme();
  // Un pre-arme que nunca arrancó: es una fila más, pero NO un turno.
  DriverShift.openShift({
    mangaId, raceId, lane: team.lane, teamId: team.id,
    driverId: team.drivers.find(d => d.name === 'Caro').id,
    driverName: 'Caro', preArmed: true,
  });

  const { summary } = ControlController._reportData(raceId);
  const caro = porNombre(summary, 'Caro');
  assert.equal(caro.runs_count, 2, 'los pre-armes que nunca arrancaron no son turnos');
  assert.equal(caro.shifts_count, 3, 'pero sí son filas de driver_shifts');
  assert.equal(caro.compliance.overRuns, false);
});

test('una carrera que no es de campeonato no tiene informe', () => {
  const { raceId } = escenarioInforme();
  db.prepare("UPDATE races SET type = 'club' WHERE id = ?").run(raceId);   // los turnos son de campeonato
  assert.equal(ControlController._reportData(raceId), null);
  assert.equal(ControlController._reportData(999999), null);
});

test('el informe se ordena por tiempo total, de más a menos', () => {
  const { raceId } = escenarioInforme();
  const { summary } = ControlController._reportData(raceId);
  const totales = summary.map(r => r.total_ms);
  assert.deepEqual(totales, [...totales].sort((a, b) => b - a));
  assert.equal(summary[0].profile_name, 'Ana');            // 4 h
  assert.equal(summary[summary.length - 1].profile_name, 'Dani');   // 0
});

test('la vista del informe se renderiza y marca cada infracción', async () => {
  const { raceId } = escenarioInforme();
  const data = ControlController._reportData(raceId);

  const ejs  = require('ejs');
  const path = require('path');
  const html = await ejs.renderFile(
    path.resolve(__dirname, '../src/views/control/shifts-report.ejs'),
    {
      ...data, t: (k) => k, lang: 'es',
      fmtHms: require('../src/utils/duration').fmtHms,
      shiftCompliance: require('../src/utils/shiftCompliance').evaluate,
      shiftBadge: require('../src/utils/shiftCompliance').badgeClass,
      appVersion: '0.0.0-test',
    },
    { root: path.resolve(__dirname, '../src/views') },
  );

  assert.match(html, /PASADO DE TIEMPO/, 'Ana');
  assert.match(html, /PASADO DE TURNOS/, 'Bea');
  assert.match(html, /BAJO MÍNIMO/,      'Dani');
  assert.match(html, /4:00:00/, 'los totales largos van en h:mm:ss');
  assert.doesNotMatch(html, /240:00/, 'nunca m:ss para 4 horas');
  assert.match(html, /Dani/, 'el que nunca fichó sale en la tabla');
  assert.match(html, /@media print/, 'el informe es imprimible');
});
