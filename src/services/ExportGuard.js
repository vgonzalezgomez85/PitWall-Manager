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
'use strict';

// Coordina las exportaciones a Excel con el cronometraje.
//
// Generar un .xlsx de resultados es la operación bloqueante más pesada de la
// app: en una carrera larga son decenas de miles de filas con estilo por celda
// más la compresión del ZIP, del orden de segundos en el hilo principal. Si eso
// ocurre mientras una manga está viva, puede partir una trama del DS-300
// (FRAME_GAP_MS = 75 ms) y perder un cruce real.
//
// Dos reglas:
//   1. No se puede EMPEZAR una exportación con una manga viva (corriendo o en
//      pausa). Los endpoints consultan `isMangaLive()` y responden 409.
//   2. Si una manga ARRANCA mientras hay exportaciones en curso (p. ej. se
//      lanzó entre mangas y llega el GO), se abortan: `abortAll()` lo llama el
//      arranque de manga y la señal de GO del DS-300. Los bucles de construcción
//      del libro pasan por `tick()` / `throwIfAborted()` y cortan en cuanto se
//      marca el aborto, dejando el event loop libre para las tramas.

class ExportAbortedError extends Error {
  constructor() {
    super('export_aborted_heat_started');
    this.name = 'ExportAbortedError';
    this.code = 'EXPORT_ABORTED';
  }
}

const _active = new Set();

const ExportGuard = {
  ExportAbortedError,

  // ¿Hay una manga viva ahora mismo? (algún circuito corriendo o en pausa).
  // NO cuenta la manga solo armada esperando el GO ni el límite de tanda: en
  // esos estados no entran tramas, y si llega el GO el aborto lo cubre.
  isMangaLive() {
    try { return require('./TimingService').isMangaLive; }
    catch { return false; }
  },

  // Registra una exportación en curso. Devuelve un token para los checkpoints.
  begin() {
    const token = { aborted: false, startedAt: Date.now() };
    _active.add(token);
    return token;
  },

  finish(token) { _active.delete(token); },

  // Checkpoint cooperativo: cede el event loop y lanza si se abortó la
  // exportación. Llamar cada N filas dentro de los bucles pesados.
  async tick(token) {
    if (token && token.aborted) throw new ExportAbortedError();
    await new Promise((r) => setImmediate(r));
    if (token && token.aborted) throw new ExportAbortedError();
  },

  // Comprobación síncrona sin ceder (para justo antes de una operación larga).
  throwIfAborted(token) {
    if (token && token.aborted) throw new ExportAbortedError();
  },

  // Aborta todas las exportaciones en curso. Lo llaman el arranque de manga
  // (TimingService.startManga) y la señal de GO del DS-300 (app.js).
  abortAll() {
    if (_active.size === 0) return;
    console.log(`[ExportGuard] manga arrancando → abortando ${_active.size} exportación(es) a Excel en curso`);
    for (const t of _active) t.aborted = true;
    _active.clear();
  },

  get activeCount() { return _active.size; },

  // Respuesta 409 estándar para un endpoint de exportación bloqueado.
  deny(req, res) {
    const isEs = ((req.query && req.query.lang) || 'es') === 'es';
    const message = isEs
      ? 'No se puede exportar a Excel mientras hay una manga en curso. Detén la manga o espera a que termine la carrera y vuelve a intentarlo.'
      : 'Cannot export to Excel while a heat is running. Stop the heat or wait until the race finishes, then try again.';
    if (res.headersSent) return;
    res.status(409).render('error', { t: req.t, code: 409, message });
  },
};

module.exports = ExportGuard;
