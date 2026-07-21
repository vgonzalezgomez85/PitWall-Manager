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
/* ════════════════════════════════════════════════════════════════════════
   VISOR DE TRAMAS EN VIVO (/diagnostico/tramas)
   ────────────────────────────────────────────────────────────────────────
   El servidor manda lotes cada ~120 ms por `diag:frames`, y el payload es
   SIEMPRE un array (historial al hacer join + lotes en vivo).

   Tres cosas que aquí importan y por eso están hechas así:

    1. GATE. Sin `diag:frames:join` el servidor ni siquiera decodifica. Se
       emite al conectar y se suelta al cerrar la página.
    2. NO SE REPINTA LA LISTA. Cada lote solo INSERTA nodos nuevos (en un
       DocumentFragment) por arriba y poda por abajo. Con ráfagas del DS,
       repintar entero mata la pestaña.
    3. FILTROS EN CSS. Cada fila lleva data-kind; ocultar latidos o dejar
       solo cruces es una clase en el contenedor, no un re-render.
   ════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const list = document.getElementById('framesList');
  if (!list) return;

  const empty       = document.getElementById('framesEmpty');
  const btnPause    = document.getElementById('btnPause');
  const btnPauseTxt = document.getElementById('btnPauseTxt');
  const btnClear    = document.getElementById('btnClear');
  const chkHideHb   = document.getElementById('chkHideHb');
  const chkOnlyX    = document.getElementById('chkOnlyCross');
  const statTotal   = document.getElementById('statTotal');
  const statRate    = document.getElementById('statRate');
  const statPaused  = document.getElementById('statPaused');
  const statBuf     = document.getElementById('statBuffered');

  const MAX_ROWS   = 500;    // tope de filas en el DOM
  const MAX_BUFFER = 2000;   // tope de lo acumulado en pausa
  const RATE_WIN   = 5000;   // ventana móvil para las tramas/s

  let paused  = false;
  let buffer  = [];   // tramas retenidas mientras está en pausa
  let total   = 0;
  let stamps  = [];   // marcas de llegada para el ritmo
  let rows    = 0;    // filas de primer nivel en el DOM (las subs no cuentan)

  // ── Utilidades ────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');

  // HH:MM:SS.mmm a partir del ts float en ms epoch.
  function hora(ts) {
    if (!ts) return '--:--:--.---';
    const d = new Date(ts);
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
         + '.' + p3(d.getMilliseconds());
  }

  // Tipo de trama → clase de color. El default deja la fila neutra.
  const KIND_CLASS = {
    crossing:          'is-crossing',
    go:                'is-go',
    started:           'is-go',
    resumed:           'is-go',
    resume_signal:     'is-go',
    semaphore:         'is-warn',
    burst:             'is-warn',
    finished:          'is-end',
    stopped:           'is-end',
    paused:            'is-end',
    heartbeat:         'is-faint',
    crossing_filtered: 'is-drop',
    truncated:         'is-drop',
    short:             'is-drop',
    ignored:           'is-drop',
    error:             'is-bad',
  };

  // Hex con los bytes no interpretados atenuados. `unknown` son ÍNDICES.
  function hexHtml(hex, unknown) {
    if (!hex) return '';
    const desc  = new Set(Array.isArray(unknown) ? unknown : []);
    const bytes = String(hex).trim().split(/\s+/);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += '<span class="vt-hb' + (desc.has(i) ? ' is-unknown' : '') + '"'
           + ' title="byte ' + i + '">' + esc(bytes[i]) + '</span> ';
    }
    return out;
  }

  // Construye la fila de una trama. `parent` aporta ts/circuito a las subs,
  // que pueden venir sin ellos.
  function buildRow(f, parent) {
    const ts      = f.ts != null ? f.ts : (parent && parent.ts);
    const circuit = f.circuit != null ? f.circuit : (parent && parent.circuit);
    const source  = f.source || (parent && parent.source);
    const kind    = f.kind || 'unknown';

    const row = document.createElement('div');
    row.className = 'vt-frame ' + (KIND_CLASS[kind] || '') + (parent ? ' vt-frame--sub' : '');
    row.dataset.kind = kind;

    let html = '<div class="vt-frame__head">'
      + '<span class="vt-frame__time">' + esc(hora(ts)) + '</span>'
      + (circuit != null ? '<span class="vt-frame__circ">C' + esc(circuit) + '</span>' : '')
      + (source === 'bart' ? '<span class="vt-frame__src">BART</span>' : '')
      + (f.badge ? '<span class="vt-frame__badge">' + esc(f.badge) + '</span>' : '')
      + '<span class="vt-frame__label">' + esc(f.label || kind) + '</span>';

    if (Array.isArray(f.fields) && f.fields.length) {
      html += '<span class="vt-frame__fields">';
      for (const fld of f.fields) {
        html += '<span class="vt-frame__f">' + esc(fld.k) + ' <b>' + esc(fld.v) + '</b></span>';
      }
      html += '</span>';
    }
    html += '</div>';

    if (f.hex) html += '<div class="vt-frame__hex">' + hexHtml(f.hex, f.unknown) + '</div>';
    row.innerHTML = html;

    // Burst = retransmisión del PL2303: las sub-tramas cuelgan del padre.
    if (kind === 'burst' && Array.isArray(f.subs) && f.subs.length) {
      const box = document.createElement('div');
      box.className = 'vt-frame__subs';
      for (const s of f.subs) box.appendChild(buildRow(s, f));
      row.appendChild(box);
    }
    return row;
  }

  // Inserta un lote: la más reciente arriba, y poda las viejas por el final.
  function paint(batch) {
    if (!batch.length) return;
    if (empty && !empty.hidden) empty.hidden = true;

    const frag = document.createDocumentFragment();
    for (let i = batch.length - 1; i >= 0; i--) frag.appendChild(buildRow(batch[i], null));
    list.insertBefore(frag, list.firstChild);
    rows += batch.length;

    // Poda por el final. Solo filas de primer nivel: las subs de un burst se
    // van con su padre.
    while (rows > MAX_ROWS) {
      // El nodo de "esperando tramas" vive dentro de la lista y se queda.
      let last = list.lastElementChild;
      if (last === empty) last = empty.previousElementSibling;
      if (!last) break;
      list.removeChild(last);
      rows--;
    }
  }

  // ── Contadores ────────────────────────────────────────────────────────
  function refreshStats() {
    const cut = Date.now() - RATE_WIN;
    while (stamps.length && stamps[0] < cut) stamps.shift();
    statTotal.textContent = total;
    statRate.textContent  = (stamps.length / (RATE_WIN / 1000)).toFixed(1).replace('.', ',');
    if (statBuf) statBuf.textContent = buffer.length;
  }
  setInterval(refreshStats, 500);

  // ── Socket ────────────────────────────────────────────────────────────
  const socket = io();

  socket.on('connect', () => socket.emit('diag:frames:join'));

  socket.on('diag:frames', (batch) => {
    if (!Array.isArray(batch) || !batch.length) return;
    total += batch.length;
    const now = Date.now();
    for (let i = 0; i < batch.length; i++) stamps.push(now);

    if (paused) {
      // En pausa se acumula, pero con tope: un visor no es un log infinito.
      buffer = buffer.concat(batch);
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      refreshStats();
      return;
    }
    paint(batch);
    refreshStats();   // el intervalo es el respaldo; aquí evita medio segundo a 0
  });

  // Soltar el gate al cerrar: si no queda nadie mirando, el servidor deja de
  // decodificar.
  window.addEventListener('beforeunload', () => {
    try { socket.emit('diag:frames:leave'); } catch (e) {}
  });

  // ── Controles ─────────────────────────────────────────────────────────
  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPauseTxt.textContent = paused ? 'Reanudar' : 'Pausar';
    list.classList.toggle('is-paused', paused);
    if (statPaused) statPaused.hidden = !paused;
    if (!paused && buffer.length) {   // al reanudar se suelta lo acumulado
      const pend = buffer;
      buffer = [];
      paint(pend);
    }
    refreshStats();
  });

  btnClear.addEventListener('click', () => {
    list.querySelectorAll('.vt-frame').forEach((n) => { if (n.parentNode === list) list.removeChild(n); });
    buffer = [];
    total  = 0;
    rows   = 0;
    stamps = [];
    if (empty) empty.hidden = false;
    refreshStats();
  });

  // Los filtros son clases sobre el contenedor: cambiarlos no repinta nada.
  chkHideHb.addEventListener('change', () => list.classList.toggle('hide-hb', chkHideHb.checked));
  chkOnlyX.addEventListener('change', () => list.classList.toggle('only-cross', chkOnlyX.checked));
})();
