'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRaceHighlights } = require('../src/lib/raceHighlights');

const lane = (l, avgClean, cleanLaps = 10) => ({ lane: l, avgClean, cleanLaps });

function laps(key, mangaId, tanda, manga, laneNo, pattern) {
  // pattern: 'o' vuelta limpia, 'x' salida, 'p' pit-stop
  return [...pattern].map(c => ({
    key, mangaId, tanda, manga, lane: laneNo,
    isExit: c === 'x' || c === 'p', isPitStop: c === 'p',
  }));
}

const entities = [
  { key: 'A', name: 'Ana',   consistency: 95.2, consistencyStdMs: 80, exitCount: 1, perLane: [lane(1, 9600), lane(2, 9700)] },
  { key: 'B', name: 'Bruno', consistency: 97.0, consistencyStdMs: 90, exitCount: 0, perLane: [lane(1, 9650), lane(2, 9500)] },
  { key: 'C', name: 'Carla', consistency: 97.0, consistencyStdMs: 70, exitCount: 0, perLane: [lane(1, 9400, 3), lane(2, 9800)] },
];

test('más regular: mayor %; a igual %, menor desviación', () => {
  const h = buildRaceHighlights({ entities });
  assert.equal(h.mostConsistent.name, 'Carla');
});

test('más rápido por pista: mejor media limpia con un mínimo de vueltas', () => {
  const h = buildRaceHighlights({ entities });
  assert.deepEqual(h.laneKings.map(k => [k.lane, k.name]), [[1, 'Ana'], [2, 'Bruno']]);
});

test('mejor manga: más vueltas en una manga; empate → mejor clasificado', () => {
  const h = buildRaceHighlights({
    entities,
    laps: [...laps('B', 10, 1, 1, 1, 'oooo'), ...laps('A', 11, 2, 3, 2, 'oooo'), ...laps('C', 12, 1, 2, 2, 'ooo')],
    multiTanda: true,
  });
  assert.equal(h.bestManga.name, 'Ana');
  assert.equal(h.bestManga.laps, 4);
  assert.equal(h.bestManga.tanda, 2);
  assert.equal(h.bestManga.manga, 3);
  assert.equal(h.bestManga.multiTanda, true);
});

test('racha sin salidas: la salida la corta, el pit-stop ni suma ni corta', () => {
  const h = buildRaceHighlights({
    entities,
    laps: [...laps('A', 1, 1, 1, 1, 'oooxoo'), ...laps('B', 2, 1, 1, 2, 'oopoo'), ...laps('C', 3, 1, 1, 3, 'ooo')],
  });
  assert.equal(h.longestStreak.name, 'Bruno');
  assert.equal(h.longestStreak.laps, 4);
});

test('menos salidas: lista los empatados y cuenta el resto', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ key: 'k' + i, name: 'P' + i, exitCount: 0, perLane: [] }));
  const h = buildRaceHighlights({ entities: many });
  assert.equal(h.fewestExits.count, 0);
  assert.deepEqual(h.fewestExits.names, ['P0', 'P1', 'P2']);
  assert.equal(h.fewestExits.more, 2);
});

test('remontada desde la pole: mayor ganancia de puestos; sin pole no sale', () => {
  const pole = [{ name: 'Carla', pos: 1 }, { name: 'Bruno', pos: 2 }, { name: 'Ana', pos: 3 }];
  const h = buildRaceHighlights({ entities, pole });
  assert.deepEqual([h.poleGain.name, h.poleGain.from, h.poleGain.to], ['Ana', 3, 1]);
  assert.equal(buildRaceHighlights({ entities }).poleGain, null);
});

test('sin datos no hay destacados', () => {
  assert.equal(buildRaceHighlights({}), null);
});
