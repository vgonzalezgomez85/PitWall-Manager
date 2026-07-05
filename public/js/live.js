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
// Bandera del país del equipo. country viene como "Nombre|🇪🇸" o "Nombre|__SVG__"
// (senyera). Devuelve el HTML de la bandera (+ espacio) o '' si no hay.
const SENYERA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 6" width="16" height="11" style="border-radius:2px;flex-shrink:0;vertical-align:middle"><rect width="9" height="6" fill="#FCDD09"/><rect y="0.667" width="9" height="0.889" fill="#DA121A"/><rect y="2.222" width="9" height="0.889" fill="#DA121A"/><rect y="3.778" width="9" height="0.889" fill="#DA121A"/><rect y="5.333" width="9" height="0.667" fill="#DA121A"/></svg>';
function flagHtml(country) {
  if (!country) return '';
  const flag = String(country).split('|')[1];
  if (!flag) return '';
  const inner = flag === '__SVG__' ? SENYERA_SVG : `<span style="line-height:1">${flag}</span>`;
  return `<span class="lane-flag">${inner}</span>`;
}
function formatMs(ms) {
  if (ms == null) return '—';
  // 2 decimales (centésimas) TRUNCANDO, sin redondear (12.069s → 12.06).
  // Truncamos el total de centésimas; también evita la basura de coma flotante
  // (los tiempos del DS llegan en float).
  const cs = Math.floor(ms / 10);            // centésimas totales (truncadas)
  const totalSec   = Math.floor(cs / 100);
  const hundredths = cs % 100;
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  return `${mins > 0 ? mins + ':' : ''}${String(secs).padStart(mins > 0 ? 2 : 1, '0')}.${String(hundredths).padStart(2, '0')}`;
}


function formatDelta(bestMs, avgMs) {
  if (bestMs == null || avgMs == null) return '—';
  const d = avgMs - bestMs;
  if (d < 0) return '—';
  return '+' + formatMs(d);
}

// Color para ÚLTIMA: verde si ≤ mejor, blanco si ≤ media, ámbar si ≤ mejor*1.05, rojo si peor.
function ultColor(lastMs, bestMs, avgMs) {
  if (lastMs == null || bestMs == null) return null;
  if (lastMs <= bestMs + 1)      return 'green';
  if (avgMs != null && lastMs <= avgMs) return 'white';
  if (lastMs <= bestMs * 1.05)   return 'amber';
  return 'red';
}
// Color para Δ por % (med-mej)/mej*100: <1.5 verde, <3 blanco, <5 ámbar, ≥5 rojo.
function deltaColor(bestMs, avgMs) {
  if (bestMs == null || avgMs == null || avgMs < bestMs) return null;
  const pct = ((avgMs - bestMs) / bestMs) * 100;
  if (pct < 1.5) return 'green';
  if (pct < 3)   return 'white';
  if (pct < 5)   return 'amber';
  return 'red';
}
function _setLvColor(el, color) {
  if (!el) return;
  el.classList.remove('lv-color-green', 'lv-color-white', 'lv-color-amber', 'lv-color-red');
  if (color) el.classList.add('lv-color-' + color);
}

function formatRemaining(ms) {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── View picker: modal con 4 layouts (V1 horizontal, V2 compacta, V3/V4 soon) ─
function _viewStorageKey() {
  return `pitwall.liveView.race-${RACE_DATA.raceId}`;
}
function openViewPicker() {
  const ov = document.getElementById('viewPickerOverlay');
  if (!ov) return;
  ov.hidden = false;
  // Marcar la opción activa
  const current = localStorage.getItem(_viewStorageKey()) || '1';
  ov.querySelectorAll('.vp-opt').forEach(b => {
    b.classList.toggle('is-active', b.dataset.mode === current);
  });
}
function closeViewPicker() {
  const ov = document.getElementById('viewPickerOverlay');
  if (ov) ov.hidden = true;
}
function selectView(mode) {
  const grid = document.getElementById('lanesGrid');
  if (!grid) return;
  const m = String(mode);
  grid.classList.toggle('live-lanes--vertical', m === '2');
  grid.classList.toggle('live-lanes--detailed', m === '3');
  // V3 también activa el layout de cuadrícula compacta como base.
  if (m === '3') grid.classList.add('live-lanes--vertical');
  localStorage.setItem(_viewStorageKey(), m);
  closeViewPicker();
  if (typeof fitLaneCards === 'function') requestAnimationFrame(() => fitLaneCards());
  // Re-evaluar paginación de V1 al cambiar de vista
  requestAnimationFrame(_v1ApplyPaging);
}

// ── Paginación rotatoria de V1 (filas) cuando hay overflow ───────────────
let _v1PageTimer = null;
let _v1Page = 0;
let _v1ScheduledRAF = false;
const V1_PAGE_MS = 10000;

function _v1ResetPaging(grid) {
  if (_v1PageTimer) { clearInterval(_v1PageTimer); _v1PageTimer = null; }
  _v1Page = 0;
  if (grid) {
    grid.querySelectorAll('.lane-card').forEach(c => { c.style.display = ''; });
  }
}

function _v1ApplyPaging() {
  const grid = document.getElementById('lanesGrid');
  if (!grid) return;
  // Solo aplica en V1 (no V2 ni V3, que usan cuadrícula compacta)
  if (grid.classList.contains('live-lanes--vertical')) {
    return _v1ResetPaging(grid);
  }
  const cards = Array.from(grid.querySelectorAll('.lane-card'));
  if (cards.length === 0) return _v1ResetPaging(grid);
  // Mostrar todo para medir
  cards.forEach(c => { c.style.display = ''; });
  // ¿Cabe sin scroll? Si sí, no paginar.
  if (grid.scrollHeight <= grid.clientHeight + 1) {
    return _v1ResetPaging(grid);
  }
  // Ordenar visualmente por style.order (set por renderStandings)
  const orderedCards = cards.slice().sort((a, b) => {
    return (parseInt(a.style.order || '0', 10)) - (parseInt(b.style.order || '0', 10));
  });
  // Partir en páginas según altura
  const containerH = grid.clientHeight;
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const available = containerH - padding;
  const pages = [];
  let page = [];
  let usedH = 0;
  orderedCards.forEach(c => {
    const h = c.getBoundingClientRect().height + (page.length > 0 ? gap : 0);
    if (usedH + h > available && page.length > 0) {
      pages.push(page);
      page = [];
      usedH = 0;
    }
    page.push(c);
    usedH += h;
  });
  if (page.length > 0) pages.push(page);
  if (pages.length <= 1) return _v1ResetPaging(grid);
  function showPage(idx) {
    cards.forEach(c => { c.style.display = 'none'; });
    pages[idx % pages.length].forEach(c => { c.style.display = ''; });
  }
  _v1Page = _v1Page % pages.length;
  showPage(_v1Page);
  // Crear el temporizador UNA sola vez: antes se recreaba en cada llamada y
  // _v1ApplyPaging se invoca en cada actualización de standings, así que el
  // intervalo se reiniciaba antes de cumplirse y NUNCA rotaba. El callback
  // re-llama a _v1ApplyPaging (recalcula páginas, las tarjetas cambian).
  if (!_v1PageTimer) {
    _v1PageTimer = setInterval(() => {
      _v1Page = _v1Page + 1;
      _v1ApplyPaging();
    }, V1_PAGE_MS);
  }
}

function _v1SchedulePaging() {
  if (_v1ScheduledRAF) return;
  _v1ScheduledRAF = true;
  requestAnimationFrame(() => {
    _v1ScheduledRAF = false;
    _v1ApplyPaging();
  });
}

window.addEventListener('resize', _v1SchedulePaging);

// ── Swap meta/stats ↔ next-lane cada 10s cuando manga finalizada ────────
let _swapRotationTimer = null;
const SWAP_INTERVAL_MS = 6000;
function _startSwapRotation() {
  if (_swapRotationTimer) return;
  document.body.classList.add('swap-show-stats');
  _swapRotationTimer = setInterval(() => {
    const showingNext = document.body.classList.contains('swap-show-next');
    document.body.classList.toggle('swap-show-next', !showingNext);
    document.body.classList.toggle('swap-show-stats', showingNext);
  }, SWAP_INTERVAL_MS);
}
function _stopSwapRotation() {
  if (_swapRotationTimer) { clearInterval(_swapRotationTimer); _swapRotationTimer = null; }
  document.body.classList.remove('swap-show-stats', 'swap-show-next');
}

// ── Flip nombre de equipo ↔ piloto activo: 30s equipo / 10s piloto ──────────
// Solo afecta a tarjetas con piloto asignado (.has-driver). Inocuo si no hay.
let _driverFlipTimer = null;
function _startDriverFlip() {
  if (_driverFlipTimer) return;
  const TEAM_MS = 30000, DRIVER_MS = 10000;
  _driverFlipTimer = setInterval(() => {
    document.body.classList.add('show-driver');
    setTimeout(() => document.body.classList.remove('show-driver'), DRIVER_MS);
  }, TEAM_MS + DRIVER_MS);
}
// Restaurar la vista guardada. El botón siempre se muestra.
function _initViewPicker() {
  const nonRest = (RACE_DATA.lanes || []).filter(l => !l.isRest).length;
  const saved = localStorage.getItem(_viewStorageKey());
  if (saved) selectView(saved);
  else if (nonRest > 8) selectView('2');  // default sensato para muchos carriles
  // Cerrar con Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeViewPicker();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initViewPicker);
} else {
  _initViewPicker();
}

// ── Semaphore ─────────────────────────────────────────────────────────────
// La lógica del semáforo (showSemaphore/semaphoreStep/semaphoreGo + beeps)
// está en /js/semaphore.js. La vista debe cargarlo ANTES de live.js.

// ── Countdown timer ───────────────────────────────────────────────────────────
let remainingMs = RACE_DATA.durationMs;
let lastTickAt  = null;
let timerInt    = null;
let _pendingActionReload = false;  // recarga tras semáforo verde para quien pulsó RESUME
const timerEl   = document.getElementById('raceTimer');
const circuitTimersEl = document.getElementById('circuitTimers');
const statusEl  = document.getElementById('timerStatus');
let warned60 = false;
let warned30 = false;

// Temporizadores POR CIRCUITO (multi-DS). Con un solo circuito se usa el timer
// global (raceTimer). Con varios, se oculta el global y se muestra el tiempo
// restante propio de cada circuito (refleja su GO y sus pausas). Alimentado por
// el payload `circuits` de los eventos tick/standings (resolución 1s, suficiente).
function renderCircuitTimers(circuits) {
  if (!circuitTimersEl || !timerEl) return;
  if (!Array.isArray(circuits) || circuits.length <= 1) {
    circuitTimersEl.hidden = true;
    timerEl.style.display = '';
    // Timer global (1 circuito): verde si corre, rojo si pausado/parado.
    const st = (circuits && circuits[0]) ? circuits[0].status : null;
    timerEl.classList.toggle('live-timer--running', st === 'running');
    timerEl.classList.toggle('live-timer--stopped', st != null && st !== 'running');
    return;
  }
  timerEl.style.display = 'none';
  circuitTimersEl.hidden = false;
  circuits.forEach(c => {
    let el = circuitTimersEl.querySelector(`[data-ci="${c.index}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'circuit-timer';
      el.dataset.ci = c.index;
      el.innerHTML = `<span class="circuit-timer__lbl">C${c.index + 1}</span><span class="circuit-timer__val"></span>`;
      circuitTimersEl.appendChild(el);
    }
    el.querySelector('.circuit-timer__val').textContent = formatRemaining(c.remainingMs);
    el.classList.toggle('circuit-timer--paused',   c.status === 'paused');
    el.classList.toggle('circuit-timer--pending',  c.status === 'pending');
    el.classList.toggle('circuit-timer--finished', c.status === 'finished');
  });
}

function announceWarning(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG === 'es' ? 'es-ES' : 'en-US';
  u.rate = 1;
  speechSynthesis.speak(u);
}

function startCountdown(remaining) {
  remainingMs = remaining;
  lastTickAt  = Date.now();
  warned60 = remaining <= 60000;
  warned30 = remaining <= 30000;
  if (timerInt) clearInterval(timerInt);
  timerInt = setInterval(() => {
    const now     = Date.now();
    const elapsed = now - lastTickAt;
    lastTickAt    = now;
    remainingMs   = Math.max(0, remainingMs - elapsed);
    timerEl.textContent = formatRemaining(remainingMs);

    if (!warned60 && remainingMs <= 60000) {
      warned60 = true;
      announceWarning(LANG === 'es' ? 'Queda 1 minuto' : 'One minute remaining');
    }
    if (!warned30 && remainingMs <= 30000) {
      warned30 = true;
      announceWarning(LANG === 'es' ? 'Quedan 30 segundos' : '30 seconds remaining');
    }

    if (remainingMs <= 0) {
      clearInterval(timerInt);
      timerInt = null;
      statusEl.innerHTML = `<span class="status-text status-text--finished">${LANG === 'es' ? 'Finalizada' : 'Finished'}</span>`;
      document.body.classList.add('manga-finished');
      _startSwapRotation();
    }
  }, 250);
}

// ── Previous-manga lap totals (race cumulative base per lane) ─────────────────
const prevLapCountMap = {};
// Tiempo (ms de manga) del último cruce de cada carril en la manga actual.
// Sirve para desempatar el líder de vueltas de la manga: a igual VLT, va
// delante quien cruzó antes (menor elapsed). Se rellena en el evento 'lap' y
// se reinicia solo, porque manga:started recarga la página.
const mangaCrossMs = {};
RACE_DATA.lanes.forEach(l => { prevLapCountMap[l.lane] = l.prevLapCount || 0; });
function getTotalLaps(lane, lapCount) { return (prevLapCountMap[lane] || 0) + lapCount; }

// Rest lanes for this manga (teams/drivers sitting out)
const restLanes = RACE_DATA.lanes.filter(l => l.isRest);

// ── Lane cards ────────────────────────────────────────────────────────────────
const lanesGrid = document.getElementById('lanesGrid');
const laneLabel = '';

function buildCard(lane) {
  const card = document.createElement('div');
  card.className = 'lane-card' + (lane.isRest ? ' is-rest' : '');
  card.id = `card-${lane.cardId || lane.lane}`;
  card.style.setProperty('--card-color', lane.color);

  if (lane.isRest) {
    if (lane.finished) card.classList.add('is-final');
    const restTotal = lane.prevLapCount || 0;
    // FINAL: ya corrió todas sus mangas (fuera de la rueda de descansos).
    const posLabel = lane.finished
      ? 'FINAL'
      : (lane.restPos && lane.restTotal)
        ? `${LANG === 'es' ? 'Descanso' : 'Rest'} ${lane.restPos}/${lane.restTotal}`
        : (LANG === 'es' ? 'Descansando' : 'Resting');
    const icon = lane.finished ? '🏁' : '💤';
    card.innerHTML = `
      <div class="lane-card__rest-head">
        <span class="lane-card__rest-icon">${icon}</span>
        <span class="lane-card__pos" id="card-pos-${lane.cardId || lane.lane}"></span>
      </div>
      <div class="lane-card__rest-name">${flagHtml(lane.country)}${lane.name}</div>
      <div class="lane-card__rest-laps" id="card-rest-laps-${lane.cardId || lane.lane}">${restTotal}</div>
      <div class="lane-card__rest-label">${posLabel}</div>`;
    return card;
  }

  const initTotal = getTotalLaps(lane.lane, lane.lapCount ?? 0);
  card.innerHTML = `
    <div class="lane-card__col lane-card__col--name">
      <div class="lane-card__label">
        <span class="lane-card__track-text">${LANG === 'es' ? 'PISTA' : 'TRACK'}</span>
        <span class="lane-card__lane-num">${lane.lane}</span>
      </div>
      <div class="lane-card__name-row">
        <span class="lane-card__pos" id="card-pos-${lane.lane}"></span>
        <span class="lane-card__trend" id="card-trend-${lane.lane}">
          <span class="lane-card__trend-up"></span>
          <span class="lane-card__trend-down"></span>
        </span>
        <span class="lane-card__name"><span class="lane-card__name-scroll">${flagHtml(lane.country)}${lane.name}</span></span>
        <span class="lane-card__pit" id="card-pit-${lane.lane}" hidden title="Pit-stop">
          🔧<span class="lane-card__pit-count" id="card-pit-count-${lane.lane}"></span>
        </span>
        <span class="lane-card__exit" id="card-exit-${lane.lane}" hidden title="${LANG === 'es' ? 'Salidas' : 'Exits'}">
          ⚠️<span class="lane-card__exit-count" id="card-exit-count-${lane.lane}"></span>
        </span>
      </div>
      <div class="lane-card__driver-row" id="card-driver-${lane.lane}"></div>
    </div>

    <div class="lane-card__col lane-card__col--laps" data-col="vlt">
      <div class="lane-card__col-label">${LANG === 'es' ? 'VLT' : 'LAP'}</div>
      <div class="lane-card__laps" id="card-laps-${lane.lane}">${lane.lapCount ?? 0}</div>
    </div>

    <div class="lane-card__col lane-card__col--total" data-col="total">
      <div class="lane-card__col-label">${LANG === 'es' ? 'Total' : 'Total'}</div>
      <div class="lane-card__col-val" id="card-total-${lane.lane}">${initTotal}</div>
    </div>

    <div class="lane-card__col lane-card__col--last" data-col="ultima">
      <div class="lane-card__col-label">${LANG === 'es' ? 'Última' : 'Last'}</div>
      <div class="lane-card__col-val" id="card-last-${lane.lane}">${formatMs(lane.lastLapMs)}</div>
    </div>

    <div class="lane-card__col lane-card__col--best" data-col="mejor">
      <div class="lane-card__col-label">${LANG === 'es' ? 'Mejor' : 'Best'}</div>
      <div class="lane-card__col-val lane-card__col-val--best" id="card-best-${lane.lane}">${formatMs(lane.bestLapMs)}</div>
    </div>

    <div class="lane-card__col lane-card__col--avg" data-col="media">
      <div class="lane-card__col-label">${LANG === 'es' ? 'Media' : 'Avg'}</div>
      <div class="lane-card__col-val lane-card__col-val--avg" id="card-avg-${lane.lane}">${formatMs(lane.avgLapMs)}</div>
    </div>

    <div class="lane-card__col lane-card__col--delta" data-col="delta">
      <div class="lane-card__col-label">Δ</div>
      <div class="lane-card__col-val lane-card__col-val--delta" id="card-delta-${lane.lane}">${formatDelta(lane.bestLapMs, lane.avgLapMs)}</div>
    </div>

`;
  return card;
}

function renderNextLaneHints() {
  // Carrera ACABADA (última manga finalizada): la columna PRÓX = FINAL para
  // todos los que corrían (ya no tienen próxima manga). Los que descansaban ya
  // salen como FINAL en su propio card.
  if (RACE_DATA.raceOver) {
    document.querySelectorAll('#lanesGrid .lane-card:not(.is-rest)').forEach(card => {
      if (card.querySelector('.next-lane-badge')) return;
      appendFinalBadge(card);
    });
    return;
  }
  const map = RACE_DATA.nextLaneByLane || {};
  Object.entries(map).forEach(([cardKey, info]) => {
    const card = document.getElementById(`card-${cardKey}`);
    if (!card) return;
    if (card.querySelector('.next-lane-badge')) return;
    appendNextLaneBadge(card, info);
  });
}

function appendFinalBadge(card) {
  const badge = document.createElement('div');
  badge.className = 'next-lane-badge next-lane-badge--final';
  badge.innerHTML = `<span class="next-lane-arrow">🏁</span> <strong>FINAL</strong>`;
  card.appendChild(badge);
}

function appendNextLaneBadge(card, info) {
  const badge = document.createElement('div');
  if (info && info.rest) {
    badge.className = 'next-lane-badge next-lane-badge--rest';
    const tail = info.total ? `${info.pos}/${info.total}` : '';
    badge.innerHTML = `<span class="next-lane-arrow">→</span> <strong>${LANG === 'es' ? 'Descanso' : 'Rest'}${tail ? ' ' + tail : ''}</strong>`;
  } else if (info && info.lane != null) {
    badge.className = 'next-lane-badge';
    badge.innerHTML = `<span class="next-lane-arrow">→</span> ${LANG === 'es' ? 'Carril' : 'Lane'} <strong>${info.lane}</strong>`;
  } else {
    // Fallback for legacy emission ('rest' string or bare number)
    if (info === 'rest') {
      badge.className = 'next-lane-badge next-lane-badge--rest';
      badge.innerHTML = `<span class="next-lane-arrow">→</span> <strong>${LANG === 'es' ? 'Descanso' : 'Rest'}</strong>`;
    } else {
      badge.className = 'next-lane-badge';
      badge.innerHTML = `<span class="next-lane-arrow">→</span> ${LANG === 'es' ? 'Carril' : 'Lane'} <strong>${info}</strong>`;
    }
  }
  card.appendChild(badge);
}

function initCards() {
  const activeLaneCount = RACE_DATA.lanes.filter(l => !l.isRest).length;
  // Por defecto: hasta 8 carriles → vista horizontal (filas anchas).
  //              más de 8         → vista compacta (cuadrícula).
  // El botón "🖼 Vista" del header abre el picker para cambiarlo.
  if (activeLaneCount > 8) {
    lanesGrid.classList.add('live-lanes--vertical');
  }
  lanesGrid.style.setProperty('--lanes', activeLaneCount);

  RACE_DATA.lanes.forEach(lane => {
    lanesGrid.appendChild(buildCard(lane));
    if (lane.activeDriver) setActiveDriver(lane.lane, lane.activeDriver);
  });
  _startDriverFlip();   // flip nombre↔piloto en tarjetas con piloto asignado
  // Mide los nombres una vez montadas las tarjetas (marquesina si no caben)
  setTimeout(() => window.refreshLaneMarquees?.(), 50);
  if (RACE_DATA.mangaStatus === 'finished') {
    document.body.classList.add('manga-finished');
    renderNextLaneHints();
    _startSwapRotation();
  }
  // Defer una vez para que el layout esté listo
  requestAnimationFrame(() => fitLaneCards());
}

function updateCard(lane, lapCount, lastLapMs, bestLapMs, avgLapMs, exitCount) {
  const lapsEl  = document.getElementById(`card-laps-${lane}`);
  const lastEl  = document.getElementById(`card-last-${lane}`);
  const bestEl  = document.getElementById(`card-best-${lane}`);
  const avgEl   = document.getElementById(`card-avg-${lane}`);
  const totalEl = document.getElementById(`card-total-${lane}`);
  const exitsEl = document.getElementById(`card-exits-${lane}`);
  const deltaEl = document.getElementById(`card-delta-${lane}`);
  if (lapsEl)  lapsEl.textContent  = lapCount;
  if (lastEl)  lastEl.textContent  = formatMs(lastLapMs);
  if (bestEl)  bestEl.textContent  = formatMs(bestLapMs);
  if (avgEl && avgLapMs != null) avgEl.textContent = formatMs(avgLapMs);
  if (totalEl) totalEl.textContent = getTotalLaps(lane, lapCount);
  if (exitsEl) {
    exitsEl.textContent = exitCount ?? 0;
    exitsEl.classList.toggle('lane-card__col-val--exits-active', (exitCount ?? 0) > 0);
  }
  if (deltaEl) deltaEl.textContent = formatDelta(bestLapMs, avgLapMs);
  // Colores condicionales (V1 los muestra; en V2 se imponen los del mockup B vía CSS)
  _setLvColor(lastEl,  ultColor(lastLapMs, bestLapMs, avgLapMs));
  _setLvColor(deltaEl, deltaColor(bestLapMs, avgLapMs));
}

function flashCard(lane, isExit) {
  const el = document.getElementById(`card-${lane}`);
  if (!el) return;
  el.classList.remove('flash', 'exit-flash');
  void el.offsetWidth;
  el.classList.add(isExit ? 'exit-flash' : 'flash');
}

// Show 🔧 next to the lane name once a pit-stop happens. The icon stays
// visible for the rest of the manga; if more than one pit-stop occurs, an
// "+N" suffix is appended where N = total pit-stops − 1.
function updatePitIndicator(lane, count) {
  const wrap = document.getElementById(`card-pit-${lane}`);
  const num  = document.getElementById(`card-pit-count-${lane}`);
  if (!wrap || !num) return;
  if (!count || count <= 0) {
    wrap.hidden = true;
    num.textContent = '';
    return;
  }
  wrap.hidden = false;
  num.textContent = count > 1 ? `+${count - 1}` : '';
}

// Badge ⚠️ pequeño junto al nombre con el nº de salidas de la manga — mismo
// estilo compacto que el indicador 🔧 de pit-stop. Muestra el total de salidas.
function updateExitIndicator(lane, count) {
  const wrap = document.getElementById(`card-exit-${lane}`);
  const num  = document.getElementById(`card-exit-count-${lane}`);
  if (!wrap || !num) return;
  if (!count || count <= 0) {
    wrap.hidden = true;
    num.textContent = '';
    return;
  }
  wrap.hidden = false;
  num.textContent = count;
}

// ── Sidebar standings ─────────────────────────────────────────────────────────
const standingsBody = document.getElementById('standingsBody');
const projectedBody = document.getElementById('projectedBody');

// Carousel: when more rows than fit, rotate visible window every N seconds.
const STANDINGS_PAGE_MS = 20000;
let standingsPage = 0;
let standingsTimer = null;

// Compute how many rows fit in the visible area without scrolling. Returns
// `null` when there's no overflow at all (i.e. carousel is not needed).
function computeStandingsPageSize() {
  if (!projectedBody) return null;
  const container = projectedBody.closest('.live-panel__body') || projectedBody.parentElement;
  if (!container) return null;
  const rows = Array.from(projectedBody.querySelectorAll('tr.srow'));
  rows.forEach(r => { r.style.display = ''; });
  if (rows.length === 0) return null;
  if (container.scrollHeight <= container.clientHeight + 1) return null;
  const rowH = rows[0]?.offsetHeight || 0;
  const thead = projectedBody.parentElement.querySelector('thead');
  const headerH = thead ? thead.offsetHeight : 0;
  const usableH = Math.max(0, container.clientHeight - headerH);
  const pageSize = rowH > 0 ? Math.max(1, Math.floor(usableH / rowH)) : 0;
  return pageSize > 0 && pageSize < rows.length ? pageSize : null;
}

function paintStandingsPage() {
  const rows = Array.from(projectedBody.querySelectorAll('tr.srow'));
  const pageSize = computeStandingsPageSize();
  if (pageSize == null) {
    rows.forEach(r => { r.style.display = ''; });
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    standingsPage = 0;
    return false;
  }
  const pages = Math.ceil(rows.length / pageSize);
  if (standingsPage >= pages) standingsPage = 0;
  const start = standingsPage * pageSize;
  const end = start + pageSize;
  rows.forEach((r, i) => { r.style.display = (i >= start && i < end) ? '' : 'none'; });
  return true;
}

function applyStandingsCarousel() {
  if (!projectedBody) return;
  // Defer so the freshly-set innerHTML has been laid out; otherwise
  // scrollHeight/offsetHeight may read stale values.
  setTimeout(() => {
    fitSidebarTable();
    const active = paintStandingsPage();
    if (active && !standingsTimer) {
      standingsTimer = setInterval(() => {
        const rows = Array.from(projectedBody.querySelectorAll('tr.srow'));
        const pageSize = computeStandingsPageSize();
        if (pageSize == null) {
          rows.forEach(r => { r.style.display = ''; });
          clearInterval(standingsTimer); standingsTimer = null; standingsPage = 0;
          return;
        }
        const pages = Math.ceil(rows.length / pageSize);
        standingsPage = (standingsPage + 1) % pages;
        paintStandingsPage();
      }, STANDINGS_PAGE_MS);
    }
  }, 50);
}

window.addEventListener('resize', () => {
  if (projectedBody) { fitSidebarTable(); paintStandingsPage(); }
  fitLaneCards();
});

// ── Autofit lane cards (área central) ────────────────────────────────────────
// Calcula los tamaños de fuente de las tarjetas para que TODO el contenido
// quepa horizontal y verticalmente dentro de #lanesGrid. Toma el mínimo entre
// el factor altura (alto disponible / nº carriles) y el factor ancho (cada
// columna numérica debe caber tipo "11.06" / "+0.00").
function fitLaneCards() {
  if (!lanesGrid) return;
  const root = document.documentElement;
  const W = lanesGrid.clientWidth;
  const H = lanesGrid.clientHeight;
  if (W <= 0 || H <= 0) return;

  // Carriles activos (los que tienen tarjeta visible)
  const nLanes = Math.max(1, RACE_DATA.lanes.filter(l => !l.isRest).length);
  // Modo vertical (>8 carriles): el grid pasa a columnas, no apliquemos autofit
  // — el CSS por defecto ya se encarga. Limpiamos vars por si quedaron.
  if (lanesGrid.classList.contains('live-lanes--vertical')) {
    root.style.removeProperty('--ln-font-num');
    root.style.removeProperty('--ln-font-label');
    root.style.removeProperty('--ln-font-name');
    root.style.removeProperty('--ln-font-lanenum');
    root.style.removeProperty('--ln-font-track');
    return;
  }

  // Modo horizontal: una tarjeta por carril, una fila por carril.
  // Card height ≈ H / nLanes  (descontando pequeño gap), pero NUNCA por
  // debajo del min-height CSS (clamp(60px, 10vh, 120px)). Si la suma de
  // mínimos supera el viewport, el contenedor scrollea verticalmente.
  const cssMinH = Math.max(60, Math.min(120, window.innerHeight * 0.10));
  const cardH = Math.max(cssMinH, (H / nLanes) - 8);
  // En la tarjeta hay 2 filas (label arriba + valor abajo). El número grande
  // toma ~64% de la altura de la card (aprovecha el alto libre tras quitar
  // la columna de salidas).
  const fontByHeight = cardH * 0.64;

  // Ancho de tarjeta = W - paddings
  const cardW = Math.max(200, W - 24);
  // grid: name(1.4fr) + laps(.8fr) + 5 × num(1fr) → unidades = 1.4 + .8 + 5 = 7.2
  // (la columna "salidas" se eliminó; ahora son 5 columnas numéricas, por eso
  //  cada una es más ancha y los valores pueden crecer para llenar el hueco).
  // Una columna numérica = cardW / 7.2 - gap(~6px)
  const colW = (cardW / 7.2) - 6;
  // Tipos: el contenido más ancho suele ser "+11.06" o "12345" → ~5 chars.
  // En Share Tech Mono (monospace), char ≈ 0.6 * fontSize. Margen interno ~6px.
  const fontByWidth = (colW - 6) / (5 * 0.6);

  let fontPx  = Math.min(fontByHeight, fontByWidth);
  fontPx      = Math.max(14, Math.min(92, fontPx));   // clamp 14..92px

  const labelPx   = Math.max(9,  Math.min(20, fontPx * 0.32));
  const namePx    = Math.max(12, Math.min(34, fontPx * 0.55));
  const lanenumPx = Math.max(14, Math.min(46, fontPx * 0.75));
  const trackPx   = Math.max(9,  Math.min(22, fontPx * 0.42));

  root.style.setProperty('--ln-font-num',     fontPx.toFixed(1)  + 'px');
  root.style.setProperty('--ln-font-label',   labelPx.toFixed(1) + 'px');
  root.style.setProperty('--ln-font-name',    namePx.toFixed(1)  + 'px');
  root.style.setProperty('--ln-font-lanenum', lanenumPx.toFixed(1) + 'px');
  root.style.setProperty('--ln-font-track',   trackPx.toFixed(1)   + 'px');
}

// Reaplica fitLaneCards cuando el contenedor cambia (p. ej. arrastrar el
// resizer del sidebar). El window resize no se dispara en ese caso.
if (lanesGrid && 'ResizeObserver' in window) {
  let _rafId = 0;
  const ro = new ResizeObserver(() => {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(() => { _rafId = 0; fitLaneCards(); });
  });
  ro.observe(lanesGrid);
}

// ── Autofit sidebar standings table ──────────────────────────────────────────
// Calcula el tamaño de fuente y padding óptimos para que las N filas quepan
// vertical Y horizontalmente sin scroll/overflow. Toma el mínimo entre el
// factor de altura (filas vs alto disponible) y el factor de ancho (suma de
// columnas vs ancho del contenedor).
function fitSidebarTable() {
  if (!projectedBody) return;
  const container = projectedBody.closest('.live-panel__body') || projectedBody.parentElement;
  const root = document.documentElement;
  const rows = projectedBody.querySelectorAll('tr.srow');
  if (!container || rows.length === 0) return;
  const thead = projectedBody.parentElement.querySelector('thead');
  const headerH = thead ? thead.offsetHeight : 28;
  // Altura disponible para el cuerpo, descontando cabecera
  const usableH = Math.max(60, container.clientHeight - headerH);
  // Altura objetivo por fila
  const targetRowH = usableH / rows.length;
  // Factor por altura: font ≈ rowH / 38 (empírico).
  const fontByHeight = targetRowH / 38;
  // Factor por ancho: la tabla tiene ~8 columnas y necesita ~440px a 1rem.
  // Se descuentan ~24px de paddings/borders del contenedor.
  const nCols = (projectedBody.parentElement.querySelector('thead tr')?.children.length) || 8;
  const minWidthPerColAt1rem = 440 / 8;        // ≈55px por columna a 1rem
  const fontByWidth = Math.max(0, (container.clientWidth - 24)) / (nCols * minWidthPerColAt1rem);

  let fontRem = Math.min(fontByHeight, fontByWidth) * 0.85;
  fontRem     = Math.min(1.1, Math.max(0.5, fontRem));   // clamp 0.5..1.1rem
  const subRem = Math.max(0.5, fontRem * 0.92);
  const padRem = Math.max(0.05, fontRem * 0.30);
  const thRem  = Math.max(0.55, fontRem * 0.55);

  root.style.setProperty('--sb-font',     fontRem.toFixed(3) + 'rem');
  root.style.setProperty('--sb-sub-font', subRem.toFixed(3)  + 'rem');
  root.style.setProperty('--sb-pad',      padRem.toFixed(3)  + 'rem');
  root.style.setProperty('--sb-th-font',  thRem.toFixed(3)   + 'rem');
}

function posClass(pos) {
  return ['p1','p2','p3'][pos - 1] || 'pn';
}

let prevLaneGap = {};

function sortCards(rows) {
  // Equipos que descansan ESTA manga: no corren, pero tienen vueltas totales
  // acumuladas. Se integran en la clasificación por sus vueltas totales para
  // que se vean en la posición (P.x) que les toca, no apartados al final.
  const restRows = RACE_DATA.lanes.filter(l => l.isRest).map(l => ({
    isRest: true,
    cardId: l.cardId || l.lane,
    name:   l.name,
    prevLapCount: l.prevLapCount || 0,
    bestLapMs:    l.bestLapMs ?? null,
    avgLapMs:     l.avgLapMs ?? null,
    totalTimeMs:  l.totalTimeMs ?? null,
  }));

  const totalOf = r => r.isRest ? (r.prevLapCount || 0) : getTotalLaps(r.lane, r.lapCount);
  const cardKey = r => r.isRest ? r.cardId : r.lane;

  // Posición GENERAL de carrera (todas las tandas) por vueltas proyectadas,
  // calculada en renderProjected. Si no está disponible, cae al total dentro
  // de la tanda (comportamiento anterior).
  const hasGlobal = _globalProjPos && _globalProjPos.size > 0;
  const posOf = r => { const g = _globalProjPos.get(r.name); return g ? g.pos : 9999; };
  const rawOf = r => { const g = _globalProjPos.get(r.name); return (g && g.raw != null) ? g.raw : (totalOf(r) || -1); };

  const sorted = [...rows.filter(r => !r.isRest), ...restRows].sort((a, b) =>
    hasGlobal ? (posOf(a) - posOf(b))
              : (totalOf(b) - totalOf(a) || (a.totalTimeMs ?? Infinity) - (b.totalTimeMs ?? Infinity)));

  // Gaps entre tarjetas consecutivas (en vueltas proyectadas si hay global).
  const gapAbove = {}, gapBelow = {};
  sorted.forEach((r, i) => {
    const k = cardKey(r);
    gapAbove[k] = i === 0 ? null : rawOf(sorted[i-1]) - rawOf(r);
    gapBelow[k] = i === sorted.length - 1 ? null : rawOf(r) - rawOf(sorted[i+1]);
  });

  sorted.forEach((r, i) => {
    const k = cardKey(r);
    const card = document.getElementById(`card-${k}`);
    if (card) card.style.order = i;
    const posEl = document.getElementById(`card-pos-${k}`);
    if (posEl) {
      const gpos = hasGlobal ? posOf(r) : (i + 1);   // posición general real (1..N)
      posEl.textContent = `P.${gpos}`;
      posEl.className = `lane-card__pos lane-card__pos--${['1','2','3'][gpos-1] ?? 'n'}`;
    }

    if (r.isRest) return;   // los descansos ya tienen su orden y P.x; sin trend

    const trendEl = document.getElementById(`card-trend-${r.lane}`);
    if (trendEl) {
      const upEl   = trendEl.querySelector('.lane-card__trend-up');
      const downEl = trendEl.querySelector('.lane-card__trend-down');
      const prev = prevLaneGap[r.lane] || {};
      const ga = gapAbove[r.lane], gb = gapBelow[r.lane];

      // ▲: closing on the one above = good (green), widening = bad (red)
      if (upEl) {
        upEl.classList.remove('good', 'bad');
        upEl.textContent = ga == null ? '' : '▲';
        if (ga != null && prev.above != null) {
          if (ga < prev.above)      upEl.classList.add('good');
          else if (ga > prev.above) upEl.classList.add('bad');
        }
      }
      // ▼: the one below is closing on me = bad (red), opening gap = good (green)
      if (downEl) {
        downEl.classList.remove('good', 'bad');
        downEl.textContent = gb == null ? '' : '▼';
        if (gb != null && prev.below != null) {
          if (gb < prev.below)      downEl.classList.add('bad');
          else if (gb > prev.below) downEl.classList.add('good');
        }
      }
    }
  });

  prevLaneGap = {};
  sorted.forEach(r => { const k = cardKey(r); prevLaneGap[k] = { above: gapAbove[k], below: gapBelow[k] }; });
}

// Tracks previous gap (in total laps) from each lane to the driver ahead
let prevGapToAhead = {};

// Resalta (en verde, vía CSS .is-manga-leader) la VLT del equipo que más
// vueltas lleva en la manga ACTUAL. A igualdad de vueltas, gana quien cruzó
// antes (menor elapsed de su último cruce). Solo carriles activos (no descanso).
function highlightMangaLeader(standings) {
  if (!Array.isArray(standings)) return;
  let best = null;
  standings.forEach(r => {
    if (r.isRest || (r.lapCount || 0) <= 0) return;
    if (!best || r.lapCount > best.lapCount) { best = r; return; }
    if (r.lapCount === best.lapCount) {
      const a = mangaCrossMs[r.lane]    ?? Infinity;
      const b = mangaCrossMs[best.lane] ?? Infinity;
      if (a < b) best = r;
    }
  });
  document.querySelectorAll('.lane-card__laps.is-manga-leader')
    .forEach(el => el.classList.remove('is-manga-leader'));
  if (best) {
    const el = document.getElementById('card-laps-' + best.lane);
    if (el) el.classList.add('is-manga-leader');
  }
}

function renderStandings(data) {
  if (!data?.standings) return;
  // Merge active lanes with resting entities (lapCount=0 this manga)
  const restRows = restLanes.map(l => ({
    lane: l.lane, name: l.name, color: l.color, country: l.country,
    lapCount: 0, lastLapMs: null, bestLapMs: null, avgLapMs: null,
    exitCount: 0, isRest: true, prevLapCount: l.prevLapCount || 0,
  }));

  const rowTotal = r => r.isRest ? (r.prevLapCount || 0) : getTotalLaps(r.lane, r.lapCount);

  // Sort sidebar by total race laps
  const rows = [...data.standings, ...restRows].sort((a, b) =>
    rowTotal(b) - rowTotal(a) || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity)
  );

  // Calculate gaps (vueltas y segundos)
  const gapInLaps = {};
  const gapInMs = {};
  rows.forEach((r, i) => {
    if (i === 0) {
      gapInLaps[r.lane] = 0;
      gapInMs[r.lane] = 0;
      return;
    }
    const prevTotal = rowTotal(rows[i-1]);
    const currTotal = rowTotal(r);
    const lapGap = prevTotal - currTotal;
    gapInLaps[r.lane] = lapGap;

    // Gap en segundos: si está el mismo número de vueltas, usa la diferencia de promedio
    if (lapGap === 0 && r.avgLapMs != null && rows[i-1].avgLapMs != null) {
      gapInMs[r.lane] = rows[i-1].avgLapMs - r.avgLapMs;
    } else {
      gapInMs[r.lane] = 0;
    }
  });

  if (projectedBody) projectedBody.innerHTML = rows.map((r, i) => {
    if (r.isRest) {
      return `
      <tr class="srow srow--rest" id="srow-rest-${i}">
        <td><span class="sr-pos">${i+1}</span></td>
        <td style="max-width:80px"><span class="sr-name sr-name--rest" title="${r.name}">💤 ${flagHtml(r.country)}${r.name}</span></td>
        <td class="sr-right">—</td>
        <td class="sr-right"><span class="sr-total">${r.prevLapCount}</span></td>
        <td class="sr-right">—</td>
        <td class="sr-right">—</td>
        <td class="sr-right">—</td>
        <td class="sr-right">—</td>
      </tr>`;
    }
    const gapLapDisplay = gapInLaps[r.lane] !== 0 ? `-${gapInLaps[r.lane]}` : '—';
    const gapSecDisplay = gapInMs[r.lane] > 0 ? `+${formatMs(gapInMs[r.lane])}` : '—';

    return `
    <tr class="srow" id="srow-${r.lane}">
      <td style="width:28px"><span class="sr-pos ${posClass(i+1)}">${i+1}</span></td>
      <td style="max-width:80px"><span class="sr-name" title="${r.name}">${flagHtml(r.country)}${r.name}</span></td>
      <td class="sr-right"><span class="sr-laps">${r.lapCount}</span></td>
      <td class="sr-right"><span class="sr-total">${getTotalLaps(r.lane, r.lapCount)}</span></td>
      <td class="sr-right"><span class="sr-best">${formatMs(r.bestLapMs)}</span></td>
      <td class="sr-right"><span class="sr-avg">${formatMs(r.avgLapMs)}</span></td>
      <td class="sr-right"><span class="sr-delta">${gapLapDisplay}</span></td>
      <td class="sr-right"><span class="sr-delta">${gapSecDisplay}</span></td>
    </tr>`;
  }).join('');

  applyStandingsCarousel();

  data.standings.forEach(r => updateCard(r.lane, r.lapCount, r.lastLapMs, r.bestLapMs, r.avgLapMs, r.exitCount));
  data.standings.forEach(r => updatePitIndicator(r.lane, r.pitStopCount ?? 0));
  data.standings.forEach(r => updateExitIndicator(r.lane, r.exitCount ?? 0));
  highlightMangaLeader(data.standings);

  updateRaceBestLaps(data.raceBestLaps);
  // renderProjected ANTES que sortCards: calcula la posición general (todas las
  // tandas) que las tarjetas usan para su orden y su P.x.
  renderProjected(data);
  sortCards(data.standings);
  // Re-evaluar paginación tras reordenar cards en V1
  _v1SchedulePaging();
}

let prevProjGap = {};
// Posición GENERAL de carrera (todas las tandas) por vueltas proyectadas.
// La rellena renderProjected y la consumen las tarjetas (sortCards) para
// mostrar la P.x real del conjunto de la carrera, no solo de la tanda.
let _globalProjPos = new Map();

function renderProjected(data) {
  if (!data?.standings) return;

  // ── Fórmula (estilo Tic Tac, media sucia, por piloto) ───────────────────
  //   projectedTotal = (planned_mangas_del_piloto × manga_duration) / avgLapMs
  //
  // - planned_mangas: número de mangas que tiene asignadas el piloto en BD
  //   (lo que realmente correrá; depende del rotation: si hay más pilotos
  //    que carriles, algunos pilotos descansan en algunas mangas).
  // - manga_duration: ms por manga.
  // - avgLapMs: media SUCIA (incluye salidas, excluye warmup) a través de
  //   todas las mangas que ha corrido el piloto hasta ahora.
  //
  // Pronóstico CONVERGENTE, anclado en lo ya hecho:
  //   proyección = vueltas_reales
  //              + (tiempo restante de SU manga actual / media)   [si corre ahora]
  //              + (mangas futuras pendientes × duración / media)
  // Quien ya terminó sus mangas proyecta su total real (no extrapola 6 enteras).
  const MANGA_DURATION_MS = RACE_DATA.mangaDurationMs || 0;
  const mangaRemainingMs  = (data && data.remainingMs > 0) ? data.remainingMs : 0;

  const allPMap = new Map();
  (RACE_DATA.allParticipants || []).forEach(p => allPMap.set(p.entity_name, p));

  // Activo en esta manga: usa raceAvgLapMs (combina histórico BD + manga actual
  // en memoria, ya excluye warmup). Total acumulado = prevLaps + lapCount.
  const activeMap = new Map();
  data.standings.forEach(r => {
    const prevLaps = prevLapCountMap[r.lane] || 0;
    const total    = prevLaps + r.lapCount;
    const avgLapMs = r.raceAvgLapMs ?? r.avgLapMs ?? null;
    activeMap.set(r.name, {
      name: r.name, color: r.color,
      total,
      avgLapMs,
      bestLapMs: r.bestLapMs,
      onTrack: true,   // corre la manga actual → le queda tiempo de esta manga
    });
  });

  // Combinar todos los participantes de la carrera
  const seen = new Set();
  const rows = [];
  (RACE_DATA.allParticipants || []).forEach(p => {
    const name = p.entity_name;
    if (seen.has(name)) return;
    seen.add(name);
    if (activeMap.has(name)) {
      rows.push(activeMap.get(name));
    } else {
      // No corre esta manga (descanso o tanda futura): usa media de BD
      rows.push({
        name, color: p.color || '#8b949e',
        total: p.total_laps,
        avgLapMs: p.avg_lap_ms != null ? Math.round(p.avg_lap_ms) : null,
        bestLapMs: p.best_lap_ms ?? null,
      });
    }
  });
  activeMap.forEach((r, name) => { if (!seen.has(name)) rows.push(r); });

  // Proyección anclada en lo ya hecho + lo que aún le queda por correr.
  rows.forEach(r => {
    const p = allPMap.get(r.name);
    const futureMangas = p?.remaining_mangas || 0;            // mangas futuras 'pending' (NO la activa)
    if (r.avgLapMs && r.avgLapMs > 0) {
      const currentLeftMs = r.onTrack ? mangaRemainingMs : 0; // lo que queda de su manga actual
      const futureMs      = futureMangas * MANGA_DURATION_MS;  // mangas futuras completas
      const remMs         = currentLeftMs + futureMs;
      // Al terminar (sin tiempo restante), ancla en la coma media por manga
      // (misma que desempata en resultados) para mostrar la fracción de vuelta.
      const comaPM = (p && p.mangas_raced > 0) ? (p.coma_total || 0) / p.mangas_raced : 0;
      r.projectedTotalRaw = (r.total || 0) + (remMs > 0 ? remMs / r.avgLapMs : comaPM);
      r.projectedTotal    = Math.round(r.projectedTotalRaw);
    } else {
      r.projectedTotalRaw = null;
      r.projectedTotal    = null;
    }
  });

  // Sort: con proyección desc, sin proyección al final, desempate por mejor vuelta
  rows.sort((a, b) => {
    if (a.projectedTotalRaw == null && b.projectedTotalRaw == null) return 0;
    if (a.projectedTotalRaw == null) return 1;
    if (b.projectedTotalRaw == null) return -1;
    return b.projectedTotalRaw - a.projectedTotalRaw
        || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity);
  });

  // ── UNIFICACIÓN: si el servidor manda su proyección (getStandings /
  //    _buildProjection), se usa TAL CUAL — es la MISMA que la tabla
  //    "Clasificación General" y el panel Lap. Así las tarjetas dejan de
  //    recalcular su propia proyección (que difería 1-3 puestos) y todo PitWall
  //    muestra el mismo orden. El cálculo de arriba queda como fallback para
  //    servidores antiguos que no envíen `projection`.
  if (data.projection && data.projection.length) {
    rows.length = 0;
    data.projection.forEach(p => rows.push({
      name: p.name, total: p.total, avgLapMs: p.avgLapMs,
      projectedTotal: p.projectedTotal != null ? Math.round(p.projectedTotal) : null,
      projectedTotalRaw: p.projectedTotal, bestLapMs: null,
    }));
    // Participantes sin proyección todavía (0 vueltas): al final, sin estimación.
    const have = new Set(rows.map(r => r.name));
    (RACE_DATA.allParticipants || []).forEach(p => {
      if (!have.has(p.entity_name)) rows.push({
        name: p.entity_name, total: p.total_laps || 0, avgLapMs: null,
        projectedTotal: null, projectedTotalRaw: null, bestLapMs: null,
      });
    });
  }

  // Exponer la posición general (1..N) por entidad para que las tarjetas la usen.
  _globalProjPos = new Map();
  rows.forEach((r, i) => _globalProjPos.set(r.name, { pos: i + 1, raw: r.projectedTotalRaw }));

  // Calculate projected gaps en vueltas + a numeric score for trend tracking
  // score = projectedTotal*BIG - avgLapMs (so closer to leader = higher; avg as tiebreaker)
  const BIG = 1e9;
  const scoreOf = r => (r.projectedTotal || 0) * BIG - (r.avgLapMs ?? BIG);
  const projGapAhead  = {};   // Gap V:   vs el de delante (posición i-1)
  const projGapLeader = {};   // Gap V.T.: vs el primer clasificado (líder)
  const gapAboveNow   = {};
  const gapBelowNow   = {};

  // Dos gaps en vueltas proyectadas (el líder no muestra ninguno). Si alguien
  // no tiene proyección (null), se marca null → "—" en la UI.
  const leaderRaw = rows.length ? (rows[0].projectedTotalRaw ?? rows[0].projectedTotal) : null;
  rows.forEach((r, i) => {
    const rRaw = r.projectedTotalRaw ?? r.projectedTotal;
    const above = rows[i-1];
    const aboveRaw = above ? (above.projectedTotalRaw ?? above.projectedTotal) : null;
    projGapAhead[r.name]  = (i === 0) ? 0 : (aboveRaw  == null || rRaw == null) ? null : (aboveRaw  - rRaw);
    projGapLeader[r.name] = (i === 0) ? 0 : (leaderRaw == null || rRaw == null) ? null : (leaderRaw - rRaw);

    // Tendencia (↕): se sigue midiendo contra el rival de delante / detrás.
    gapAboveNow[r.name] = (i === 0 || r.projectedTotal == null || (above && above.projectedTotal == null))
      ? null : scoreOf(above) - scoreOf(r);
    const below = rows[i+1];
    gapBelowNow[r.name] = (below && r.projectedTotal != null && below.projectedTotal != null)
      ? scoreOf(r) - scoreOf(below) : null;
  });

  // Compare with previous render to determine trend arrows
  const trend = {};
  rows.forEach(r => {
    const prev = prevProjGap[r.name] || {};
    const t = { up: 'neutral', down: 'neutral' };
    if (gapAboveNow[r.name] != null && prev.above != null) {
      if (gapAboveNow[r.name] < prev.above)      t.up = 'good'; // closing
      else if (gapAboveNow[r.name] > prev.above) t.up = 'bad';  // widening
    }
    if (gapBelowNow[r.name] != null && prev.below != null) {
      if (gapBelowNow[r.name] < prev.below)      t.down = 'bad';  // below is closing in
      else if (gapBelowNow[r.name] > prev.below) t.down = 'good'; // opening gap
    }
    trend[r.name] = t;
  });

  // Persist current gaps for next render
  prevProjGap = {};
  rows.forEach(r => {
    prevProjGap[r.name] = { above: gapAboveNow[r.name], below: gapBelowNow[r.name] };
  });

  if (projectedBody) projectedBody.innerHTML = rows.map((r, i) => {
    const gV  = projGapAhead[r.name];
    const gVT = projGapLeader[r.name];
    const gapVDisplay  = (gV  && Math.abs(gV)  >= 0.01) ? `-${gV.toFixed(2)}`  : '—';
    const gapVTDisplay = (gVT && Math.abs(gVT) >= 0.01) ? `-${gVT.toFixed(2)}` : '—';
    const tr = trend[r.name];
    const upCls   = tr.up === 'good' ? ' good' : tr.up === 'bad' ? ' bad' : '';
    const downCls = tr.down === 'good' ? ' good' : tr.down === 'bad' ? ' bad' : '';
    const upChar   = i === 0 ? '' : '▲';
    const downChar = i === rows.length - 1 ? '' : '▼';

    return `
    <tr class="srow">
      <td><span class="sr-pos ${posClass(i+1)}">${i+1}</span></td>
      <td><span class="sr-name" title="${r.name}">${r.name}</span></td>
      <td class="sr-right"><span class="sr-proj">${r.projectedTotalRaw != null ? r.projectedTotalRaw.toFixed(1) : '—'}</span></td>
      <td class="sr-right"><span class="sr-ontrack">${r.total}</span></td>
      <td class="sr-right"><span class="sr-avg">${formatMs(r.avgLapMs)}</span></td>
      <td class="sr-arrows">
        <span class="sr-arrow-up${upCls}">${upChar}</span>
        <span class="sr-arrow-down${downCls}">${downChar}</span>
      </td>
      <td class="sr-right"><span class="sr-delta">${gapVDisplay}</span></td>
      <td class="sr-right"><span class="sr-delta">${gapVTDisplay}</span></td>
    </tr>`;
  }).join('');

  applyStandingsCarousel();
}

// ── Best laps panel ──────────────────────────────────────────────────────────
const bestLapsBody   = document.getElementById('bestLapsBody');   // sidebar/popup (table rows)
const bestLapsFooter = document.getElementById('bestLapsFooter'); // footer ticker (pills)
let   _raceBestLaps = { ...(RACE_DATA.raceBestLaps || {}) };

function renderBestLaps() {
  const rows = RACE_DATA.lanes
    .filter(l => !l.isRest)
    .map(l => ({
      lane:       l.lane,
      color:      l.color,
      name:       l.name,
      bestLapMs:  (_raceBestLaps[l.lane]?.bestLapMs) ?? null,
      entityName: (_raceBestLaps[l.lane]?.entityName) ?? null,
    }))
    .filter(r => r.bestLapMs != null)
    .sort((a, b) => a.bestLapMs - b.bestLapMs);

  // Versión tabla (sidebar/popup)
  if (bestLapsBody) {
    if (rows.length === 0) {
      bestLapsBody.innerHTML = '';
    } else {
      bestLapsBody.innerHTML = rows.map((r, i) => {
        const cls = i === 0 ? 'best-lap-row--gold' : '';
        const dot = `<span class="ticker-dot" style="background:${r.color};display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:10px;color:#fff;font-weight:700">${r.lane}</span>`;
        return `<tr class="srow best-lap-row ${cls}">
          <td class="sr-center">${dot}</td>
          <td style="max-width:90px"><span class="sr-name" title="${r.entityName || r.name}">${r.entityName || r.name}</span></td>
          <td class="sr-right"><span class="sr-best" style="${i===0?'color:#ffd700;font-weight:700':''}">${formatMs(r.bestLapMs)}</span></td>
        </tr>`;
      }).join('');
    }
  }

  // Versión footer ticker (pills horizontales para TV) con paginación 30s
  if (bestLapsFooter) {
    if (rows.length === 0) {
      bestLapsFooter.innerHTML = `<span class="bl-footer__empty">${LANG === 'es' ? 'Sin vueltas registradas' : 'No laps yet'}</span>`;
      _bestLapsResetPager();
    } else {
      bestLapsFooter.innerHTML = rows.map((r, i) => {
        const cls = i === 0 ? ' bl-pill--gold' : '';
        return `<div class="bl-pill${cls}">
          <span class="bl-pill__lane" style="background:${r.color}">${r.lane}</span>
          <span class="bl-pill__name" title="${r.entityName || r.name}">${r.entityName || r.name}</span>
          <span class="bl-pill__time">${formatMs(r.bestLapMs)}</span>
        </div>`;
      }).join('');
      // Mide al siguiente frame para que el DOM ya esté pintado
      requestAnimationFrame(_bestLapsApplyPaging);
    }
  }
}

// ── Paginación rotatoria del ticker de vueltas rápidas ───────────────────
let _bestLapsPageTimer = null;
let _bestLapsCurrentPage = 0;
const BEST_LAPS_PAGE_MS = 30000;

function _bestLapsResetPager() {
  if (_bestLapsPageTimer) { clearInterval(_bestLapsPageTimer); _bestLapsPageTimer = null; }
  _bestLapsCurrentPage = 0;
}

function _bestLapsApplyPaging() {
  if (!bestLapsFooter) return;
  const pills = Array.from(bestLapsFooter.querySelectorAll('.bl-pill'));
  if (pills.length === 0) { _bestLapsResetPager(); return; }
  // Restaurar todos para medir el ancho natural
  pills.forEach(p => { p.style.display = ''; });
  const containerW = bestLapsFooter.clientWidth;
  // ¿Caben todos? Si scrollWidth <= clientWidth no hay overflow → sin paginación.
  if (bestLapsFooter.scrollWidth <= containerW + 1) {
    _bestLapsResetPager();
    return;
  }
  // Repartir en páginas según cuántas pills caben en el ancho disponible
  const pages = [];
  let page = [];
  let usedW = 0;
  // gap real del flex container
  const gap = parseFloat(getComputedStyle(bestLapsFooter).gap) || 0;
  pills.forEach((p) => {
    const w = p.getBoundingClientRect().width + gap;
    if (usedW + w > containerW && page.length > 0) {
      pages.push(page);
      page = [];
      usedW = 0;
    }
    page.push(p);
    usedW += w;
  });
  if (page.length > 0) pages.push(page);
  if (pages.length <= 1) { _bestLapsResetPager(); return; }
  // Estado: ocultar todas y mostrar solo la página actual
  function showPage(idx) {
    pills.forEach(p => { p.style.display = 'none'; });
    pages[idx % pages.length].forEach(p => { p.style.display = ''; });
  }
  _bestLapsCurrentPage = _bestLapsCurrentPage % pages.length;
  showPage(_bestLapsCurrentPage);
  // (re)arrancar timer de rotación
  if (_bestLapsPageTimer) clearInterval(_bestLapsPageTimer);
  _bestLapsPageTimer = setInterval(() => {
    _bestLapsCurrentPage = (_bestLapsCurrentPage + 1) % pages.length;
    showPage(_bestLapsCurrentPage);
  }, BEST_LAPS_PAGE_MS);
}

// Re-paginar al redimensionar la ventana
window.addEventListener('resize', () => {
  if (bestLapsFooter && bestLapsFooter.querySelector('.bl-pill')) {
    requestAnimationFrame(_bestLapsApplyPaging);
  }
});

function updateRaceBestLaps(raceBestLaps) {
  if (!raceBestLaps) return;
  let changed = false;
  Object.entries(raceBestLaps).forEach(([lane, info]) => {
    if (!info || info.bestLapMs == null) return;
    const prev = _raceBestLaps[lane];
    // Trust the server: if value or entity differs, accept the update. The
    // server already enforces "best across the race"; the client just mirrors.
    if (!prev
        || prev.bestLapMs !== info.bestLapMs
        || prev.entityName !== info.entityName) {
      _raceBestLaps[lane] = info;
      changed = true;
    }
  });
  if (changed) renderBestLaps();
}

// ── Lap ticker ────────────────────────────────────────────────────────────────
const ticker    = document.getElementById('lapTicker');
const MAX_TICKS = 20;

function addTick(lap) {
  if (!ticker) return;
  const el = document.createElement('div');
  el.className = 'ticker-item';
  el.style.borderLeftColor = lap.color;
  // Pit-stop takes precedence over plain exit (it's also an exit).
  const badge = lap.isPitStop ? '🔧' : (lap.isExit ? '⚠️' : '');
  el.innerHTML = `
    <span class="ticker-dot" style="background:${lap.color}">${lap.lane}</span>
    <span class="ticker-name">${lap.name}</span>
    <span class="ticker-lapn">V${lap.lapNumber}</span>
    <span class="ticker-time">${badge ? badge + ' ' : ''}${formatMs(lap.lapTimeMs)}</span>`;
  ticker.insertBefore(el, ticker.firstChild);
  setTimeout(() => el.classList.add('visible'), 10);
  const items = ticker.querySelectorAll('.ticker-item');
  if (items.length > MAX_TICKS) items[items.length - 1].remove();
}

// ── Next-tanda button (rendered by server on page load) ───────────────────────
(function () {
  const btn = document.getElementById('next-tanda-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled    = true;
    btn.textContent = LANG === 'es' ? 'Cargando...' : 'Loading...';
    try {
      const r = await fetch(
        `/races/${btn.dataset.raceId}/tandas/${btn.dataset.tandaId}/next-tanda`,
        { method: 'POST' }
      );
      const d = await r.json();
      if (d.ok) location.href = `/races/${btn.dataset.raceId}/mangas/${d.mangaId}/live`;
    } catch {
      btn.disabled    = false;
      btn.textContent = `▶ Tanda ${btn.dataset.nextTandaNumber}`;
    }
  });
})();

// ── Initialize ────────────────────────────────────────────────────────────────
initCards();
// Primera evaluación de paginación en V1 una vez pintadas las tarjetas
requestAnimationFrame(_v1ApplyPaging);

// Default view: expanded para ≤8 carriles. El botón Vista lo gestiona el picker.
if (RACE_DATA.lanes.filter(l => !l.isRest).length <= 8) {
  lanesGrid.classList.add('live-lanes--expanded');
}

if (RACE_DATA.standings) {
  renderStandings(RACE_DATA.standings);
  renderCircuitTimers(RACE_DATA.standings.circuits);
  renderBestLaps();
  if (RACE_DATA.standings.remainingMs != null) {
    if (RACE_DATA.standings.elapsedMs != null)
      RACE_DATA.durationMs = RACE_DATA.standings.remainingMs + RACE_DATA.standings.elapsedMs;
    if (RACE_DATA.isPaused) {
      // Manga pausada: mostrar el tiempo congelado, sin arrancar la cuenta atrás.
      remainingMs = RACE_DATA.standings.remainingMs;
      if (timerEl) timerEl.textContent = formatRemaining(remainingMs);
    } else {
      startCountdown(RACE_DATA.standings.remainingMs);
    }
  }
} else {
  // Non-active: render initial state from DB laps (passed in lanes array)
  const initialData = {
    standings: RACE_DATA.lanes
      .filter(l => !l.isRest)
      .sort((a, b) => {
        const ta = getTotalLaps(a.lane, a.lapCount);
        const tb = getTotalLaps(b.lane, b.lapCount);
        return tb - ta || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity);
      })
      .map((r, i) => ({ ...r, position: i+1, gap: 0, exitCount: r.exitCount ?? 0 })),
    elapsedMs: 0, remainingMs: 0
  };
  if (initialData.standings.length > 0) renderStandings(initialData);
  renderBestLaps();
}

// ── Voice announcements ───────────────────────────────────────────────────────
const speechQueue = [];
let   speechBusy  = false;

// 3 modos: 'all' = canta cada cruce, 'best' = solo nueva vuelta rápida del
// carril, 'off' = silenciado. Default: 'best' (comportamiento histórico).
const RACE_VOICE_KEY = 'slotime.race.voiceMode';
const RACE_VOICE_MODES = ['all', 'best', 'off'];
let voiceMode = localStorage.getItem(RACE_VOICE_KEY) || 'best';

// Iconos SVG (stroke-style) por estado de voiceMode.
// best = altavoz + rayo (canta solo las vueltas rápidas)
const VOICE_ICON = {
  off:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
  best: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6L4.5 9.5H1.5v5h3L9 18z"/><path d="M17 3.5l-3.2 6.5H17l-1 7 4.5-7h-3l1-6.5z" fill="currentColor" stroke="none"/></svg>',
  all:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15 9a3 3 0 0 1 0 6"/><path d="M18 6a7 7 0 0 1 0 12"/></svg>',
};
function voiceLabel() {
  const isES = LANG === 'es';
  if (voiceMode === 'off')  return isES ? 'Sin voz'      : 'No voice';
  if (voiceMode === 'best') return isES ? 'Sólo rápidas' : 'Fast only';
  return                          isES ? 'Todas'        : 'All';
}
function voiceTitle() {
  if (LANG === 'es') {
    return voiceMode === 'off'  ? 'Voz desactivada — clic: cantar todas las vueltas' :
           voiceMode === 'best' ? 'Solo se cantan vueltas rápidas — clic: silenciar' :
                                  'Se cantan todas las vueltas — clic: solo vueltas rápidas';
  }
  return voiceMode === 'off'  ? 'Voice off — click: announce all laps' :
         voiceMode === 'best' ? 'Only fast laps — click: mute' :
                                'All laps — click: only fast laps';
}
function refreshVoiceBtn() {
  const btn = document.getElementById('voiceBtn');
  if (!btn) return;
  const icon = VOICE_ICON[voiceMode] || VOICE_ICON.all;
  btn.innerHTML = icon + '<span>' + voiceLabel() + '</span>';
  btn.title     = voiceTitle();
  // Resalta como GO (ámbar/glow) cuando está en modo 'best' (sólo rápidas).
  btn.classList.toggle('lbtn--go',   voiceMode === 'best');
  btn.classList.toggle('lbtn--back', voiceMode !== 'best');
}
function toggleVoice() {
  const idx = RACE_VOICE_MODES.indexOf(voiceMode);
  voiceMode = RACE_VOICE_MODES[(idx + 1) % RACE_VOICE_MODES.length];
  try { localStorage.setItem(RACE_VOICE_KEY, voiceMode); } catch {}
  if (voiceMode === 'off') {
    speechQueue.length = 0;
    window.speechSynthesis?.cancel();
    speechBusy = false;
  }
  refreshVoiceBtn();
}
// Inicializa el botón al cargar
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', refreshVoiceBtn);
} else {
  refreshVoiceBtn();
}

function formatMsForSpeech(ms) {
  if (ms == null) return '';
  const totalSec   = Math.floor(ms / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  const hStr = String(hundredths).padStart(2, '0');
  if (mins > 0) return `${mins}:${String(secs).padStart(2,'0')}.${hStr}`;
  // Spoken as "12 con 45" (ES) / "12 45" (EN) — sounds natural for lap times
  return LANG === 'es' ? `${secs} con ${hStr}` : `${secs} ${hStr}`;
}

function drainSpeech() {
  if (!speechQueue.length) { speechBusy = false; return; }
  speechBusy = true;
  const utt = new SpeechSynthesisUtterance(speechQueue.shift());
  utt.lang  = LANG === 'es' ? 'es-ES' : 'en-US';
  utt.rate  = 1.15;
  utt.onend = utt.onerror = drainSpeech;
  window.speechSynthesis.speak(utt);
}

function announce(text) {
  if (!window.speechSynthesis || voiceMode === 'off') return;
  speechQueue.push(text);
  if (!speechBusy) drainSpeech();
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
// Always open the socket on the live page (even when the current manga is
// finished) so the hardware GO can start the next pending manga and navigate
// here. The server only fires GO when at least one localhost client is on a
// live page — so we MUST emit race:live:join regardless of manga status.
{
  const socket = io();

  socket.on('connect', () => socket.emit('race:live:join'));
  window.addEventListener('beforeunload', () => socket.emit('race:live:leave'));

  // ── DS-300 link status banner ─────────────────────────────────────────────
  const banner      = document.getElementById('serialBanner');
  const bannerSince = document.getElementById('serialBannerSince');
  let serialDownSince = null;
  socket.on('serial:status', (data) => {
    console.log('[live] serial:status received', data);
    if (!banner) return;
    const connected = !!data.connected;
    if (connected) {
      banner.hidden = true;
      serialDownSince = null;
    } else {
      serialDownSince = data.lastHeartbeatTs || Date.now();
      banner.hidden = false;
      updateSerialSince();
    }
  });
  function updateSerialSince() {
    if (!banner || banner.hidden || !bannerSince || !serialDownSince) return;
    const secs = Math.max(0, Math.floor((Date.now() - serialDownSince) / 1000));
    const mins = Math.floor(secs / 60);
    bannerSince.textContent = mins > 0 ? `· ${mins}m ${secs % 60}s` : `· ${secs}s`;
  }
  setInterval(updateSerialSince, 1000);

  if (RACE_DATA.isActive) {
    socket.on('connect', () => socket.emit('standings:request'));

    socket.on('standings', (data) => {
      renderStandings(data);
      renderCircuitTimers(data.circuits);
      if (data.remainingMs != null) {
        if (data.elapsedMs != null) RACE_DATA.durationMs = data.remainingMs + data.elapsedMs;
        if (RACE_DATA.isPaused) {
          // Pausada: sincroniza el valor congelado sin arrancar la cuenta atrás.
          remainingMs = data.remainingMs;
          if (timerEl) timerEl.textContent = formatRemaining(remainingMs);
        } else if (!timerInt) {
          startCountdown(data.remainingMs);
        } else if (lastTickAt) {
          remainingMs = data.remainingMs;
        }
      }
    });

    socket.on('lane:on_track', ({ lane }) => {
      const card = document.getElementById(`card-${lane}`);
      if (!card || card.classList.contains('is-rest')) return;
      const existing = card.querySelector('.on-track-msg');
      if (existing) existing.remove();
      const msg = document.createElement('div');
      msg.className = 'on-track-msg';
      msg.textContent = LANG === 'es' ? 'En pista' : 'On track';
      card.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
    });

    socket.on('lap', (lap) => {
      addTick(lap);
      flashCard(lap.lane, lap.isExit);
      // Marca de tiempo del cruce, para desempatar el líder de vueltas de manga.
      if (lap.elapsedMs != null) mangaCrossMs[lap.lane] = lap.elapsedMs;

      // Pit-stop indicator next to the lane name. Stays visible once a lane
      // has had any pit-stop in the manga. If there's more than one, show
      // "+N" suffix so spectators can tell how many extra pit-stops it had.
      updatePitIndicator(lap.lane, lap.pitStopCount ?? 0);
      updateExitIndicator(lap.lane, lap.exitCount ?? 0);

      // The "fastest laps by lane" panel updates via the `standings` event
      // that fires right after this lap (server emits both back-to-back), and
      // that payload carries the race-wide best — not just this manga's best.

      // Voz según modo:
      //   off  → nunca
      //   best → solo nueva vuelta rápida del carril (skip exits y vuelta 1)
      //   all  → cada cruce no-exit
      if (!lap.isExit) {
        const isLaneBest = lap.lapNumber > 1 && lap.lapTimeMs === lap.bestLapMs;
        if (voiceMode === 'all') {
          const time = formatMsForSpeech(lap.lapTimeMs);
          const text = LANG === 'es' ? `${lap.name}, ${time}` : `${lap.name}, ${time}`;
          announce(text);
        } else if (voiceMode === 'best' && isLaneBest) {
          const time = formatMsForSpeech(lap.lapTimeMs);
          const text = LANG === 'es'
            ? `${lap.name}, vuelta rápida, ${time}`
            : `${lap.name}, fast lap, ${time}`;
          announce(text);
        }
      }
    });

    // Ghost lap discarded by Pt: TTS announcement so the race director hears it
    // y pueda revisar/corregir desde la pantalla de correcciones.
    // Avisos críticos: se anuncian aunque la voz esté en "off" (igual que
    // "Queda 1 minuto" / "Quedan 30 segundos"), por eso usan announceWarning y no
    // announce (que respeta el mute).
    socket.on('lap:ghost', ({ lane }) => {
      announceWarning(LANG === 'es' ? `Vuelta ignorada pista ${lane}` : `Lap ignored lane ${lane}`);
    });

    // Reasignación (de-merge): el cruce se IGNORA en el carril origen Y se ASIGNA
    // al destino → se anuncian los dos (la "pareja"). Un "Vuelta ignorada" suelto
    // (evento lap:ghost) es un cruce espurio que no se pudo asignar a nadie.
    socket.on('lap:reassigned', ({ fromLane, toLane }) => {
      if (fromLane != null) announceWarning(LANG === 'es' ? `Vuelta ignorada pista ${fromLane}` : `Lap ignored lane ${fromLane}`);
      announceWarning(LANG === 'es' ? `Vuelta asignada pista ${toLane}` : `Lap assigned to lane ${toLane}`);
    });

    // Retroactive crash: lap 1 turned out to be an exit once we saw lap 2.
    // No voice announcement — the UI will re-classify V1 on the next standings.
    socket.on('lap:retro_exit', () => {});

    socket.on('tick', ({ elapsedMs, circuits }) => {
      renderCircuitTimers(circuits);
      // durationMs is set from standings data; this fires only if standings was missed
      if (timerInt === null && RACE_DATA.durationMs && !RACE_DATA.isPaused) {
        startCountdown(RACE_DATA.durationMs - elapsedMs);
      }
    });

    socket.on('manga:stopped', (data) => {
      if (data?.mangaId && data.mangaId !== RACE_DATA.mangaId) return;
      RACE_DATA.isActive = false;
      if (timerInt) { clearInterval(timerInt); timerInt = null; }
      statusEl.innerHTML = `<span class="status-text status-text--finished">${LANG === 'es' ? 'Finalizada' : 'Finished'}</span>`;
      document.body.classList.add('manga-finished');
      _startSwapRotation();
      timerEl.textContent = '00:00';

      // Show next-lane indicator on each card
      if (data?.nextLanes && Object.keys(data.nextLanes).length > 0) {
        Object.entries(data.nextLanes).forEach(([cardKey, info]) => {
          const card = document.getElementById(`card-${cardKey}`);
          if (!card) return;
          const existing = card.querySelector('.next-lane-badge');
          if (existing) existing.remove();
          appendNextLaneBadge(card, info);
        });
      }

      // Tanda finished — show "Next Tanda" button if one exists
      if (data?.isTandaEnd && data.nextTandaId) {
        const actions = document.querySelector('.live-header__actions');
        if (actions && !document.getElementById('next-tanda-btn')) {
          const btn = document.createElement('button');
          btn.id        = 'next-tanda-btn';
          btn.className = 'lbtn lbtn--go';
          btn.innerHTML = LANG === 'es'
            ? `▶ Tanda ${data.nextTandaNumber}`
            : `▶ Tanda ${data.nextTandaNumber}`;
          btn.addEventListener('click', async () => {
            btn.disabled   = true;
            btn.textContent = LANG === 'es' ? 'Cargando...' : 'Loading...';
            try {
              const r = await fetch(
                `/races/${RACE_DATA.raceId}/tandas/${RACE_DATA.tandaId}/next-tanda`,
                { method: 'POST' }
              );
              const d = await r.json();
              if (d.ok) {
                location.href = `/races/${RACE_DATA.raceId}/mangas/${d.mangaId}/live`;
              }
            } catch {
              btn.disabled   = false;
              btn.textContent = LANG === 'es' ? `▶ Tanda ${data.nextTandaNumber}` : `▶ Tanda ${data.nextTandaNumber}`;
            }
          });
          actions.prepend(btn);
        }
      }

      // Refresh the page after a short delay so the server-rendered
      // "Repetir" button (which only appears when manga.status='finished')
      // is shown. The delay lets the director see the "Finalizada" badge
      // and next-lane indicators before the reload.
      setTimeout(() => location.reload(), 2000);
    });

    socket.on('manga:cancelled', (data) => {
      RACE_DATA.isActive = false;
      if (!data.mangaId || data.mangaId === RACE_DATA.mangaId) {
        location.reload();
      }
    });

    socket.on('manga:paused', () => {
      RACE_DATA.isPaused = true;
      if (timerInt) { clearInterval(timerInt); timerInt = null; }
      let ov = document.getElementById('pause-overlay');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'pause-overlay';
        ov.className = 'pause-overlay';
        ov.textContent = LANG === 'es' ? '⏸ PAUSA' : '⏸ PAUSED';
        document.body.appendChild(ov);
      }
    });

    socket.on('manga:resumed', () => {
      RACE_DATA.isPaused = false;
      document.getElementById('pause-overlay')?.remove();
      const hasSema = !!document.getElementById('semaphore-overlay');
      // Quien pulsó RESUME (AJAX) recarga tras el verde para refrescar el botón
      // (RESUME → PAUSE) y el reloj. El resto de clientes reanudan en caliente.
      if (_pendingActionReload) {
        _pendingActionReload = false;
        if (hasSema) semaphoreGo(() => location.reload());
        else location.reload();
        return;
      }
      // Reanuda la cuenta atrás (clientes que no recargan, p.ej. la vista TV).
      if (!timerInt && remainingMs > 0) startCountdown(remainingMs);
      // If the resume semaphore is on screen (lit during the 3s A6→A3 window),
      // flip it to green and dismiss — same flow as the GO countdown.
      if (hasSema) semaphoreGo(null);
    });

    // Pausa POR CIRCUITO: marca/desmarca los carriles de ese circuito (cuando
    // se pausan TODOS aparece además el overlay global via manga:paused).
    socket.on('circuit:state', ({ status, lanes }) => {
      const paused = status === 'paused';
      (lanes || []).forEach(lane => {
        const card = document.getElementById(`card-${lane}`);
        if (!card) return;
        card.classList.toggle('lane-paused', paused);
        let badge = card.querySelector('.lane-pause-badge');
        if (paused && !badge) {
          badge = document.createElement('div');
          badge.className = 'lane-pause-badge';
          badge.textContent = LANG === 'es' ? '⏸ PAUSA' : '⏸ PAUSED';
          card.appendChild(badge);
        } else if (!paused && badge) {
          badge.remove();
        }
      });
    });
  }

  socket.on('race:semaphore', () => showSemaphore());
  socket.on('race:semaphore_step', () => semaphoreStep());

  // GO / REANUDAR manual (simulación/BART): enviar por AJAX para NO recargar la
  // página, así la animación del semáforo (race:semaphore) no se pierde. El
  // arranque/reanudación real lo dispara el server al ponerse verde:
  //   GO     → manga:started  (recarga todos los clientes a la carrera)
  //   RESUME → manga:resumed  (recarga SOLO a quien pulsó, vía _pendingActionReload)
  function wireAjaxAction(formId, reloadOnDone) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      if (reloadOnDone) _pendingActionReload = true;
      try {
        await fetch(form.action, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)),
        });
        // No recargamos aquí: los eventos socket conducen la transición.
      } catch (err) {
        _pendingActionReload = false;
        location.reload();   // fallback si el fetch falla
      }
    });
  }
  wireAjaxAction('goForm', false);      // GO: manga:started ya recarga
  wireAjaxAction('resumeForm', true);   // RESUME: recargar tras el verde

  // ── Driver check-in ────────────────────────────────────────────────────────
  socket.on('driver_checkin', ({ lane, driverName }) => {
    setActiveDriver(lane, driverName);
  });

  // Navigate to next manga when DS hardware GO starts it after current finished
  socket.on('manga:started', (data) => {
    if (RACE_DATA.isActive) return;
    if (data.mangaId && data.mangaId !== RACE_DATA.mangaId) {
      semaphoreGo(() => { location.href = `/races/${RACE_DATA.raceId}/mangas/${data.mangaId}/live`; });
    } else {
      semaphoreGo(() => location.reload());
    }
  });
}

// ── Driver check-in helpers ───────────────────────────────────────────────────
function setActiveDriver(lane, driverName) {
  const el = document.getElementById(`card-driver-${lane}`);
  const card = document.getElementById(`card-${lane}`);
  const nameSpan = card ? card.querySelector('.lane-card__name') : null;

  // 1) Row dedicado (visible en V2)
  if (el) {
    if (driverName) {
      el.innerHTML = `<span class="lane-card__driver-name">👤 ${driverName}</span>`;
      el.classList.add('lane-card__driver-row--active');
    } else {
      el.innerHTML = '';
      el.classList.remove('lane-card__driver-row--active');
    }
  }

  // 2) Flip nombre equipo ↔ piloto (V1). El span se superpone al nombre y solo
  //    se ve durante la ventana body.show-driver (10s de cada 40s).
  if (nameSpan) {
    nameSpan.querySelector('.lane-card__driver-inline')?.remove();
    if (driverName) {
      const inline = document.createElement('span');
      inline.className = 'lane-card__driver-inline';
      inline.textContent = '👤 ' + driverName;
      nameSpan.appendChild(inline);
      card?.classList.add('has-driver');
    } else {
      card?.classList.remove('has-driver');
    }
  }

  // 3) Flash en la card al checkin
  if (driverName && card) {
    card.classList.add('card-checkin-flash');
    setTimeout(() => card.classList.remove('card-checkin-flash'), 800);
  }
}

// ── QR scanner input (USB reader acts as keyboard + Enter) ────────────────────
if (RACE_DATA.isTeam && RACE_DATA.hasQrCheckin) {
  const qrBuffer  = { value: '', timer: null };
  const QR_TIMEOUT = 80; // ms between keystrokes — scanner is faster than human

  document.addEventListener('keydown', e => {
    // Ignore if focus is on an interactive element (manual override inputs)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'Enter') {
      const code = qrBuffer.value.trim();
      qrBuffer.value = '';
      if (code.startsWith('DRV:')) submitQR(code);
      return;
    }

    if (e.key.length === 1) {
      qrBuffer.value += e.key;
      clearTimeout(qrBuffer.timer);
      qrBuffer.timer = setTimeout(() => { qrBuffer.value = ''; }, 500);
    }
  });

  async function submitQR(qrCode) {
    try {
      const r = await fetch(`/races/${RACE_DATA.raceId}/mangas/${RACE_DATA.mangaId}/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_code: qrCode }),
      });
      const data = await r.json();
      if (!data.ok) {
        showCheckinToast(data.error === 'driver_not_in_manga'
          ? (LANG === 'es' ? 'Piloto no asignado a esta manga' : 'Driver not in this heat')
          : (LANG === 'es' ? 'QR no reconocido' : 'Unknown QR'), 'error');
      }
    } catch { /* ignore network errors */ }
  }

  function showCheckinToast(msg, type = 'ok') {
    let toast = document.getElementById('checkin-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'checkin-toast';
      toast.style.cssText = 'position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);padding:.6rem 1.25rem;border-radius:8px;font-size:.9rem;font-weight:600;z-index:500;transition:opacity .3s;pointer-events:none';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.background = type === 'error' ? '#b91c1c' : '#166534';
    toast.style.color = '#fff';
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }
}

// ── Manual override popup ─────────────────────────────────────────────────────
if (RACE_DATA.isTeam && RACE_DATA.hasQrCheckin) {
  const lanesGrid = document.getElementById('lanesGrid');

  lanesGrid.addEventListener('click', e => {
    const card = e.target.closest('.lane-card:not(.is-rest)');
    if (!card) return;
    const lane = parseInt(card.id.replace('card-', ''));
    openManualOverride(lane);
  });

  function openManualOverride(lane) {
    const existing = document.getElementById('manual-override-popup');
    if (existing) existing.remove();

    // Get team members for this lane
    const laneData = RACE_DATA.lanes.find(l => l.lane === lane);
    if (!laneData || !laneData.teamMembers?.length) return;

    const popup = document.createElement('div');
    popup.id = 'manual-override-popup';
    popup.style.cssText = 'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center';

    const members = laneData.teamMembers.map(m =>
      `<button class="btn btn--ghost" style="width:100%;text-align:left;padding:.6rem .75rem;font-size:1rem"
               data-driver-id="${m.id}" data-driver-name="${m.name}">
         👤 ${m.name}
       </button>`
    ).join('');

    popup.innerHTML = `
      <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.25rem;min-width:260px;max-width:90vw">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
          <strong style="color:#e6edf3">${LANG === 'es' ? 'Piloto en carril' : 'Driver in lane'} ${lane}</strong>
          <button id="closeOverride" class="btn btn--ghost btn--sm">✕</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:.4rem">${members}</div>
      </div>`;

    document.body.appendChild(popup);
    popup.querySelector('#closeOverride').addEventListener('click', () => popup.remove());
    popup.addEventListener('click', e => { if (e.target === popup) popup.remove(); });

    popup.querySelectorAll('[data-driver-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const driverId   = btn.dataset.driverId;
        const driverName = btn.dataset.driverName;
        popup.remove();
        await fetch(`/races/${RACE_DATA.raceId}/mangas/${RACE_DATA.mangaId}/checkin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lane, driver_id: driverId }),
        });
        setActiveDriver(lane, driverName);
      });
    });
  }
}

// ── Toolbar: columnas visibles + zoom ─────────────────────────────────────────
(function () {
  const COLS = ['vlt', 'total', 'ultima', 'mejor', 'media', 'delta'];
  const body = document.body;
  const LS_COLS = 'slotime.live.cols';
  const LS_ZOOM = 'slotime.live.zoom';

  // Estado inicial
  let cols = {};
  try {
    const saved = JSON.parse(localStorage.getItem(LS_COLS) || '{}');
    COLS.forEach(c => { cols[c] = saved[c] !== false; });   // true por defecto
  } catch { COLS.forEach(c => { cols[c] = true; }); }

  let zoom = parseFloat(localStorage.getItem(LS_ZOOM) || '1');
  if (!isFinite(zoom) || zoom < 0.5 || zoom > 2.0) zoom = 1;

  function applyCols() {
    COLS.forEach(c => body.classList.toggle('hide-col-' + c, !cols[c]));
    document.querySelectorAll('.live-toolbar__cb').forEach(cb => {
      const k = cb.dataset.col;
      if (k && cols[k] !== undefined) cb.checked = !!cols[k];
    });
    try { localStorage.setItem(LS_COLS, JSON.stringify(cols)); } catch {}
    // Refit cards porque el ancho efectivo por columna cambia al ocultar
    if (typeof fitLaneCards === 'function') requestAnimationFrame(() => fitLaneCards());
    setTimeout(() => window.refreshLaneMarquees?.(), 50);
  }

  function applyZoom() {
    zoom = Math.max(0.5, Math.min(2.0, zoom));
    body.style.setProperty('--ln-zoom', String(zoom));
    const lbl = document.getElementById('zoomVal');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
    try { localStorage.setItem(LS_ZOOM, String(zoom)); } catch {}
    setTimeout(() => window.refreshLaneMarquees?.(), 50);
  }

  // Bind eventos
  document.querySelectorAll('.live-toolbar__cb').forEach(cb => {
    cb.addEventListener('change', () => {
      cols[cb.dataset.col] = cb.checked;
      applyCols();
    });
  });
  document.getElementById('zoomPlus') ?.addEventListener('click', () => { zoom = Math.min(2.0, Math.round((zoom + 0.1) * 10) / 10); applyZoom(); });
  document.getElementById('zoomMinus')?.addEventListener('click', () => { zoom = Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10); applyZoom(); });
  document.getElementById('zoomReset')?.addEventListener('click', () => { zoom = 1; applyZoom(); });

  applyCols();
  applyZoom();
})();

// ── Marquee automático para nombres de piloto que no caben en su columna ────
// Detecta overflow del span .lane-card__name dentro de su contenedor y activa
// la animación CSS que lo desplaza. Recalcula al cargar, al cambiar zoom y al
// redimensionar la ventana.
(function () {
  function refreshMarquees() {
    document.querySelectorAll('.lane-card__name').forEach(el => {
      const container = el.parentElement;
      if (!container) return;
      // Quitamos el flag para medir el ancho real
      el.classList.remove('lane-card__name--overflow');
      el.style.removeProperty('--lane-name-shift');
      // El name-row es display:contents (mide 0): si el contenedor no tiene
      // caja, medimos contra el propio span (su ancho flex/grid asignado).
      const boxW = container.clientWidth > 0 ? container.clientWidth : el.clientWidth;
      const overflow = el.scrollWidth - boxW;
      if (overflow > 4) {
        // shift = -(overflow + un pequeño margen para que se vea el final)
        const shiftPx = -(overflow + 8);
        el.style.setProperty('--lane-name-shift', shiftPx + 'px');
        el.classList.add('lane-card__name--overflow');
      }
    });
  }
  // Expone globalmente por si lo necesita otro código
  window.refreshLaneMarquees = refreshMarquees;

  // Recalcula tras cualquier cambio relevante
  window.addEventListener('resize', refreshMarquees);
  // Inicial — defer para que el layout esté calculado
  requestAnimationFrame(() => requestAnimationFrame(refreshMarquees));
})();
