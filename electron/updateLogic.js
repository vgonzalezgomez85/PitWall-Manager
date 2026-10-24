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
// Parte pura del actualizador (sin Electron), para poder probarla.
const semver = require('semver');

// electron-updater solo sabe instalar el instalador de Windows (NSIS), el .app
// firmado de Mac y el AppImage. El portable de Windows y el .deb se actualizan
// a mano desde la web.
function updateMode({ packaged, platform, env = {} }) {
  if (!packaged) return 'manual';
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_DIR) return 'manual';
  if (platform === 'linux' && !env.APPIMAGE) return 'manual';
  return 'auto';
}

function channelFile(platform) {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux')  return 'latest-linux.yml';
  return 'latest.yml';
}

function isNewer(remote, current) {
  const r = semver.valid(semver.coerce(remote));
  const c = semver.valid(semver.coerce(current));
  return !!(r && c && semver.gt(r, c));
}

const PAGES = { es: 'pitwall-manager.html', en: 'pitwall-manager-en.html', fr: 'pitwall-manager-fr.html', it: 'pitwall-manager-it.html' };
function downloadPage(lang) {
  return 'https://www.pitwall.es/' + (PAGES[lang] || PAGES.es);
}

module.exports = { updateMode, channelFile, isNewer, downloadPage };
