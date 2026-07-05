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
// Codec del protocolo Infolap (Tic Tac Slot legacy).
//
// Estructura del paquete de estado de 52 bytes (1 carril por paquete):
//
//   0..3   seq          "0010".."9990" +10 por paquete (wrap cuando alcanza 9990)
//   4      lane         "1".."9" (carril del paquete)
//   5..24  name         20 chars space-padded right (latin1)
//   25..29 (5 spaces)
//   30..36 timeField    7 chars XOR-codificados sobre TEMPLATE "7654321".
//                       Centinela "EF54AB1" = sin vuelta válida todavía.
//   37     flag F/space alterna entre paquetes; "F" o " ". Sin info temporal.
//   38..39 (2 spaces)
//   40..43 "0000"       constante
//   44     status       "1" = primer reporte de ese carril en la manga,
//                       "X" = reporte normal posterior.
//   45..47 laneCode     "001".."009" carril zero-padded
//   48..50 mangaNum     "001".."999" número de manga (legacy 1-indexed)
//   51     "P"          terminador
//
// Verificado contra capturas reales (infolap_capture[2-4].pcapng):
// el encoder produce bytes idénticos al PC Tic Tac Slot original.

const TEMPLATE         = '7654321';
const NO_LAP_SENTINEL  = 'EF54AB1';

function hexNibble(ch) {
  const n = parseInt(ch, 16);
  return Number.isNaN(n) ? null : n;
}

// ── Decoder (lap_time_ms o null si centinela / inválido) ────────────────────
function decodeLapField(field) {
  if (!field || field.length < 7) return null;
  const f = field.slice(0, 7);
  if (f === NO_LAP_SENTINEL) return null;
  const digits = new Array(7);
  for (let i = 0; i < 7; i++) {
    const e = hexNibble(f[i]);
    const t = hexNibble(TEMPLATE[i]);
    if (e === null) return null;
    digits[i] = e ^ t;
  }
  for (let i = 0; i < 6; i++) {
    if (digits[i] > 9) return null;
  }
  const ms = digits[4] * 100000 + digits[1] * 10000 + digits[5] * 1000
          + digits[0] * 100    + digits[3] * 10    + digits[2];
  return ms;
}

// ── Encoder (lap_time_ms → 7-char field) ───────────────────────────────────
//
// Reparte cada componente del tiempo (centenas, decenas, unidades, décimas,
// centésimas, milésimas) según las posiciones del template y XOR con el
// dígito hex del template. El char en pos 6 (state interno) lo dejamos como
// "1" — es lo que aparece en TODAS las muestras capturadas con tiempo real
// y la app Android lo ignora.
function encodeLapField(lapMs, statePos6 = '1') {
  if (lapMs == null || !Number.isFinite(lapMs) || lapMs < 0) return NO_LAP_SENTINEL;
  const ms = Math.round(lapMs);

  const hundreds   = Math.floor(ms / 100000) % 10;
  const tens       = Math.floor(ms /  10000) % 10;
  const units      = Math.floor(ms /   1000) % 10;
  const tenths     = Math.floor(ms /    100) % 10;
  const hundredths = Math.floor(ms /     10) % 10;
  const milesims   =             ms          % 10;

  const digits = [tenths, tens, milesims, hundredths, hundreds, units, hexNibble(statePos6) ?? 1];
  let out = '';
  for (let i = 0; i < 7; i++) {
    const t = hexNibble(TEMPLATE[i]);
    out += (digits[i] ^ t).toString(16).toUpperCase();
  }
  return out;
}

// ── Paquete de 52 bytes completo ───────────────────────────────────────────
function buildPacket({
  seq,                  // 1..999 (la app espera "0010"..."9990", se multiplica ×10)
  lane,                 // 1..9
  name,                 // string (se trunca a 20 y se rellena con espacios)
  lapMs        = null,  // null → centinela "EF54AB1"
  firstReport  = false, // true → flag "1", false → "X"
  mangaNum     = 1,     // 1..999 → "001".."999"
  altFlag      = ' ',   // F/space en pos 37 (alterna entre paquetes consecutivos)
}) {
  const seqStr = String((seq * 10) % 10000).padStart(4, '0');
  const laneCh = String(lane);
  const nameField = (name || '').slice(0, 20).padEnd(20, ' ');
  const timeField = encodeLapField(lapMs);
  const flag      = firstReport ? '1' : 'X';
  const laneCode  = String(lane).padStart(3, '0');
  const mangaStr  = String(mangaNum).padStart(3, '0');

  const ascii =
    seqStr +                  // 0..3
    laneCh +                  // 4
    nameField +               // 5..24
    '     ' +                 // 25..29
    timeField +               // 30..36
    (altFlag || ' ') +        // 37
    '  ' +                    // 38..39
    '0000' +                  // 40..43
    flag +                    // 44
    laneCode +                // 45..47
    mangaStr +                // 48..50
    'P';                      // 51

  if (ascii.length !== 52) {
    throw new Error(`Infolap packet must be 52 chars, got ${ascii.length}: "${ascii}"`);
  }
  return Buffer.from(ascii, 'latin1');
}

// Respuesta de discovery: "OK <name>;#<id><name>;#<id>..."
function buildDiscoveryResponse(entries) {
  // entries: [{ name: 'Piloto 1', id: '001' }, ...]
  let s = 'OK ';
  for (const e of entries) {
    s += `${e.name};#${e.id}`;
  }
  return Buffer.from(s, 'latin1');
}

// Probe del cliente: "InfoLap:CXXX" (12 bytes) donde XXX = último octeto IP.
function isDiscoveryProbe(buf) {
  return buf.length === 12 && buf.slice(0, 9).toString('latin1') === 'InfoLap:C';
}

module.exports = {
  TEMPLATE,
  NO_LAP_SENTINEL,
  decodeLapField,
  encodeLapField,
  buildPacket,
  buildDiscoveryResponse,
  isDiscoveryProbe,
};
