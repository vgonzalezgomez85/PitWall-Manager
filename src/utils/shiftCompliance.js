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
// Reglas de turnos de piloto: tiempo mínimo, tiempo máximo y número de turnos.
//
// Estaba triplicada en las vistas (shifts-live.ejs ×2, race-shifts.ejs) y las
// tres copias divergían. Aquí queda una sola, pura y testeable. Las reglas SOLO
// AVISAN: no bloquean el fichaje. Quien sanciona es el informe final.
//
// Convenio: 0 = sin límite, en las tres reglas.

const UMBRAL_CERCA = 0.9;   // 90% del máximo ya enciende el aviso

/**
 * @param {{totalMs:number, runs:number}} piloto  Acumulado del piloto en la carrera.
 *        `runs` son turnos RODADOS (runs_count), no filas de driver_shifts:
 *        los pre-armes que nunca arrancaron no cuentan contra el máximo.
 * @param {{minMs:number, maxMs:number, maxRuns:number, final:boolean}} reglas
 *        `final` = la carrera ha terminado. Sin él no se puede juzgar el mínimo:
 *        en el minuto 1 todo el mundo va "bajo mínimo" y el aviso es ruido.
 * @returns {{overMax:boolean, nearMax:boolean, underMin:boolean,
 *            overRuns:boolean, nearRuns:boolean, status:'ok'|'warn'|'bad'|'info'}}
 */
function evaluate(piloto, reglas) {
  const totalMs = Math.max(0, Number(piloto && piloto.totalMs) || 0);
  const runs    = Math.max(0, Number(piloto && piloto.runs)    || 0);
  const minMs   = Math.max(0, Number(reglas && reglas.minMs)   || 0);
  const maxMs   = Math.max(0, Number(reglas && reglas.maxMs)   || 0);
  const maxRuns = Math.max(0, Number(reglas && reglas.maxRuns) || 0);
  const final   = !!(reglas && reglas.final);

  const overMax  = maxMs > 0 && totalMs >= maxMs;
  const nearMax  = maxMs > 0 && !overMax && totalMs >= maxMs * UMBRAL_CERCA;
  const overRuns = maxRuns > 0 && runs >= maxRuns;
  // `>=` y no `=== maxRuns - 1`: con maxRuns = 1 aquel nunca se disparaba.
  const nearRuns = maxRuns > 0 && !overRuns && runs >= maxRuns - 1;
  // El mínimo solo es infracción con la carrera acabada.
  const underMin = final && minMs > 0 && totalMs < minMs;

  let status = 'ok';
  if (overMax || overRuns)      status = 'bad';    // infracción consumada
  else if (underMin)            status = 'bad';    // no rodó lo obligatorio
  else if (nearMax || nearRuns) status = 'warn';   // al borde
  else if (!final && minMs > 0 && totalMs < minMs) status = 'info';   // aún le falta, en directo

  return { overMax, nearMax, underMin, overRuns, nearRuns, status };
}

/** Clase CSS del badge para el estado (mismo vocabulario que las vistas). */
function badgeClass(status) {
  return status === 'bad'  ? 'is-bad'
       : status === 'warn' ? 'is-warn'
       : status === 'info' ? 'is-info'
       : 'is-ok';
}

module.exports = { evaluate, badgeClass, UMBRAL_CERCA };
