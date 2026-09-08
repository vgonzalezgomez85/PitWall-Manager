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
// La exportación a Excel de resultados:
//   · con una manga viva → 409 y NO se genera fichero,
//   · sin manga viva     → genera un .xlsx válido (cabecera ZIP "PK"),
//   · si el build lanza ExportAbortedError (arrancó una manga a media
//     exportación) → el wrapper responde 409, no propaga el error.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();
process.env.PITWALL_NO_WORKER = '1';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const TimingService = require('../src/services/TimingService');
const ExportGuard = require('../src/services/ExportGuard');
const SessionController = require('../src/controllers/SessionController');

after(() => limpiarBdTemporal());

function seedRace() {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes, min_lap_ms)
    VALUES ('exp', 'championship', 'team', 'finished', 2, '[1,2]', '[2]', 10, 4000)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const teams = ['Uno', 'Dos'].map(n =>
    db.prepare('INSERT INTO teams (race_id, tanda_id, name, lane) VALUES (?, ?, ?, 0)').run(raceId, tandaId, n).lastInsertRowid);
  const mid = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='finished', started_at='2020-01-01 00:00:00', finished_at='2020-01-01 00:10:00', actual_duration_ms=600000 WHERE id=?").run(mid);
  let n = 0;
  teams.forEach((tid, i) => {
    const ln = i + 1;
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?,?,?,0)').run(mid, ln, tid);
    for (let k = 0; k < 12; k++) {
      Lap.create({
        race_id: raceId, manga_id: mid, team_id: tid, driver_id: null, lane: ln,
        lap_number: ++n, lap_time_ms: 9000 + i * 200 + (k % 3) * 50,
        elapsed_ms: 9000 * (k + 1), is_exit: k === 5 ? 1 : 0,
      });
    }
  });
  return { raceId };
}

function mockReq(raceId) {
  return { params: { id: String(raceId) }, query: { lang: 'es' }, t: (s) => s };
}
function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, rendered: null, headersSent: false,
    status(c) { res.statusCode = c; return res; },
    setHeader(k, v) { res.headers[k] = v; },
    render(view, locals) { res.rendered = { view, locals }; res.headersSent = true; return res; },
    send(b) { res.body = b; res.headersSent = true; return res; },
  };
  return res;
}

const withMangaLive = (fn) => {
  Object.defineProperty(TimingService, 'isMangaLive', { value: true, configurable: true });
  try { return fn(); }
  finally { delete TimingService.isMangaLive; }
};

test('sin manga viva: genera un .xlsx válido', async () => {
  const { raceId } = seedRace();
  const res = mockRes();
  await SessionController.excel(mockReq(raceId), res);
  assert.equal(res.statusCode, 200);
  assert.ok(Buffer.isBuffer(res.body), 'devuelve un Buffer');
  assert.equal(res.body.slice(0, 2).toString('latin1'), 'PK', 'cabecera de fichero ZIP/xlsx');
  assert.equal(res.rendered, null, 'no renderiza página de error');
});

test('con manga viva: 409 y NO se genera fichero', async () => {
  const { raceId } = seedRace();
  const res = mockRes();
  await withMangaLive(() => SessionController.excel(mockReq(raceId), res));
  assert.equal(res.statusCode, 409);
  assert.equal(res.rendered.view, 'error');
  assert.equal(res.rendered.locals.code, 409);
  assert.equal(res.body, null, 'no hay xlsx');
  assert.equal(ExportGuard.activeCount, 0, 'no queda ninguna exportación colgada');
});

test('puntos: con manga viva también responde 409', async () => {
  const { raceId } = seedRace();
  const res = mockRes();
  await withMangaLive(() => SessionController.pointsExcel(mockReq(raceId), res));
  assert.equal(res.statusCode, 409);
  assert.equal(res.rendered.view, 'error');
});

test('si el build lanza ExportAbortedError, el wrapper responde 409 (no propaga)', async () => {
  const { raceId } = seedRace();
  const orig = SessionController._excelBuild;
  SessionController._excelBuild = async () => { throw new ExportGuard.ExportAbortedError(); };
  try {
    const res = mockRes();
    await SessionController.excel(mockReq(raceId), res);   // no debe rechazar
    assert.equal(res.statusCode, 409);
    assert.equal(res.rendered.view, 'error');
    assert.equal(ExportGuard.activeCount, 0);
  } finally {
    SessionController._excelBuild = orig;
  }
});
