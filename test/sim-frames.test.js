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
// Lector de ficheros de tramas de la carrera simulada (dsFrames).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dsFrames = require('../src/lib/dsFrames');
const { sellar } = require('./helpers/dsFrame');

const hex = b => sellar(b).map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const base = (b7, b8, b9 = 0, b10 = 0) => [0xE0, 0x10, 0x15, 0x03, 0x00, 0x04, 0x4C, b7, b8, b9, b10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xEB];
const GO5  = hex(base(0x3E, 0xA1, 0x00, 0x05));   // GO de 5 min (clase 0x3E: [10]=MM)
const GO10 = hex(base(0x3E, 0xA1, 0x00, 0x10));
const FIN  = hex(base(0x00, 0xA4));
const STOP = hex(base(0x00, 0xA7));
const cruce = () => { const b = base(0x1B, 0x00, 0x00, 0x80); b[12] = 1; b[14] = 0; b[15] = 0x12; b[16] = 0x50; b[17] = 0; return hex(b); };

test('TXT de TicTacSlot sin columna de caja: todo es DS1', () => {
  const p = dsFrames.parse(['12:00:00.000    ' + GO5, '12:00:10.000    ' + cruce(), '12:05:00.000    ' + FIN].join('\r\n'));
  assert.equal(p.frames.length, 3);
  assert.deepEqual(p.gos, [43200000]);
  assert.equal(p.analysis.crossings, 1);
  assert.equal(p.analysis.durationMin, 5);
});

test('un GO sin trama de fin antes del siguiente es una salida abortada, no una manga', () => {
  const p = dsFrames.parse([
    '12:00:00.000    DS1  ' + GO10,               // salida en falso, otra duración
    '12:00:30.000    DS1  ' + STOP,
    '12:01:00.000    DS1  ' + GO5,
    '12:01:10.000    DS1  ' + cruce(),
    '12:06:00.000    DS1  ' + FIN,
    '12:10:00.000    DS1  ' + GO5,                // el registro acaba a mitad de manga
    '12:10:10.000    DS1  ' + cruce(),
  ].join('\n'));
  assert.deepEqual(p.gos, [43260000, 43800000]);
  assert.equal(p.analysis.mangas, 2);
  assert.equal(p.analysis.durationMin, 5);
});
