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
// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMs(ms) {
  if (ms == null) return '—';
  const totalSec = Math.floor(ms / 1000);
  const millis   = ms % 1000;
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  return `${mins > 0 ? mins + ':' : ''}${String(secs).padStart(mins > 0 ? 2 : 1, '0')}.${String(millis).padStart(3, '0')}`;
}

function formatRemaining(ms) {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Countdown ─────────────────────────────────────────────────────────────────
let remainingMs = TV_DATA.durationMs;
let lastTickAt  = null;
let timerInt    = null;
const timerEl   = document.getElementById('tvTimer');

function startCountdown(remaining) {
  remainingMs = remaining;
  lastTickAt  = Date.now();
  if (timerInt) clearInterval(timerInt);
  timerInt = setInterval(() => {
    const now     = Date.now();
    remainingMs   = Math.max(0, remainingMs - (now - lastTickAt));
    lastTickAt    = now;
    timerEl.textContent = formatRemaining(remainingMs);
    if (remainingMs <= 0) { clearInterval(timerInt); timerInt = null; }
  }, 250);
}

// ── Previous-manga lap totals ─────────────────────────────────────────────────
const prevLapCountMap = {};
TV_DATA.lanes.forEach(l => { prevLapCountMap[l.lane] = l.prevLapCount || 0; });
function getTotalLaps(lane, lapCount) { return (prevLapCountMap[lane] || 0) + lapCount; }

// ── Standings render ──────────────────────────────────────────────────────────
const tbody    = document.getElementById('tvBody');
const tickerEl = document.getElementById('tvTicker');
const MAX_TICKS = 8;
let   recentTicks = [];

function posClass(pos) { return ['p1','p2','p3'][pos - 1] || 'pn'; }

// Color determinista por categoría (mismo string → mismo color, sin
// coordinación entre ventanas): así el directo y el resto de paneles pintan
// la categoría del mismo color aunque sean páginas distintas. Paleta FIJA
// (no hue continuo): dos categorías de la MISMA carrera (p.ej. "C1"/"C2")
// necesitan verse claramente distintas, y un hash sobre un círculo de tonos
// continuo puede acercarlas por casualidad (visto con C1/C2). Con una
// paleta corta y curada, cualquier carrera con un puñado de categorías
// (lo habitual) sale con colores nítidamente diferentes.
const CAT_PALETTE = ['#58a6ff','#f6c90e','#3fb950','#ff6b9d','#ff9800','#ba68c8','#00bcd4','#e63946','#8bc34a','#ce93d8','#4dd0e1','#ffab40'];
function catColor(cat) {
  if (!cat) return null;
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}
function teamHtml(name, cat) {
  return cat ? `${name}<span class="cat-suffix" style="color:${catColor(cat)}"> - ${cat}</span>` : name;
}

function renderTable(standings) {
  if (!standings?.standings) return;

  const rows = [...standings.standings].sort((a, b) => {
    const ta = getTotalLaps(a.lane, a.lapCount);
    const tb = getTotalLaps(b.lane, b.lapCount);
    return tb - ta || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity);
  });

  const leaderTotal = rows[0] ? getTotalLaps(rows[0].lane, rows[0].lapCount) : 0;

  // Filas persistentes (por carril) reordenadas con ReorderFX: si dos equipos
  // intercambian posición, la fila se desliza a su sitio nuevo con un destello
  // en vez de que la tabla entera salte de golpe.
  const build = window.ReorderFX ? window.ReorderFX.reconcileAnimated : (c, items, keyFn, renderFn) => {
    c.innerHTML = '';
    items.forEach(item => c.appendChild(renderFn(item, null)));
  };
  build(tbody, rows, r => r.lane, (r, tr) => {
    const i = rows.indexOf(r);
    const total = getTotalLaps(r.lane, r.lapCount);
    const gap   = leaderTotal - total;
    const gapHtml = i === 0
      ? `<span class="tv-gap tv-gap--leader">${LANG === 'es' ? 'LÍDER' : 'LEADER'}</span>`
      : `<span class="tv-gap tv-gap--behind">−${gap} ${LANG === 'es' ? 'vlt' : 'lps'}</span>`;

    if (!tr) { tr = document.createElement('tr'); }
    tr.className = 'tv-row';
    tr.id = `tvrow-${r.lane}`;
    tr.innerHTML = `
        <td style="width:6vw"><span class="tv-pos ${posClass(i+1)}">${i+1}</span></td>
        <td>
          <div style="display:flex;align-items:center">
            <span class="tv-stripe" style="background:${r.color}"></span>
            <span class="tv-name">${teamHtml(r.name, r.categoria)}</span>
          </div>
        </td>
        <td class="tv-right" style="width:12vw"><span class="tv-total">${total}</span></td>
        <td class="tv-right" style="width:10vw"><span class="tv-manga-laps">${r.lapCount}</span></td>
        <td class="tv-right" style="width:12vw"><span class="tv-best">${formatMs(r.bestLapMs)}</span></td>
        <td class="tv-right" style="width:10vw">${gapHtml}</td>`;
    return tr;
  });
}

function flashRow(lane) {
  const el = document.getElementById(`tvrow-${lane}`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function addTick(lap) {
  recentTicks.unshift(lap);
  if (recentTicks.length > MAX_TICKS) recentTicks.pop();
  tickerEl.innerHTML = recentTicks.map(t => `
    <div class="tv-tick">
      <span class="tv-tick-dot" style="background:${t.color}">${t.lane}</span>
      <span class="tv-tick-name">${teamHtml(t.name, t.categoria)}</span>
      <span class="tv-tick-time">${formatMs(t.lapTimeMs)}</span>
    </div>`).join('');
}

// ── Initialize ────────────────────────────────────────────────────────────────
if (TV_DATA.standings) {
  renderTable(TV_DATA.standings);
  if (TV_DATA.standings.remainingMs != null) {
    startCountdown(TV_DATA.standings.remainingMs);
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
if (TV_DATA.isActive) {
  const socket = io();

  socket.on('connect', () => socket.emit('standings:request'));

  socket.on('standings', (data) => {
    renderTable(data);
    if (data.remainingMs != null && timerInt && lastTickAt) {
      remainingMs = data.remainingMs;
    }
  });

  socket.on('lap', (lap) => {
    if (!lap.isExit) {
      addTick(lap);
      flashRow(lap.lane);
    }
  });

  socket.on('tick', ({ elapsedMs }) => {
    if (timerInt === null && TV_DATA.durationMs) {
      startCountdown(TV_DATA.durationMs - elapsedMs);
    }
  });

  // Con la manga en pausa el reloj real está congelado en el servidor: paramos
  // el contador local para que no siga bajando en vacío, y lo retomamos desde
  // donde se quedó al reanudar (más un resync por si acaso).
  socket.on('manga:paused', () => {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
  });
  socket.on('manga:resumed', () => {
    startCountdown(remainingMs);
    try { socket.emit('standings:request'); } catch (e) {}
  });

  socket.on('manga:stopped', () => {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    timerEl.textContent = '00:00';
    document.getElementById('tvStatus').className = 'tv-status tv-status--finished';
    document.getElementById('tvStatus').innerHTML =
      `<span class="tv-status-dot"></span>${LANG === 'es' ? 'FINALIZADA' : 'FINISHED'}`;
  });

  socket.on('manga:cancelled', () => { location.reload(); });
}
