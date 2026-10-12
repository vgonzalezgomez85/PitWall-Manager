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
// Banda del club en lo alto de una hoja Excel: logo del club a la izquierda,
// nombre justo a su derecha y, si la hoja no lleva ya el de PitWall, el de
// PitWall en la última columna (el de PitWall sale siempre). El nombre no va
// centrado: en hojas anchas el centro queda fuera de la primera página.

const fs   = require('fs');
const path = require('path');
const ClubBrand = require('../services/ClubBrand');

const BAND_PX = 44;
const LOGO_H  = 36;
const LOGO_MAX_W = 150;

function pitwallLogoId(wb) {
  if (wb._pitwallLogoId !== undefined) return wb._pitwallLogoId;
  try {
    // Versión de trazo oscuro: la banda del club va sobre fondo blanco.
    wb._pitwallLogoId = wb.addImage({ buffer: fs.readFileSync(path.join(__dirname, '../../public/img/pitwall-icon-light.png')), extension: 'png' });
  } catch { wb._pitwallLogoId = null; }
  return wb._pitwallLogoId;
}

function clubLogoId(wb) {
  if (wb._clubLogo !== undefined) return wb._clubLogo;
  const img = ClubBrand.logoImage();
  wb._clubLogo = img ? {
    id: wb.addImage({ buffer: img.buffer, extension: img.extension }),
    width: Math.min(LOGO_MAX_W, Math.round(LOGO_H * img.width / img.height)),
    height: LOGO_H,
  } : null;
  return wb._clubLogo;
}

// Ancho aproximado de una columna en píxeles (Excel: ~7 px por carácter + 5).
function colPx(ws, n) {
  const w = ws.getColumn(n).width;
  return Math.round((w || 9) * 7 + 5);
}

// Primera columna (1-based) que empieza a la derecha de `px`.
function firstColAfter(ws, px, cols) {
  let x = 0;
  for (let n = 1; n <= cols; n++) {
    if (x >= px) return n;
    x += colPx(ws, n);
  }
  return cols;
}

// Devuelve la fila añadida, o null si la marca del club está apagada.
function addClubBand(wb, ws, cols, { pitwallLogo = false } = {}) {
  const brand = ClubBrand.active();
  if (!brand) return null;
  cols = Math.max(1, cols);

  const logo = clubLogoId(wb);
  const nameCol = logo ? firstColAfter(ws, logo.width + 8, cols) : 1;

  const row = ws.addRow([]);
  row.height = BAND_PX * 0.75;
  const lastNameCol = pitwallLogo && cols > nameCol ? cols - 1 : cols;
  if (lastNameCol > nameCol) ws.mergeCells(row.number, nameCol, row.number, lastNameCol);
  const c = row.getCell(nameCol);
  c.value = brand.name || '';
  c.font = { name: 'Calibri', bold: true, size: 15, color: { argb: 'FF161B22' } };
  c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  // Anclajes enteros: con anchos de columna propios ExcelJS recoloca mal los fraccionarios.
  if (logo) {
    ws.addImage(logo.id, {
      tl: { col: 0, row: row.number - 1 },
      ext: { width: logo.width, height: logo.height },
      editAs: 'oneCell',
    });
  }
  if (pitwallLogo) {
    const id = pitwallLogoId(wb);
    if (id != null && cols > 1) {
      ws.addImage(id, {
        tl: { col: cols - 1, row: row.number - 1 },
        ext: { width: 30, height: 30 },
        editAs: 'oneCell',
      });
    }
  }
  return row;
}

module.exports = { addClubBand };
