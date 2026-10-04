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
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// En Windows, tras un alert()/confirm()/prompt() nativo la ventana se queda sin
// foco de teclado: los campos aceptan el clic pero no se puede escribir hasta
// que la ventana pierde y recupera el foco. Envolvemos los diálogos para que,
// al cerrarse, el proceso principal haga ese blur+focus.
contextBridge.exposeInMainWorld('__pitwallRefocus', () => ipcRenderer.send('pitwall:refocus'));

// Ventanas abiertas desde la app (las lista la home).
contextBridge.exposeInMainWorld('pitwallWindows', { list: () => ipcRenderer.invoke('pitwall:windows') });

// Pantalla completa de la ventana (ver main.js: sobrevive a las recargas).
contextBridge.exposeInMainWorld('pitwallWindow', {
  setFullScreen: (on) => ipcRenderer.invoke('pitwall:fullscreen', !!on),
  isFullScreen:  () => ipcRenderer.invoke('pitwall:fullscreen'),
  onFullScreenChange: (cb) => ipcRenderer.on('pitwall:fullscreen-changed', (_e, on) => cb(!!on)),
});

webFrame.executeJavaScript(`(() => {
  for (const name of ['alert', 'confirm', 'prompt']) {
    const native = window[name];
    if (typeof native !== 'function') continue;
    window[name] = function (...args) {
      try { return native.apply(window, args); }
      finally { try { window.__pitwallRefocus(); } catch {} }
    };
  }
})()`);
