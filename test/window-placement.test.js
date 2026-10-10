const test = require('node:test');
const assert = require('node:assert/strict');
const wp = require('../electron/windowPlacement');

const laptop  = { id: 11, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const tvRight = { id: 7,  bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
const left    = { id: 99, bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, workArea: { x: -1280, y: 0, width: 1280, height: 1024 } };

test('clasifica las cinco vistas por su ruta', () => {
  assert.equal(wp.classify('http://127.0.0.1:3000/training'), 'training');
  assert.equal(wp.classify('/training/free'), 'training');
  assert.equal(wp.classify('/training/live?x=1'), 'training');
  assert.equal(wp.classify('/races/68/mangas/412/live'), 'live');
  assert.equal(wp.classify('/races/68/mangas/412/tv/'), 'tv');
  assert.equal(wp.classify('/races/68/pole/timing'), 'pole');
  assert.equal(wp.classify('/races/68/lemans'), 'lemans');
});

test('lo demás no tiene regla', () => {
  for (const u of ['/', '/settings', '/training/competition/live', '/races/68/mangas/412/corrections', '/races/68/live-stats', 'nada::']) {
    assert.equal(wp.classify(u), null, u);
  }
});

test('la principal es la 1 y el resto va de izquierda a derecha', () => {
  const o = wp.orderDisplays([tvRight, laptop, left], 11);
  assert.deepEqual(o.map(d => d.id), [11, 99, 7]);
});

test('sanitize descarta valores raros y solo el entreno tiene autostart', () => {
  const p = wp.sanitize({ live: { display: 2, mode: 'fullscreen', autostart: true }, tv: { display: -1, mode: 'kiosk' }, training: { display: '2', autostart: 'yes' } });
  assert.deepEqual(p.live, { display: 2, mode: 'fullscreen' });
  assert.deepEqual(p.tv, { display: 0, mode: 'normal' });
  assert.deepEqual(p.training, { display: 0, mode: 'normal', autostart: false });
  assert.deepEqual(wp.sanitize(null).pole, { display: 0, mode: 'normal' });
});

test('sin pantalla asignada la ventana se abre como siempre', () => {
  assert.equal(wp.resolve({ live: { display: 0, mode: 'fullscreen' } }, 'live', [laptop, tvRight], 11), null);
  assert.equal(wp.resolve({}, 'tv', [laptop, tvRight], 11), null);
});

test('va centrada en la pantalla asignada con su modo', () => {
  const r = wp.resolve({ tv: { display: 2, mode: 'fullscreen' } }, 'tv', [laptop, tvRight], 11);
  assert.equal(r.mode, 'fullscreen');
  assert.equal(r.fallback, false);
  assert.deepEqual(r.bounds, { x: 1440 + 320, y: 110, width: 1280, height: 860 });
});

test('si la pantalla no está, cae a la principal y en ventana normal', () => {
  const r = wp.resolve({ tv: { display: 3, mode: 'fullscreen' } }, 'tv', [laptop, tvRight], 11);
  assert.equal(r.fallback, true);
  assert.equal(r.mode, 'normal');
  assert.ok(r.bounds.x >= 0 && r.bounds.x + r.bounds.width <= 1440);
});

test('la ventana nunca es más grande que el área útil', () => {
  const small = { id: 1, bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 0, width: 1024, height: 728 } };
  const r = wp.resolve({ live: { display: 1, mode: 'normal' } }, 'live', [small], 1);
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 1024, height: 728 });
});
