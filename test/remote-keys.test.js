const test = require('node:test');
const assert = require('node:assert/strict');
const RK = require('../src/lib/remoteKeys');
const W = require('../electron/remoteKeysWindows');

const ev = (code, mods = {}) => ({ code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift });

test('normaliza aceleradores: alias, mayúsculas y orden de modificadores', () => {
  assert.equal(RK.normalize('cmdorctrl+shift+alt+g'), 'CommandOrControl+Alt+Shift+G');
  assert.equal(RK.normalize('Ctrl+Option+f13'), 'Control+Alt+F13');
  assert.equal(RK.normalize('F24'), 'F24');
  assert.equal(RK.normalize('Ctrl+Return'), 'Control+Enter');
  assert.equal(RK.normalize('Ctrl+Num5'), 'Control+num5');
});

test('rechaza aceleradores no válidos', () => {
  for (const bad of ['', 'Ctrl', 'Ctrl+Alt', 'Ctrl+Ctrl+G', 'Ctrl++', 'Foo+G', 'F25', 'Ctrl+GG', null, undefined, 5]) {
    assert.equal(RK.normalize(bad), null, String(bad));
  }
});

test('KeyboardEvent → acelerador, con la plataforma', () => {
  assert.equal(RK.fromEvent(ev('KeyG', { ctrl: true, alt: true, shift: true }), 'win32'), 'CommandOrControl+Alt+Shift+G');
  assert.equal(RK.fromEvent(ev('KeyG', { meta: true, alt: true, shift: true }), 'darwin'), 'CommandOrControl+Alt+Shift+G');
  assert.equal(RK.fromEvent(ev('KeyG', { ctrl: true }), 'darwin'), 'Control+G');
  assert.equal(RK.fromEvent(ev('KeyG', { meta: true }), 'win32'), 'Super+G');
  assert.equal(RK.fromEvent(ev('F13'), 'win32'), 'F13');
  assert.equal(RK.fromEvent(ev('Digit7', { ctrl: true }), 'linux'), 'CommandOrControl+7');
  assert.equal(RK.fromEvent(ev('ArrowUp'), 'darwin'), 'Up');
  assert.equal(RK.fromEvent(ev('Numpad3'), 'darwin'), 'num3');
});

test('solo un modificador (o una tecla desconocida) no es combinación', () => {
  assert.equal(RK.fromEvent(ev('ShiftLeft', { shift: true }), 'darwin'), null);
  assert.equal(RK.fromEvent(ev('ControlLeft', { ctrl: true }), 'win32'), null);
  assert.equal(RK.fromEvent(ev('MediaPlayPause'), 'win32'), null);
});

test('matches / actionFor comparan exactamente los modificadores', () => {
  const keys = RK.DEFAULTS;
  assert.equal(RK.actionFor(keys, ev('KeyG', { ctrl: true, alt: true, shift: true }), 'win32'), 'go');
  assert.equal(RK.actionFor(keys, ev('KeyP', { meta: true, alt: true, shift: true }), 'darwin'), 'pause');
  assert.equal(RK.actionFor(keys, ev('KeyS', { ctrl: true, alt: true, shift: true }), 'linux'), 'stop');
  assert.equal(RK.actionFor(keys, ev('KeyG', { ctrl: true, alt: true }), 'win32'), null);
  assert.equal(RK.actionFor(keys, ev('KeyG', { ctrl: true, alt: true, shift: true, meta: true }), 'win32'), null);
  assert.equal(RK.matches('f14', ev('F14'), 'win32'), true);
});

test('validate: inválidas y duplicadas', () => {
  assert.deepEqual(RK.validate(RK.DEFAULTS), { ok: true, errors: {} });
  assert.deepEqual(RK.validate({ go: 'F13', pause: 'Ctrl+Alt', stop: 'f13' }).errors, { pause: 'invalid', stop: 'duplicate' });
  assert.equal(RK.validate({ go: 'F13', pause: 'F14' }).errors.stop, 'invalid');
});

test('humanize', () => {
  assert.equal(RK.humanize('CommandOrControl+Alt+Shift+G', 'win32'), 'Ctrl + Alt + Shift + G');
  assert.equal(RK.humanize('CommandOrControl+Alt+Shift+G', 'darwin'), '⌘ + ⌥ + ⇧ + G');
  assert.equal(RK.humanize('basura', 'win32'), '');
});

test('ventanas: primero la enfocada, luego por foco más reciente, luego el resto en orden', () => {
  const t = W.createFocusTracker();
  t.note(2); t.note(3); t.note(1);
  const wins = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(W.orderTargets(wins, t), [1, 3, 2, 4, 5]);
  assert.deepEqual(W.orderTargets(wins.map(w => ({ ...w, focused: w.id === 2 })), t), [2, 1, 3, 4, 5]);
  t.forget(1);
  assert.deepEqual(W.orderTargets(wins, t), [3, 2, 1, 4, 5]);
});

test('dispatch para en la primera ventana que responde true y no falla por una que rechaza', async () => {
  const tried = [];
  const got = await W.dispatch([10, 11, 12, 13], async (id) => {
    tried.push(id);
    if (id === 10) return false;
    if (id === 11) throw new Error('cargando');
    return true;
  });
  assert.equal(got, 12);
  assert.deepEqual(tried, [10, 11, 12]);
  assert.equal(await W.dispatch([1, 2], async () => false), null);
  assert.equal(await W.dispatch([1], async () => 'true'), null);
});

test('scriptFor: solo acciones conocidas', () => {
  assert.match(W.scriptFor('go'), /window\.pwRemote\("go"\)/);
  assert.throws(() => W.scriptFor('x"); evil("'));
});
