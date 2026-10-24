const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ul = require('../electron/updateLogic');
const UpdateBackup = require('../src/services/UpdateBackup');

test('modo: se instala solo donde electron-updater sabe hacerlo', () => {
  assert.equal(ul.updateMode({ packaged: true, platform: 'darwin' }), 'auto');
  assert.equal(ul.updateMode({ packaged: true, platform: 'win32', env: {} }), 'auto');
  assert.equal(ul.updateMode({ packaged: true, platform: 'linux', env: { APPIMAGE: '/x/PitWall.AppImage' } }), 'auto');
  assert.equal(ul.updateMode({ packaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } }), 'manual');
  assert.equal(ul.updateMode({ packaged: true, platform: 'linux', env: {} }), 'manual');
  assert.equal(ul.updateMode({ packaged: false, platform: 'darwin' }), 'manual');
});

test('fichero de versiones por plataforma', () => {
  assert.equal(ul.channelFile('darwin'), 'latest-mac.yml');
  assert.equal(ul.channelFile('win32'), 'latest.yml');
  assert.equal(ul.channelFile('linux'), 'latest-linux.yml');
});

test('compara versiones como números, no como texto', () => {
  assert.equal(ul.isNewer('1.65.0', '1.64.4'), true);
  assert.equal(ul.isNewer('1.64.10', '1.64.9'), true);
  assert.equal(ul.isNewer('1.64.4', '1.64.4'), false);
  assert.equal(ul.isNewer('1.63.9', '1.64.4'), false);
  assert.equal(ul.isNewer('basura', '1.64.4'), false);
});

test('página de descarga por idioma, español si no hay', () => {
  assert.equal(ul.downloadPage('it'), 'https://www.pitwall.es/pitwall-manager-it.html');
  assert.equal(ul.downloadPage('ca'), 'https://www.pitwall.es/pitwall-manager.html');
});

test('la copia previa a actualizar va junto a la BD y se quedan las 3 últimas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upd-'));
  const fakeDb = {
    name: path.join(dir, 'pitwall.db'),
    backup: async (file) => fs.writeFileSync(file, 'db'),
  };
  for (let i = 0; i < 5; i++) {
    const old = path.join(dir, `${UpdateBackup.PREFIX}1.60.${i}-2026010${i}-000000`);
    fs.mkdirSync(old);
    const t = new Date(2026, 0, 1 + i);
    fs.utimesSync(old, t, t);
  }
  const file = await UpdateBackup.create('1.64.4', fakeDb);
  assert.equal(path.dirname(path.dirname(file)), dir);
  assert.match(path.basename(path.dirname(file)), /^_backup-pre-update-1\.64\.4-\d{8}-\d{6}$/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'db');
  const left = fs.readdirSync(dir).filter(n => n.startsWith(UpdateBackup.PREFIX)).sort();
  assert.equal(left.length, 3);
  assert.ok(left.some(n => n.includes('1.64.4')));
  assert.ok(left.includes(`${UpdateBackup.PREFIX}1.60.4-20260104-000000`));
  fs.rmSync(dir, { recursive: true, force: true });
});
