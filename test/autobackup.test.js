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
// Copia automática de la BD al arrancar (services/AutoBackup): instantánea
// consistente (VACUUM INTO), rotación, intervalo mínimo por versión y que nunca
// pueda romper el arranque.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const AutoBackup = require('../src/services/AutoBackup');

let dir, db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-autobackup-'));
  db = new Database(path.join(dir, 'pitwall.db'));
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('uno'), ('dos');");
});
afterEach(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
// El intervalo se mide con la fecha del fichero: se la ponemos igual al `now` simulado.
const snap = (version, now, opts = {}) => {
  const f = AutoBackup.snapshot(db, dir, version, { now, ...opts });
  if (f) fs.utimesSync(f, new Date(now), new Date(now));
  return f;
};
const sinGuardaDeTests = (fn) => {
  const ctx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { fn(); } finally { if (ctx !== undefined) process.env.NODE_TEST_CONTEXT = ctx; }
};

test('la copia es una BD válida con los datos, también los que siguen en el WAL', () => {
  const file = AutoBackup.snapshot(db, dir, '1.2.3', { now: T0, force: true });
  assert.match(path.basename(file), /^pitwall-\d{8}-\d{6}-v1\.2\.3\.db$/);
  assert.equal(path.dirname(file), path.join(dir, AutoBackup.DIR_NAME));
  const copia = new Database(file, { readonly: true });
  assert.deepEqual(copia.prepare('SELECT v FROM t ORDER BY id').all().map(r => r.v), ['uno', 'dos']);
  copia.close();
});

test('en los tests y con PITWALL_NO_AUTOBACKUP=1 no copia', () => {
  assert.equal(AutoBackup.snapshot(db, dir, '1.2.3', { now: T0 }), null, 'node --test fija NODE_TEST_CONTEXT');
  sinGuardaDeTests(() => {
    process.env.PITWALL_NO_AUTOBACKUP = '1';
    try { assert.equal(AutoBackup.snapshot(db, dir, '1.2.3', { now: T0 }), null); }
    finally { delete process.env.PITWALL_NO_AUTOBACKUP; }
  });
  assert.equal(fs.existsSync(path.join(dir, AutoBackup.DIR_NAME)), false);
});

test('misma versión: no repite antes de 6 h; versión nueva o pasado el intervalo, sí', () => {
  sinGuardaDeTests(() => {
    assert.ok(snap('1.0.0', T0), 'primera copia');
    assert.equal(snap('1.0.0', T0 + 60 * 1000), null, 'reinicio 1 min después');
    assert.ok(snap('1.0.1', T0 + 120 * 1000), 'versión nueva: siempre copia');
    assert.equal(snap('1.0.1', T0 + 180 * 1000), null);
    assert.ok(snap('1.0.1', T0 + 7 * 3600 * 1000), 'pasadas 6 h vuelve a copiar');
  });
});

test('rotación: solo quedan las KEEP últimas y no toca ficheros ajenos', () => {
  const bdir = path.join(dir, AutoBackup.DIR_NAME);
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'mia.db'), 'x');
  for (let i = 0; i < AutoBackup.KEEP + 3; i++) snap('1.0.0', T0 + i * 1000, { force: true });
  const left = AutoBackup.list(dir);
  assert.equal(left.length, AutoBackup.KEEP);
  assert.equal(left[0].mtime, T0 + (AutoBackup.KEEP + 2) * 1000, 'la más nueva se queda');
  assert.ok(fs.existsSync(path.join(bdir, 'mia.db')));
});

test('un fallo devuelve null y no lanza', () => {
  const rota = { prepare() { throw new Error('disco lleno'); } };
  assert.equal(AutoBackup.snapshot(rota, dir, '1.0.0', { now: T0, force: true }), null);
});

test('una ruta con comillas simples no rompe el VACUUM INTO', () => {
  const raro = fs.mkdtempSync(path.join(os.tmpdir(), "pw'auto-"));
  try {
    const file = AutoBackup.snapshot(db, raro, '1.0.0', { now: T0, force: true });
    assert.ok(file && fs.existsSync(file));
  } finally { fs.rmSync(raro, { recursive: true, force: true }); }
});
