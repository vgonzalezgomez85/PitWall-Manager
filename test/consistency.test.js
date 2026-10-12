// Métrica de consistencia (stintConsistency): banda ±1.5% sobre la mediana de
// cada manga. Estos tests fijan las decisiones del cambio v1.60.0: por manga
// (no global), robusta (una vuelta loca no hunde el %), ponderada por vueltas.
const test   = require('node:test');
const assert = require('node:assert');
const {
  stintConsistency,
  consistencyLevel,
  CONSISTENCY_WINDOW,
} = require('../src/lib/consistency');

test('un stint uniforme da 100% y nivel excelente', () => {
  const c = stintConsistency([[10000, 10000, 10000]]);
  assert.equal(c.pct, 100);
  assert.equal(c.level, 'excelente');
  assert.equal(c.n, 3);
  assert.equal(c.stints, 1);
  assert.equal(c.stdMs, 0);
  assert.equal(c.medMs, 10000);
});

test('la frontera ±1.5% es inclusiva', () => {
  const dentro = stintConsistency([[10000, 10150, 10000]]);
  assert.equal(dentro.pct, 100, '10150 = +1.5% exacto cuenta');
  const fuera = stintConsistency([[10000, 10151, 10000]]);
  assert.equal(fuera.pct, 66.7, '10151 queda fuera');
});

test('cuenta la fracción dentro de banda con 1 decimal', () => {
  // mediana 10000, umbral 150: 3 dentro, 2 fuera de 5
  const c = stintConsistency([[9800, 10000, 10000, 10000, 10200]]);
  assert.equal(c.pct, 60);
});

test('una vuelta loca resta su peso, no hunde la métrica', () => {
  const limpias = Array.from({ length: 10 }, () => 10000);
  const c = stintConsistency([[...limpias, 15000]]);
  assert.equal(c.pct, 90.9, '10 de 11 dentro; la vuelta de 15 s no toca la mediana');
});

test('POR MANGA: dos ritmos distintos no se mezclan (vs muestra global)', () => {
  const porManga = stintConsistency([
    [9000, 9000, 9000, 9000],
    [12000, 12000, 12000, 12000],
  ]);
  assert.equal(porManga.pct, 100, 'cada manga se mide contra su propia mediana');
  // La misma muestra SIN separar mangas: mediana 10500 → todo fuera de ±1.5%.
  const global = stintConsistency([[9000, 9000, 9000, 9000, 12000, 12000, 12000, 12000]]);
  assert.equal(global.pct, 0);
});

test('las mangas con menos de 3 vueltas no cuentan', () => {
  const c = stintConsistency([[10000, 10000], [10000, 10000, 10000]]);
  assert.equal(c.stints, 1);
  assert.equal(c.n, 3);
  assert.equal(c.pct, 100);
  assert.equal(stintConsistency([[10000, 10000]]), null, 'sin manga válida → null');
  assert.equal(stintConsistency([]), null);
});

test('el agregado pondera por vueltas', () => {
  // Manga A: 10 vueltas todas dentro (100%). Manga B: 3 vueltas, 1 dentro (33.3%).
  const a = Array.from({ length: 10 }, () => 10000);
  const b = [5000, 5080, 9000]; // mediana 5080, umbral 76 → solo 5080 dentro
  const c = stintConsistency([a, b]);
  assert.equal(c.n, 13);
  assert.equal(c.pct, 84.6, '(10 + 1) / 13');
});

test('stdMs es la σ* robusta por manga ponderada por vueltas', () => {
  // mediana 10050, desviaciones 50 → MAD 50 → σ* = 74.13 → 74
  const c = stintConsistency([[10000, 10100, 10000, 10100]]);
  assert.equal(c.stdMs, 74);
});

test('consistencyLevel: cortes 90 / 75 / 60', () => {
  assert.equal(consistencyLevel(96.4), 'excelente');
  assert.equal(consistencyLevel(90), 'excelente');
  assert.equal(consistencyLevel(89.9), 'buena');
  assert.equal(consistencyLevel(75), 'buena');
  assert.equal(consistencyLevel(74.9), 'irregular');
  assert.equal(consistencyLevel(60), 'irregular');
  assert.equal(consistencyLevel(59.9), 'erratica');
  assert.equal(consistencyLevel(null), null);
});

test('la ventana por defecto es ±1.5%', () => {
  assert.equal(CONSISTENCY_WINDOW, 0.015);
});
