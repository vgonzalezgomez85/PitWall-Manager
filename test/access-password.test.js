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
// Contraseña de organización (Ajustes → Seguridad). Es para que quien no conoce
// el programa no toque lo que no debe: protege Sistema y Catálogo, también en
// localhost. El inicio y Competición (carreras, entrenos, directo…) no la piden.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Settings       = require('../src/models/Settings');
const AccessPassword = require('../src/services/AccessPassword');
const { restrictAccess, annotateAccess } = require('../src/middleware/accessControl');

after(limpiarBdTemporal);

beforeEach(() => {
  delete process.env.PITWALL_DISABLE_PASSWORD;
  Settings.set('access_restrict_enabled', '1');
  Settings.set('access_allowlist', '[]');
  AccessPassword.setEnabled(false);
  AccessPassword._resetFails();
});

function activar(pw = 'club1234') {
  AccessPassword.setPassword(pw);
  AccessPassword.setEnabled(true);
}

// Pasa la petición por el middleware y dice qué pasó.
function pedir(path, { ip = '127.0.0.1', authed = false, method = 'GET', accept = 'text/html' } = {}) {
  const req = { path, originalUrl: path, method, ip, xhr: false, headers: { accept },
                session: authed ? { pwAuthed: true } : {} };
  const out = { next: false, status: 200, redirect: null, json: null };
  const res = {
    locals: {},
    status(c) { out.status = c; return this; },
    redirect(u) { out.status = 302; out.redirect = u; },
    json(j) { out.json = j; },
    render() {},
  };
  restrictAccess(req, res, () => { out.next = true; });
  return out;
}

test('el hash no guarda la contraseña y verifica solo la buena', () => {
  const h = AccessPassword.hash('secreta');
  assert.ok(!h.includes('secreta'));
  assert.equal(AccessPassword.verify('secreta', h), true);
  assert.equal(AccessPassword.verify('otra', h), false);
  assert.notEqual(AccessPassword.hash('secreta'), h, 'cada hash lleva su sal');
});

test('desactivada: todo como antes', () => {
  assert.equal(pedir('/settings').next, true);
  assert.equal(pedir('/').next, true);
});

test('activada: Sistema y Catálogo la piden, también en localhost, y vuelven a donde iban', () => {
  activar();
  for (const p of ['/settings', '/database', '/catalog-sync', '/link', '/ecosystem', '/diagnostico',
                   '/drivers', '/teams/4/edit', '/cars', '/categories', '/circuits/new']) {
    assert.equal(pedir(p).next, false, p);
  }
  assert.equal(pedir('/drivers/3').redirect, '/login?next=%2Fdrivers%2F3');
  assert.equal(pedir('/settings', { authed: true }).next, true, 'con sesión iniciada entra');
});

test('activada: el inicio y Competición no la piden', () => {
  activar();
  for (const p of ['/', '/races', '/races/new', '/races/3/mangas/9/live', '/races/3/mangas/9/corrections',
                   '/training/free', '/training/competition', '/results', '/race-stats', '/lap',
                   '/api/home/state', '/api/teams-catalog/quick', '/home/mode']) {
    assert.equal(pedir(p).next, true, p);
  }
});

test('activada: lo público y las integraciones no la piden', () => {
  activar();
  for (const p of ['/results/4', '/lap/2/team/5', '/races/2/live-stats', '/api/mobile/races',
                   '/link/races', '/link/state', '/login', '/logout']) {
    assert.equal(pedir(p).next, true, p);
  }
  assert.equal(pedir('/import/tanda', { method: 'POST', ip: '10.0.0.9' }).next, true, 'import va con su PIN');
});

test('activada: una llamada de API sin sesión recibe 401, no una redirección', () => {
  activar();
  const r = pedir('/api/settings/ports', { accept: 'application/json' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'auth_required' });
  assert.equal(pedir('/api/categories', { method: 'POST' }).status, 401, 'alta de categoría desde el circuito');
});

test('la restricción por IP sigue mandando: desde fuera es 403 aunque haya contraseña', () => {
  activar();
  assert.equal(pedir('/settings', { ip: '192.168.1.77', authed: true }).status, 403);
  assert.equal(pedir('/', { ip: '192.168.1.77' }).next, true, 'el inicio público del invitado no cambia');
});

test('sin sesión el inicio sigue siendo de administración, con Sistema y Catálogo bajo candado', () => {
  activar();
  const res = { locals: {} };
  annotateAccess({ ip: '127.0.0.1', headers: {}, session: {} }, res, () => {});
  assert.equal(res.locals.isAdminAccess, true);
  assert.equal(res.locals.pwLocked, true);
  annotateAccess({ ip: '127.0.0.1', headers: {}, session: { pwAuthed: true } }, res, () => {});
  assert.equal(res.locals.pwLocked, false);
});

test('PITWALL_DISABLE_PASSWORD=1 la ignora (salida si se olvida)', () => {
  activar();
  process.env.PITWALL_DISABLE_PASSWORD = '1';
  assert.equal(pedir('/settings').next, true);
});

test('cinco fallos seguidos bloquean esa IP un rato, incluso con la buena', () => {
  activar('buena');
  for (let i = 0; i < 4; i++) assert.equal(AccessPassword.attempt('1.2.3.4', 'mala').lockedMs, 0);
  assert.ok(AccessPassword.attempt('1.2.3.4', 'mala').lockedMs > 0);
  assert.equal(AccessPassword.attempt('1.2.3.4', 'buena').ok, false);
  assert.equal(AccessPassword.attempt('5.6.7.8', 'buena').ok, true, 'otra IP no se ve afectada');
});

test('desactivar borra la contraseña guardada', () => {
  activar();
  AccessPassword.setEnabled(false);
  assert.equal(AccessPassword.hasPassword(), false);
  assert.equal(AccessPassword.isEnabled(), false);
});

test('el propio equipo nunca se queda bloqueado por fallar', () => {
  activar('buena');
  for (let i = 0; i < 8; i++) assert.equal(AccessPassword.attempt('127.0.0.1', 'mala', { lockable: false }).lockedMs, 0);
  assert.equal(AccessPassword.attempt('127.0.0.1', 'buena', { lockable: false }).ok, true);
});

test('la contraseña sigue activa tras reiniciar PitWall (se guarda en la BD)', () => {
  activar('buena');
  AccessPassword._resetFails();          // equivale a un proceso nuevo: sin nada en memoria
  assert.equal(AccessPassword.isEnabled(), true);
  assert.equal(pedir('/settings').next, false, 'una sesión nueva tiene que entrar con contraseña');
});
