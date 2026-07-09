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
// Dos botones que pueden tirar la carrera de 24 h. Auditoría 2026-07-09:
//
//   D5 — `GET /api/test/stop` llamaba a cancelManga(), que BORRA todas las vueltas
//        de la manga activa. Sin autenticación, y por ser un GET bastaba un
//        <img src="…/api/test/stop"> en cualquier página abierta en el PC de
//        control para dispararlo.
//   D6 — El botón de diagnóstico "Eliminar pending setup" marcaba como
//        'completed' TODAS las carreras activas con mangas pendientes. En una 24h
//        siempre las hay (las tandas futuras), así que completaba la carrera en
//        curso y el GO dejaba de encadenar mangas: la carrera se paraba sin aviso.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const TimingService = require('../src/services/TimingService');

after(limpiarBdTemporal);

beforeEach(() => {
  TimingService.session = null;
  for (const t of ['laps', 'manga_lanes', 'mangas', 'tandas', 'races']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

/** Carrera activa con una manga corriendo y otra pendiente (como una 24h a mitad). */
function carreraEnCurso() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config,
                       manga_duration_minutes, driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES ('24h en curso', 'championship', 'team', 'active', 2, '[1,2]', '[2]', 60, 0, 0, 0, 0)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const enCurso  = db.prepare("INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, 1, 'active')").run(tandaId, raceId).lastInsertRowid;
  const siguiente = db.prepare("INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, 2, 'pending')").run(tandaId, raceId).lastInsertRowid;
  return { raceId, tandaId, enCurso, siguiente };
}

const estadoCarrera = (id) => db.prepare('SELECT status FROM races WHERE id = ?').get(id).status;

// ── D6: el botón trampa de diagnóstico ─────────────────────────────────────

test('"Eliminar pending setup" NO completa la carrera que se está corriendo', () => {
  const { raceId, enCurso } = carreraEnCurso();
  // El motor tiene esa carrera viva.
  TimingService.session = { manga: { id: enCurso }, race: { id: raceId }, circuits: {}, laneToCircuit: {} };

  const DiagnosticsController = require('../src/controllers/DiagnosticsController');
  const req = { session: {}, t: (k) => k };
  DiagnosticsController.clearPending(req, { redirect: () => {} });

  assert.equal(estadoCarrera(raceId), 'active',
    'la carrera de 24 h en curso no se puede dar por terminada desde diagnóstico');
  assert.match(req.session.flash.text, /EN CURSO/, 'y se le dice al operario por qué');
});

test('"Eliminar pending setup" SÍ cierra las carreras activas que no se están corriendo', () => {
  const { raceId } = carreraEnCurso();            // esta no está en el motor
  TimingService.session = null;

  const DiagnosticsController = require('../src/controllers/DiagnosticsController');
  const req = { session: {}, t: (k) => k };
  DiagnosticsController.clearPending(req, { redirect: () => {} });

  assert.equal(estadoCarrera(raceId), 'completed',
    'una carrera activa huérfana sí roba el GO y hay que cerrarla');
});

test('con dos carreras activas, solo se cierra la que no corre', () => {
  const viva = carreraEnCurso();
  const otra = carreraEnCurso();
  TimingService.session = { manga: { id: viva.enCurso }, race: { id: viva.raceId }, circuits: {}, laneToCircuit: {} };

  const DiagnosticsController = require('../src/controllers/DiagnosticsController');
  DiagnosticsController.clearPending({ session: {}, t: (k) => k }, { redirect: () => {} });

  assert.equal(estadoCarrera(viva.raceId), 'active');
  assert.equal(estadoCarrera(otra.raceId), 'completed');
});

// ── D5: los endpoints destructivos ─────────────────────────────────────────

test('los endpoints de prueba NO están montados sin PITWALL_TEST_ENDPOINTS', () => {
  const rutasDe = (router) => router.stack
    .filter(l => l.route)
    .map(l => l.route.path);

  delete process.env.PITWALL_TEST_ENDPOINTS;
  delete require.cache[require.resolve('../src/routes/index')];
  const rutas = rutasDe(require('../src/routes/index'));

  const peligrosas = rutas.filter(p => p.startsWith('/api/test/') || p === '/api/rawlog');
  assert.deepEqual(peligrosas, [],
    '/api/test/stop borra las vueltas de la manga activa: no puede existir en carrera');
});

test('los endpoints de prueba SÍ se montan en el banco (PITWALL_TEST_ENDPOINTS=1)', () => {
  process.env.PITWALL_TEST_ENDPOINTS = '1';
  delete require.cache[require.resolve('../src/routes/index')];
  const rutas = require('../src/routes/index').stack.filter(l => l.route).map(l => l.route.path);
  delete process.env.PITWALL_TEST_ENDPOINTS;

  assert.ok(rutas.includes('/api/test/stop'), 'el banco de pruebas los necesita');
  assert.ok(rutas.includes('/api/rawlog'));
});
