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
// Historial de versiones: parsea CHANGELOG.md (la "memoria" de cambios del
// repo) y lo muestra en /changelog. La versión actual sale de package.json
// (app.locals.appVersion) y el pie de todas las páginas enlaza aquí.

const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '../../CHANGELOG.md');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// **negrita** y `código` → HTML (sobre texto ya escapado).
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Parsea el markdown del changelog a una estructura sencilla:
// [{ version, fecha, notas: [html], secciones: [{ titulo, items: [html] }] }]
function parse(md) {
  const versiones = [];
  let v = null, sec = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^##\s+\[([^\]]+)\]\s*(?:—|-)?\s*(.*)$/.exec(line))) {
      v = { version: m[1], fecha: m[2].trim(), notas: [], secciones: [] };
      sec = null;
      versiones.push(v);
    } else if (v && (m = /^###\s+(.+)$/.exec(line))) {
      sec = { titulo: m[1].trim(), items: [] };
      v.secciones.push(sec);
    } else if (v && (m = /^-\s+(.+)$/.exec(line))) {
      (sec ? sec.items : v.notas).push(inline(m[1]));
    } else if (v && !sec && line && !line.startsWith('#') && line !== '---') {
      v.notas.push(inline(line));
    }
  }
  return versiones;
}

const ChangelogController = {
  page(req, res) {
    let versiones = [];
    try {
      versiones = parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
    } catch { /* sin fichero → página vacía con la versión actual */ }
    res.render('changelog', { t: req.t, versiones });
  },
};

module.exports = ChangelogController;
