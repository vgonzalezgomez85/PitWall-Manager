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
// Bandera del país (country = "Nombre|🇪🇸" o "Nombre|__SVG__").
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
  const totalSec = Math.floor(ms / 1000);
  const millis   = Math.floor(ms % 1000);
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  return `${mins > 0 ? mins + ':' : ''}${String(secs).padStart(mins > 0 ? 2 : 1, '0')}.${String(millis).padStart(3, '0')}`;
}

function formatMsForSpeech(ms) {
  if (ms == null) return '';
  const totalSec   = Math.floor(ms / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  const hStr = String(hundredths).padStart(2, '0');
  if (mins > 0) return `${mins}:${String(secs).padStart(2,'0')}.${hStr}`;
  return LANG === 'es' ? `${secs} con ${hStr}` : `${secs} ${hStr}`;
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

// ── Timer (countdown if duration known, elapsed otherwise) ────────────────────
const timerEl  = document.getElementById('trainingTimer');
let durationMs = TRAINING_DATA.durationMs || 0;
let elapsedMs  = TRAINING_DATA.startedAt ? Date.now() - TRAINING_DATA.startedAt : 0;
let standby    = TRAINING_DATA.standby || false;
let heatNumber = TRAINING_DATA.heatNumber || null;
let paused     = TRAINING_DATA.isPaused || false;   // pausa manual (BART/sim) → congela el reloj
let _trPendingReload = false;                        // recargar tras activar (quien pulsó GO/RESUME)

let warned60 = false;
let warned30 = false;

function announceWarning(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG === 'es' ? 'es-ES' : 'en-US';
  u.rate = 1;
  speechSynthesis.speak(u);
}

function updateTimer() {
  if (standby) { timerEl.textContent = '--:--'; return; }
  if (durationMs > 0) {
    const remaining = Math.max(0, durationMs - elapsedMs);
    timerEl.textContent = formatElapsed(remaining);
    if (!warned60 && remaining > 0 && remaining <= 60000) {
      warned60 = true;
      announceWarning(LANG === 'es' ? 'Queda 1 minuto' : 'One minute remaining');
    }
    if (!warned30 && remaining > 0 && remaining <= 30000) {
      warned30 = true;
      announceWarning(LANG === 'es' ? 'Quedan 30 segundos' : '30 seconds remaining');
    }
  } else {
    timerEl.textContent = formatElapsed(elapsedMs);
  }
}

updateTimer();
setInterval(() => {
  if (standby || paused) return;            // pausa manual → reloj congelado
  // No descontar mientras el semáforo (overlay) está visible — la cuenta atrás
  // empieza justo cuando desaparecen las luces verdes.
  if (document.getElementById('semaphore-overlay')) return;
  elapsedMs += 250;
  updateTimer();
}, 250);

// ── BART/sim: GO y REANUDAR por AJAX para que no se pierda el semáforo en la
//    recarga. El server activa al ponerse verde; recargamos para refrescar los
//    botones (GO→PAUSE/STOP). PAUSE y STOP van por POST normal (recargan solos).
function wireTrAjax(id) {
  const f = document.getElementById(id);
  if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
    _trPendingReload = true;
    try {
      await fetch(f.action, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(f)),
      });
    } catch (err) { _trPendingReload = false; location.reload(); }
  });
}
wireTrAjax('trGoForm');
wireTrAjax('trResumeForm');

// ── Duración del GO: recordar la última usada (localStorage) para no tener
//    que volver a teclearla cada vez (por defecto sale "10" siempre) ────────
const TR_DURATION_KEY = 'pitwall.training.duration_min';
(function restoreDurationInput() {
  const inp = document.querySelector('#trGoForm input[name="duration_minutes"]');
  if (!inp) return;
  try {
    const saved = localStorage.getItem(TR_DURATION_KEY);
    if (saved) inp.value = saved;
  } catch {}
})();
document.getElementById('trGoForm')?.addEventListener('submit', () => {
  const inp = document.querySelector('#trGoForm input[name="duration_minutes"]');
  if (inp && inp.value) { try { localStorage.setItem(TR_DURATION_KEY, inp.value); } catch {} }
});

function setStandby(isStandby) {
  standby = isStandby;
  const statusEl = document.getElementById('tr-status');
  if (statusEl) {
    statusEl.innerHTML = isStandby
      ? `<span class="tr-standby-badge">${LANG === 'es' ? 'Esperando GO…' : 'Waiting for GO…'}</span>`
      : `${TRAINING_DATA.lanes.length} ${LANG === 'es' ? 'carriles activos' : 'active lanes'}`;
  }
  updateTimer();
}

// ── Lane cards ────────────────────────────────────────────────────────────────
const grid  = document.getElementById('trainingGrid');
const TXT = LANG === 'es'
  ? { laps: 'vlt', best: 'Mejor', avg: 'Media', rec: 'Récord', pace: 'Ritmo', noPace: 'Sin vueltas aún', lap: 'Vuelta', isBest: 'Mejor vuelta' }
  : { laps: 'lps', best: 'Best',  avg: 'Avg',   rec: 'Record', pace: 'Pace',  noPace: 'No laps yet',     lap: 'Lap',    isBest: 'Best lap' };

// Último estado recibido por carril (para repintar el gráfico al redimensionar).
const laneState = new Map();

// Texto legible encima del color del carril (los colores son personalizables).
function laneInk(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const lin = (i) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return (0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4)) > 0.4 ? '#000' : '#fff';
}

function buildCard(lane) {
  const card = document.createElement('div');
  card.className = 'tr-card';
  card.id = `tr-card-${lane.lane}`;
  card.style.setProperty('--card-color', lane.color);
  card.style.setProperty('--card-ink', laneInk(lane.color));
  card.innerHTML = `
    <div class="tr-card__header">
      <span class="tr-card__lane-num">${lane.lane}</span>
      <span class="tr-card__name" id="tr-name-${lane.lane}">${lane.participantName ? flagHtml(lane.country) + lane.participantName : ''}</span>
      <span class="tr-card__count" id="tr-count-${lane.lane}">${lane.count} ${TXT.laps}</span>
    </div>
    <div class="tr-card__last">
      <div class="tr-card__best" id="tr-best-${lane.lane}">${formatMs(lane.lastMs)}</div>
      <div class="tr-card__delta" id="tr-delta-${lane.lane}"></div>
    </div>
    <div class="tr-card__stats">
      <div class="tr-stat tr-stat--best"><span class="tr-stat__lbl">${TXT.best}</span><span class="tr-stat__val" id="tr-record-${lane.lane}">${formatMs(lane.bestMs)}</span></div>
      <div class="tr-stat tr-stat--avg"><span class="tr-stat__lbl">${TXT.avg}</span><span class="tr-stat__val" id="tr-avg-${lane.lane}">${formatMs(lane.avgMs)}</span></div>
      <div class="tr-stat tr-stat--rec" id="tr-srec-${lane.lane}"><span class="tr-stat__lbl">${TXT.rec}</span><span class="tr-stat__val" id="tr-srec-time-${lane.lane}">${sessionRecords[lane.lane] ? formatMs(sessionRecords[lane.lane]) : '—'}</span></div>
    </div>
    <div class="tr-card__laps" id="tr-laps-${lane.lane}"></div>
    <div class="tr-pace" id="tr-pace-${lane.lane}" aria-label="${TXT.pace}">
      <span class="tr-pace__lbl">${TXT.pace}</span>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"></svg>
      <div class="tr-pace__tip" hidden></div>
    </div>`;
  wirePace(card.querySelector('.tr-pace'), lane.lane);
  return card;
}

// Solo las 10 últimas, la más reciente arriba, con su número de vuelta delante.
// `laps` llega de más nueva a más vieja; `count` es el total del carril.
const TR_HISTORY_MAX = 10;
function renderLapList(laps, count, bestMs) {
  if (!laps || laps.length === 0) return `<div class="tr-lap-empty">—</div>`;
  const total = count || laps.length;
  return laps.slice(0, TR_HISTORY_MAX).map((ms, i) => {
    const isBest = bestMs != null && ms === bestMs;
    return `<div class="tr-lap-item${isBest ? ' tr-lap-item--best' : ''}"${isBest ? ` title="${TXT.isBest}"` : ''}>`
      + `<span class="tr-lap-n">${total - i}</span><span class="tr-lap-t">${formatMs(ms)}</span></div>`;
  }).join('');
}

// ── Gráfico de ritmo ─────────────────────────────────────────────────────────
// Línea de tiempos de vuelta (arriba = más rápido), con la mejor y la media de
// referencia. El eje se recorta a mediana × 1,6 para que una salida de pista
// no aplaste el resto de la línea.
function paceSeries(st) {
  const pace = (st && Array.isArray(st.pace) && st.pace.length) ? st.pace
             : (st && Array.isArray(st.laps) ? [...st.laps].reverse() : []);
  return pace;
}
function paceScale(pace) {
  const sorted = [...pace].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const lo = sorted[0];
  const hi = Math.min(sorted[sorted.length - 1], med * 1.6);
  const pad = Math.max((hi - lo) * 0.12, 30);
  return { lo: lo - pad, hi: hi + pad };
}
function drawPace(laneNum) {
  const box = document.getElementById(`tr-pace-${laneNum}`);
  if (!box) return;
  const svg = box.querySelector('svg');
  const st = laneState.get(laneNum);
  const pace = paceSeries(st);
  box._series = pace;
  const empty = box.querySelector('.tr-pace__empty');
  if (pace.length < 2) {
    svg.innerHTML = '';
    if (!empty) box.insertAdjacentHTML('beforeend', `<div class="tr-pace__empty">${TXT.noPace}</div>`);
    return;
  }
  if (empty) empty.remove();
  const { lo, hi } = paceScale(pace);
  box._scale = { lo, hi };
  const n = pace.length;
  const x = (i) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (ms) => {
    const v = Math.min(Math.max(ms, lo), hi);
    return 6 + ((v - lo) / (hi - lo)) * 88;   // más lento = más abajo
  };
  const pts = pace.map((ms, i) => `${x(i).toFixed(2)},${y(ms).toFixed(2)}`).join(' ');
  const best = st.bestMs, avg = st.avgMs;
  let h = `<polygon class="tr-pace__area" points="0,100 ${pts} 100,100"></polygon>`;
  if (avg != null) h += `<line class="tr-pace__avg" x1="0" x2="100" y1="${y(avg)}" y2="${y(avg)}"></line>`;
  if (best != null) h += `<line class="tr-pace__best" x1="0" x2="100" y1="${y(best)}" y2="${y(best)}"></line>`;
  h += `<polyline class="tr-pace__line" points="${pts}"></polyline>`;
  h += `<line class="tr-pace__cursor" x1="0" x2="0" y1="0" y2="100" visibility="hidden"></line>`;
  svg.innerHTML = h;
  if (box._hoverIdx != null) showPaceAt(box, laneNum, box._hoverIdx);
}
function showPaceAt(box, laneNum, idx) {
  const pace = box._series || [];
  const tip = box.querySelector('.tr-pace__tip');
  const cur = box.querySelector('.tr-pace__cursor');
  if (!pace.length || idx == null || !cur) { tip.hidden = true; return; }
  idx = Math.max(0, Math.min(pace.length - 1, idx));
  box._hoverIdx = idx;
  const st = laneState.get(laneNum) || {};
  const xPct = pace.length === 1 ? 50 : (idx / (pace.length - 1)) * 100;
  cur.setAttribute('x1', xPct); cur.setAttribute('x2', xPct);
  cur.setAttribute('visibility', 'visible');
  const lapNo = (st.count || pace.length) - (pace.length - 1 - idx);
  const ms = pace[idx];
  const diff = st.bestMs != null ? ms - st.bestMs : null;
  tip.textContent = `${TXT.lap} ${lapNo} · ${formatMs(ms)}` + (diff != null && diff > 0 ? ` (+${(diff / 1000).toFixed(3)})` : '');
  tip.style.left = `clamp(40px, ${xPct}%, calc(100% - 40px))`;
  tip.hidden = false;
}
function wirePace(box, laneNum) {
  const at = (e) => {
    const pace = box._series || [];
    if (pace.length < 2) return null;
    const r = box.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.round(f * (pace.length - 1));
  };
  box.addEventListener('pointermove', (e) => showPaceAt(box, laneNum, at(e)));
  box.addEventListener('pointerdown', (e) => showPaceAt(box, laneNum, at(e)));
  box.addEventListener('pointerleave', () => {
    box._hoverIdx = null;
    box.querySelector('.tr-pace__tip').hidden = true;
    const cur = box.querySelector('.tr-pace__cursor');
    if (cur) cur.setAttribute('visibility', 'hidden');
  });
}

// Color condicional para la última vuelta (mismo criterio que en carreras):
// verde si ≤ mejor, blanco si ≤ media, ámbar si ≤ mejor*1.05, rojo en otro caso.
function ultColorMs(lastMs, bestMs, avgMs) {
  if (lastMs == null || bestMs == null) return null;
  if (lastMs <= bestMs + 1)             return 'green';
  if (avgMs != null && lastMs <= avgMs) return 'white';
  if (lastMs <= bestMs * 1.05)          return 'amber';
  return 'red';
}
function applyLvColor(el, color) {
  if (!el) return;
  el.classList.remove('lv-color-green', 'lv-color-white', 'lv-color-amber', 'lv-color-red');
  if (color) el.classList.add('lv-color-' + color);
}

function updateCard(data) {
  // Carril vaciado (GO tras fin de tanda): no arrastrar la última vuelta vieja.
  const prev = data.count === 0 ? {} : (laneState.get(data.lane) || {});
  const st = { ...prev, ...data };
  laneState.set(data.lane, st);
  const countEl  = document.getElementById(`tr-count-${data.lane}`);
  const bestEl   = document.getElementById(`tr-best-${data.lane}`);
  const deltaEl  = document.getElementById(`tr-delta-${data.lane}`);
  const avgEl    = document.getElementById(`tr-avg-${data.lane}`);
  const lapsEl   = document.getElementById(`tr-laps-${data.lane}`);
  const recordEl = document.getElementById(`tr-record-${data.lane}`);
  if (countEl) countEl.textContent = `${st.count || 0} ${TXT.laps}`;
  const lastMs = st.lastMs ?? st.lapTimeMs;
  if (bestEl) {
    bestEl.textContent = formatMs(lastMs);
    applyLvColor(bestEl, ultColorMs(lastMs, st.bestMs, st.avgMs));
  }
  if (deltaEl) {
    const d = (lastMs != null && st.bestMs != null) ? lastMs - st.bestMs : null;
    deltaEl.classList.toggle('is-best', d != null && d <= 1);
    deltaEl.textContent = d == null ? '' : (d <= 1 ? TXT.isBest : `+${(d / 1000).toFixed(3)}`);
  }
  if (avgEl)    avgEl.textContent    = formatMs(st.avgMs);
  if (recordEl) recordEl.textContent = formatMs(st.bestMs);
  if (lapsEl)   lapsEl.innerHTML     = renderLapList(st.laps, st.count, st.bestMs);
  drawPace(data.lane);
}

// Renombrado slotime.* → pitwall.* de las claves de localStorage: si el
// navegador trae un valor guardado con el nombre antiguo y aún no hay uno
// nuevo, se copia para no perder la preferencia del usuario.
function _lsMigrate(oldKey, newKey) {
  try {
    if (localStorage.getItem(newKey) === null) {
      const v = localStorage.getItem(oldKey);
      if (v !== null) localStorage.setItem(newKey, v);
    }
  } catch {}
}

// ── View picker (modal) — 2 modos: historial (default) / compacta ─────────
const TR_VIEW_KEY = 'pitwall.training.view';
_lsMigrate('slotime.training.view', TR_VIEW_KEY);
function openTrainingPicker() {
  const ov = document.getElementById('trainingPickerOverlay');
  if (!ov) return;
  ov.hidden = false;
  const current = localStorage.getItem(TR_VIEW_KEY) || 'history';
  ov.querySelectorAll('.vp-opt').forEach(b => {
    b.classList.toggle('is-active', b.dataset.mode === current);
  });
}
function closeTrainingPicker() {
  const ov = document.getElementById('trainingPickerOverlay');
  if (ov) ov.hidden = true;
}
function selectTrainingView(mode) {
  const grid = document.getElementById('trainingGrid');
  if (!grid) return;
  grid.classList.toggle('training-grid--compact', mode === 'compact');
  try { localStorage.setItem(TR_VIEW_KEY, mode); } catch {}
  closeTrainingPicker();
}
// Restaurar elección guardada. Si no hay preferencia y hay muchos carriles,
// arrancar en compacta para que entren bien (la vista con historial requiere
// alto por tarjeta y se queda corta a partir de ~16 carriles).
(function _initTrainingPicker() {
  const saved = localStorage.getItem(TR_VIEW_KEY);
  if (saved) {
    selectTrainingView(saved);
  } else {
    const laneCount = (TRAINING_DATA?.lanes || []).length;
    if (laneCount >= 16) selectTrainingView('compact');
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeTrainingPicker();
  });
})();

function flashCard(laneNum) {
  const el = document.getElementById(`tr-card-${laneNum}`);
  if (!el) return;
  el.classList.remove('tr-flash');
  void el.offsetWidth;
  el.classList.add('tr-flash');
}

// ── Session records ───────────────────────────────────────────────────────────
let sessionRecords = { ...TRAINING_DATA.sessionRecords };

// ── Initialize cards ──────────────────────────────────────────────────────────
TRAINING_DATA.lanes.forEach(lane => { grid.appendChild(buildCard(lane)); updateCard(lane); });

// Vista por defecto: ahora la maneja el picker (historial / compacta). No
// añadimos clases extra en init.

let _paceResizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(_paceResizeT);
  _paceResizeT = setTimeout(() => laneState.forEach((_, lane) => drawPace(lane)), 150);
});

// ── Pantalla completa (igual que el directo: en la app de escritorio, la de
//    la ventana, que sobrevive a las recargas del semáforo y del fin) ─────────
function toggleTrFullscreen() {
  const nativeFs = window.pitwallWindow;
  if (nativeFs) {
    nativeFs.isFullScreen().then(on => nativeFs.setFullScreen(!on)).catch(() => {});
    return;
  }
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
}

// ── Voice announcements ───────────────────────────────────────────────────────
const speechQueue = [];
let   speechBusy  = false;

// Modos: 'all' = canta cada cruce (default), 'best' = solo cuando es nueva
// vuelta rápida de la tanda actual, 'off' = silenciado.
const VOICE_KEY = 'pitwall.training.voiceMode';
_lsMigrate('slotime.training.voiceMode', VOICE_KEY);
const VOICE_MODES = ['all', 'best', 'off'];
// Default: en competición arranca silenciado (hay muchos pilotos y cantar
// todo es ruido); en libre arranca con todas las vueltas.
const _isCompetition = !!(window.TRAINING_DATA && TRAINING_DATA.isCompetition);
let voiceMode = localStorage.getItem(VOICE_KEY) || (_isCompetition ? 'off' : 'all');

function voiceLabel() {
  const isES = LANG === 'es';
  if (voiceMode === 'off')  return isES ? 'Sin voz'  : 'No voice';
  if (voiceMode === 'best') return isES ? 'Rápidas'  : 'Fast';
  return                              isES ? 'Todas'    : 'All';
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
  const lbl = document.getElementById('voiceLbl');
  if (lbl) lbl.textContent = voiceLabel(); else btn.textContent = voiceLabel();
  btn.title = voiceTitle();
  btn.classList.toggle('lbtn--voice-off',  voiceMode === 'off');
  btn.classList.toggle('lbtn--voice-best', voiceMode === 'best');
}
function toggleVoice() {
  const idx = VOICE_MODES.indexOf(voiceMode);
  voiceMode = VOICE_MODES[(idx + 1) % VOICE_MODES.length];
  try { localStorage.setItem(VOICE_KEY, voiceMode); } catch {}
  if (voiceMode === 'off') {
    speechQueue.length = 0;
    window.speechSynthesis?.cancel();
    speechBusy = false;
  }
  refreshVoiceBtn();
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
// Inicializa icono/título al cargar
refreshVoiceBtn();

// ── Semaphore ─────────────────────────────────────────────────────────────
// La lógica del semáforo (showSemaphore/semaphoreStep/semaphoreGo + beeps)
// está en /js/semaphore.js. La vista debe cargarlo ANTES de training.js.

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => socket.emit('training:request'));
socket.on('race:semaphore', () => showSemaphore());
socket.on('race:semaphore_step', () => semaphoreStep());
socket.on('training:autostart', () => {
  semaphoreGo();
  if (_trPendingReload) { _trPendingReload = false; setTimeout(() => location.reload(), 500); }
});

// Pausa/reanudación manual (BART/sim): congela/reactiva el reloj y refresca botones.
socket.on('training:paused', () => { paused = true; });
socket.on('training:resumed', () => {
  paused = false;
  if (document.getElementById('semaphore-overlay')) semaphoreGo(null);
  if (_trPendingReload) { _trPendingReload = false; setTimeout(() => location.reload(), 500); }
});

// Pausa POR CIRCUITO (multi-DS): atenúa los carriles del circuito pausado.
socket.on('training:circuit_state', ({ status, lanes }) => {
  const paused = status === 'paused';
  // Al reanudar un circuito, cierra el semáforo de resume si sigue en pantalla
  // (en training no hay manga:resumed que lo cierre como en carrera).
  if (!paused && document.getElementById('semaphore-overlay')) semaphoreGo(null);
  (lanes || []).forEach(lane => {
    const card = document.getElementById(`tr-card-${lane}`);
    if (!card) return;
    card.classList.toggle('tr-card--paused', paused);
    let badge = card.querySelector('.tr-pause-badge');
    if (paused && !badge) {
      badge = document.createElement('div');
      badge.className = 'tr-pause-badge';
      badge.textContent = LANG === 'es' ? 'PAUSA' : 'PAUSED';
      card.appendChild(badge);
    } else if (!paused && badge) {
      badge.remove();
    }
  });
});

socket.on('training:data', (lanes) => {
  lanes.forEach(lane => updateCard(lane));
});

socket.on('training:lap', (data) => {
  updateCard(data);
  flashCard(data.lane);

  // ¿Es nueva vuelta rápida del carril en esta tanda? data.bestMs es la
  // mejor del carril tras incluir este cruce, así que si la última vuelta
  // coincide con ella → es la nueva mejor del carril.
  const isLaneBest = data.bestMs != null && data.lapTimeMs <= data.bestMs;

  // Cantar según modo de voz
  if (voiceMode === 'off') return;
  if (voiceMode === 'best' && !isLaneBest) return;

  const time = formatMsForSpeech(data.lapTimeMs);
  const prefix = voiceMode === 'best' && isLaneBest
    ? (LANG === 'es' ? 'Vuelta rápida, ' : 'Fast lap, ')
    : '';
  const text = LANG === 'es'
    ? `${prefix}carril ${data.lane}, ${time}`
    : `${prefix}lane ${data.lane}, ${time}`;
  announce(text);
});

socket.on('training:activated', (lanes) => {
  elapsedMs = 0;
  warned60 = false;
  warned30 = false;
  setStandby(false);
  lanes.forEach(lane => updateCard(lane));
});

socket.on('training:standby', (lanes) => {
  // Transición activo → standby SIN que el usuario haya enviado un form (fin
  // automático por tiempo, tanda de competición que rota sola…): los botones
  // GO/Pausa/STOP son server-side y solo se refrescan con un reload — igual
  // que ya hace GO/RESUME más abajo (_trPendingReload). Sin esto el panel se
  // queda con Pausa/STOP aunque el servidor ya esté en standby.
  const wasActive = !standby;
  durationMs = 0;
  elapsedMs  = 0;
  setStandby(true);
  lanes.forEach(lane => updateCard(lane));
  if (wasActive) setTimeout(() => location.reload(), 500);
});

socket.on('training:record', ({ lane, recordMs }) => {
  sessionRecords[lane] = recordMs;
  const timeEl = document.getElementById(`tr-srec-time-${lane}`);
  if (timeEl) timeEl.textContent = formatMs(recordMs);
  const cardEl = document.getElementById(`tr-card-${lane}`);
  if (cardEl) {
    cardEl.classList.add('tr-record-flash');
    setTimeout(() => cardEl.classList.remove('tr-record-flash'), 1500);
  }
});

socket.on('training:records_reset', () => {
  sessionRecords = {};
  document.querySelectorAll('[id^="tr-srec-time-"]').forEach(el => el.textContent = '—');
});

socket.on('training:go', ({ durationMs: ms }) => {
  durationMs = ms;
  elapsedMs  = 0;
  updateTimer();
});

socket.on('competition:heat', ({ heat, resting }) => {
  heatNumber = heat;
  const statusEl = document.getElementById('tr-status');
  if (statusEl && heat) {
    const heatLabel = LANG === 'es' ? `Tanda ${heat}` : `Heat ${heat}`;
    const sub = statusEl.querySelector('.tr-standby-badge');
    if (sub) sub.textContent = `${heatLabel} — ${LANG === 'es' ? 'Esperando GO…' : 'Waiting for GO…'}`;
  }
  renderRestingBar(resting || []);
});

function renderRestingBar(resting) {
  const bar = document.getElementById('restingBar');
  const items = document.getElementById('restingItems');
  if (!bar || !items) return;
  if (!resting || resting.length === 0) {
    bar.style.display = 'none';
    items.innerHTML = '';
    return;
  }
  bar.style.display = '';
  items.innerHTML = resting.map(r => `
    <div class="resting-chip">
      <span class="resting-chip__num">DSC${r.restNum}</span>
      <span class="resting-chip__dot" style="background:${r.color}"></span>
      <span class="resting-chip__name">${flagHtml(r.country)}${r.name}</span>
    </div>
  `).join('');
}

socket.on('training:stopped', () => {
  location.href = TRAINING_DATA.isCompetition ? '/training/competition' : '/training';
});
