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
// Formato de duraciones LARGAS (turnos de piloto en una carrera de resistencia).
//
// El `fmtTime` que llevan las vistas es m:ss, y en una 24h eso pinta 4 horas como
// "240:00". Aquí las horas se separan de verdad.

/**
 * ms → "h:mm:ss" (o "m:ss" si no llega a la hora).
 *   14_400_000 → "4:00:00"        (no "240:00")
 *      605_000 → "10:05"
 */
function fmtHms(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return h > 0
    ? `${h}:${dosDigitos(m)}:${dosDigitos(s)}`
    : `${m}:${dosDigitos(s)}`;
}

/** ms → "h:mm:ss" siempre, con la hora incluso a cero ("0:10:05"). Para el xlsx. */
function fmtHmsFijo(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${dosDigitos(Math.floor((total % 3600) / 60))}:${dosDigitos(total % 60)}`;
}

module.exports = { fmtHms, fmtHmsFijo };
