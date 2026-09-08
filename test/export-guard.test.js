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
// ExportGuard: coordina las exportaciones a Excel con el cronometraje.
//   · begin/finish llevan la cuenta de exportaciones en curso,
//   · abortAll marca todas las activas → el siguiente tick() lanza ExportAbortedError,
//   · tick() cede el event loop y no lanza si no se ha abortado,
//   · una exportación que ya terminó (finish) no se ve afectada por abortAll.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ExportGuard = require('../src/services/ExportGuard');

test('begin/finish llevan la cuenta de exportaciones activas', () => {
  assert.equal(ExportGuard.activeCount, 0);
  const a = ExportGuard.begin();
  const b = ExportGuard.begin();
  assert.equal(ExportGuard.activeCount, 2);
  ExportGuard.finish(a);
  ExportGuard.finish(b);
  assert.equal(ExportGuard.activeCount, 0);
});

test('tick() no lanza mientras no se aborte y cede el event loop', async () => {
  const tok = ExportGuard.begin();
  let after = false;
  await ExportGuard.tick(tok);
  after = true;
  assert.equal(after, true);
  assert.equal(tok.aborted, false);
  ExportGuard.finish(tok);
});

test('abortAll marca las activas y el siguiente tick() lanza ExportAbortedError', async () => {
  const tok = ExportGuard.begin();
  ExportGuard.abortAll();
  assert.equal(tok.aborted, true);
  assert.equal(ExportGuard.activeCount, 0);
  await assert.rejects(() => ExportGuard.tick(tok), (err) => {
    assert.ok(err instanceof ExportGuard.ExportAbortedError);
    assert.equal(err.code, 'EXPORT_ABORTED');
    return true;
  });
});

test('throwIfAborted lanza en síncrono si se abortó', () => {
  const tok = ExportGuard.begin();
  assert.doesNotThrow(() => ExportGuard.throwIfAborted(tok));
  ExportGuard.abortAll();
  assert.throws(() => ExportGuard.throwIfAborted(tok), ExportGuard.ExportAbortedError);
});

test('una exportación ya finalizada no la toca abortAll', () => {
  const tok = ExportGuard.begin();
  ExportGuard.finish(tok);
  ExportGuard.abortAll();
  assert.equal(tok.aborted, false);
});

test('isMangaLive es false sin sesión de cronometraje', () => {
  // Sin manga arrancada, TimingService.isMangaLive === false.
  assert.equal(ExportGuard.isMangaLive(), false);
});
