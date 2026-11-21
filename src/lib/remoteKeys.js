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
// Control remoto (teclado de macros): aceleradores en formato Electron
// («CommandOrControl+Alt+Shift+G») ↔ teclas del navegador. Módulo PURO y
// compartido: lo cargan el servidor (validar), el navegador (/js/remote-keys-core.js
// con `window.PWRemoteKeys`) y los tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PWRemoteKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ACTIONS = ['go', 'pause', 'stop'];
  const DEFAULTS = {
    go:    'CommandOrControl+Alt+Shift+G',
    pause: 'CommandOrControl+Alt+Shift+P',
    stop:  'CommandOrControl+Alt+Shift+S',
  };

  // Orden canónico de los modificadores al escribir un acelerador.
  const MOD_ORDER = ['CommandOrControl', 'Control', 'Command', 'Alt', 'Shift', 'Super'];
  const MOD_ALIASES = {
    commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
    control: 'Control', ctrl: 'Control',
    command: 'Command', cmd: 'Command',
    alt: 'Alt', option: 'Alt',
    shift: 'Shift',
    super: 'Super', meta: 'Super',
  };

  const NAMED_KEYS = ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Enter', 'Escape',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown'];
  const KEY_ALIASES = { return: 'Enter', esc: 'Escape', del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown' };
  // KeyboardEvent.code → tecla Electron (el `code` no depende de la distribución).
  const PUNCT = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  };
  const CODE_NAMED = {
    Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
  };

  function normKey(k) {
    if (typeof k !== 'string' || !k) return null;
    if (/^[a-z]$/i.test(k)) return k.toUpperCase();
    if (/^[0-9]$/.test(k)) return k;
    let m = /^f(\d{1,2})$/i.exec(k);
    if (m) { const n = +m[1]; return n >= 1 && n <= 24 ? 'F' + n : null; }
    m = /^num([0-9])$/i.exec(k);
    if (m) return 'num' + m[1];
    const low = k.toLowerCase();
    if (['numdec', 'numadd', 'numsub', 'nummult', 'numdiv'].includes(low)) return low;
    if (KEY_ALIASES[low]) return KEY_ALIASES[low];
    const named = NAMED_KEYS.find(n => n.toLowerCase() === low);
    if (named) return named;
    if (Object.values(PUNCT).includes(k)) return k;
    return null;
  }

  // «Ctrl+alt+g» → {mods:[...], key:'G'}; null si no es un acelerador válido
  // (sin tecla final, tecla desconocida, modificador repetido…).
  function parse(accel) {
    if (typeof accel !== 'string') return null;
    const parts = accel.split('+').map(s => s.trim());
    // El «+» como tecla no se admite (Electron lo llama «Plus»): un trozo vacío es error.
    if (parts.length < 1 || parts.some(p => !p)) return null;
    const keyRaw = parts.pop();
    const mods = [];
    for (const p of parts) {
      const m = MOD_ALIASES[p.toLowerCase()];
      if (!m || mods.includes(m)) return null;
      mods.push(m);
    }
    const key = normKey(keyRaw);
    if (!key) return null;
    mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    return { mods, key };
  }

  function normalize(accel) {
    const p = parse(accel);
    return p ? p.mods.concat(p.key).join('+') : null;
  }

  function keyFromCode(code) {
    if (typeof code !== 'string') return null;
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^F(\d{1,2})$/.exec(code);
    if (m) return +m[1] >= 1 && +m[1] <= 24 ? code : null;
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return 'num' + m[1];
    if (CODE_NAMED[code]) return CODE_NAMED[code];
    if (PUNCT[code]) return PUNCT[code];
    return null;
  }

  // KeyboardEvent → acelerador, o null si solo se ha pulsado un modificador o
  // una tecla que Electron no admite. En macOS ⌘ = CommandOrControl y ⌃ =
  // Control; en el resto Ctrl = CommandOrControl y la tecla Windows = Super.
  function fromEvent(e, platform) {
    const key = keyFromCode(e && e.code);
    if (!key) return null;
    const mac = platform === 'darwin';
    const mods = [];
    if (mac) {
      if (e.metaKey) mods.push('CommandOrControl');
      if (e.ctrlKey) mods.push('Control');
    } else {
      if (e.ctrlKey) mods.push('CommandOrControl');
      if (e.metaKey) mods.push('Super');
    }
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    return mods.concat(key).join('+');
  }

  function matches(accel, e, platform) {
    const a = normalize(accel);
    return !!a && a === fromEvent(e, platform);
  }

  // Texto legible: «Ctrl + Alt + Shift + G» (en Mac, «⌘ + ⌥ + ⇧ + G»).
  function humanize(accel, platform) {
    const p = parse(accel);
    if (!p) return '';
    const mac = platform === 'darwin';
    const names = mac
      ? { CommandOrControl: '⌘', Control: '⌃', Command: '⌘', Alt: '⌥', Shift: '⇧', Super: '⌘' }
      : { CommandOrControl: 'Ctrl', Control: 'Ctrl', Command: 'Cmd', Alt: 'Alt', Shift: 'Shift', Super: 'Win' };
    const keyName = { Up: '↑', Down: '↓', Left: '←', Right: '→' }[p.key] || p.key;
    return p.mods.map(m => names[m]).concat(keyName).join(' + ');
  }

  // keys = {go, pause, stop}. errors[accion] = 'invalid' | 'duplicate'.
  function validate(keys) {
    const errors = {};
    const seen = {};
    for (const a of ACTIONS) {
      const n = normalize(keys && keys[a]);
      if (!n) { errors[a] = 'invalid'; continue; }
      if (seen[n]) { errors[a] = 'duplicate'; continue; }
      seen[n] = a;
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  function actionFor(keys, e, platform) {
    for (const a of ACTIONS) if (keys && matches(keys[a], e, platform)) return a;
    return null;
  }

  return { ACTIONS, DEFAULTS, parse, normalize, fromEvent, matches, humanize, validate, actionFor };
});
