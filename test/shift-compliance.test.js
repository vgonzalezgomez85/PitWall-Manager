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
// Formato de duraciones y regla de turnos. Módulos puros: sin BD ni sockets.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fmtHms, fmtHmsFijo } = require('../src/utils/duration');
const { evaluate, badgeClass } = require('../src/utils/shiftCompliance');

const MIN = 60000;
const H   = 60 * MIN;

// ── duration ──────────────────────────────────────────────────────────────

test('fmtHms separa las horas: 4 h es 4:00:00, no 240:00', () => {
  assert.equal(fmtHms(4 * H), '4:00:00');
});

test('fmtHms usa m:ss por debajo de la hora', () => {
  assert.equal(fmtHms(10 * MIN + 5000), '10:05');
  assert.equal(fmtHms(0), '0:00');
});

test('fmtHms trunca hacia abajo y no acepta negativos ni basura', () => {
  assert.equal(fmtHms(1999), '0:01');
  assert.equal(fmtHms(-5000), '0:00');
  assert.equal(fmtHms(null), '0:00');
  assert.equal(fmtHms(undefined), '0:00');
});

test('fmtHms rueda bien los minutos y segundos', () => {
  assert.equal(fmtHms(3599_000), '59:59');
  assert.equal(fmtHms(3600_000), '1:00:00');
  assert.equal(fmtHms(3661_000), '1:01:01');
  assert.equal(fmtHms(24 * H), '24:00:00');
});

test('fmtHmsFijo siempre lleva la hora', () => {
  assert.equal(fmtHmsFijo(10 * MIN + 5000), '0:10:05');
  assert.equal(fmtHmsFijo(4 * H), '4:00:00');
});

// ── shiftCompliance ───────────────────────────────────────────────────────

const REGLAS = { minMs: 1 * H, maxMs: 4 * H, maxRuns: 0, final: true };

test('un piloto dentro de los límites está ok', () => {
  const r = evaluate({ totalMs: 2 * H, runs: 3 }, REGLAS);
  assert.equal(r.status, 'ok');
  assert.equal(r.overMax, false);
  assert.equal(r.underMin, false);
});

test('alcanzar el máximo EXACTO ya es infracción (>=, no >)', () => {
  const r = evaluate({ totalMs: 4 * H, runs: 3 }, REGLAS);
  assert.equal(r.overMax, true);
  assert.equal(r.nearMax, false);   // over y near son excluyentes
  assert.equal(r.status, 'bad');
});

test('al 90% del máximo salta el aviso', () => {
  const r = evaluate({ totalMs: 3.6 * H, runs: 3 }, REGLAS);
  assert.equal(r.nearMax, true);
  assert.equal(r.status, 'warn');
});

test('pasarse de turnos decide el estado (antes se calculaba y se ignoraba)', () => {
  const r = evaluate({ totalMs: 1.5 * H, runs: 5 }, { ...REGLAS, maxRuns: 5 });
  assert.equal(r.overRuns, true);
  assert.equal(r.status, 'bad');
});

test('con maxRuns = 1 el aviso de "último turno" SÍ se dispara', () => {
  // Con `runs === maxRuns - 1` esto era imposible de ver: 0 === 0 solo antes de
  // rodar. Tiempo por encima del mínimo, para aislar la regla de turnos.
  const enElUltimo = evaluate({ totalMs: 1.5 * H, runs: 0 }, { ...REGLAS, maxRuns: 1 });
  assert.equal(enElUltimo.nearRuns, true);
  assert.equal(enElUltimo.status, 'warn');

  const pasado = evaluate({ totalMs: 1.5 * H, runs: 1 }, { ...REGLAS, maxRuns: 1 });
  assert.equal(pasado.overRuns, true);
  assert.equal(pasado.nearRuns, false);
  assert.equal(pasado.status, 'bad');
});

test('bajo mínimo SOLO se juzga con la carrera terminada', () => {
  const enVivo = evaluate({ totalMs: 10 * MIN, runs: 1 }, { ...REGLAS, final: false });
  assert.equal(enVivo.underMin, false, 'en el minuto 1 no se puede sancionar el mínimo');
  assert.equal(enVivo.status, 'info', 'en directo solo se informa de que le falta tiempo');

  const alFinal = evaluate({ totalMs: 10 * MIN, runs: 1 }, { ...REGLAS, final: true });
  assert.equal(alFinal.underMin, true);
  assert.equal(alFinal.status, 'bad');
});

test('el piloto que nunca fichó es la peor infracción, no un "ok"', () => {
  const r = evaluate({ totalMs: 0, runs: 0 }, REGLAS);
  assert.equal(r.underMin, true);
  assert.equal(r.status, 'bad');
});

test('0 significa "sin límite" en las tres reglas', () => {
  const sinLimites = { minMs: 0, maxMs: 0, maxRuns: 0, final: true };
  const r = evaluate({ totalMs: 24 * H, runs: 99 }, sinLimites);
  assert.deepEqual(r, {
    overMax: false, nearMax: false, underMin: false,
    overRuns: false, nearRuns: false, status: 'ok',
  });
});

test('un piloto que se pasa de tiempo Y de turnos sigue siendo bad', () => {
  const r = evaluate({ totalMs: 5 * H, runs: 9 }, { ...REGLAS, maxRuns: 5 });
  assert.equal(r.overMax, true);
  assert.equal(r.overRuns, true);
  assert.equal(r.status, 'bad');
});

test('la entrada sucia no revienta la regla', () => {
  const r = evaluate(null, null);
  assert.equal(r.status, 'ok');
  assert.equal(evaluate({ totalMs: NaN, runs: undefined }, REGLAS).underMin, true);
});

test('badgeClass traduce el estado al vocabulario de las vistas', () => {
  assert.equal(badgeClass('bad'),  'is-bad');
  assert.equal(badgeClass('warn'), 'is-warn');
  assert.equal(badgeClass('info'), 'is-info');
  assert.equal(badgeClass('ok'),   'is-ok');
});
