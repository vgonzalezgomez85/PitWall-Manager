// ── Helpers ───────────────────────────────────────────────────────────────────
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
  if (standby) return;
  // No descontar mientras el semáforo (overlay) está visible — la cuenta atrás
  // empieza justo cuando desaparecen las luces verdes.
  if (document.getElementById('semaphore-overlay')) return;
  elapsedMs += 250;
  updateTimer();
}, 250);

function setStandby(isStandby) {
  standby = isStandby;
  const statusEl = document.getElementById('tr-status');
  if (statusEl) {
    statusEl.innerHTML = isStandby
      ? `<span class="tr-standby-badge">${LANG === 'es' ? '⏳ Esperando GO…' : '⏳ Waiting for GO…'}</span>`
      : `${TRAINING_DATA.lanes.length} ${LANG === 'es' ? 'carriles activos' : 'active lanes'}`;
  }
  updateTimer();
}

// ── Lane cards ────────────────────────────────────────────────────────────────
const grid  = document.getElementById('trainingGrid');
const laneLabel = '';

function buildCard(lane) {
  const card = document.createElement('div');
  card.className = 'tr-card';
  card.id = `tr-card-${lane.lane}`;
  card.style.setProperty('--card-color', lane.color);
  card.innerHTML = `
    <div class="tr-card__header">
      <span class="tr-card__label"><span class="tr-card__lane-num">${lane.lane}</span></span>
      <span class="tr-card__count" id="tr-count-${lane.lane}">
        ${lane.count} ${LANG === 'es' ? 'vlt' : 'lps'}
      </span>
    </div>
    ${lane.participantName ? `<div class="tr-card__name" id="tr-name-${lane.lane}">${lane.participantName}</div>` : ''}
    <div class="tr-card__session-record" id="tr-srec-${lane.lane}">
      <span class="tr-srec-label">🏆 ${LANG === 'es' ? 'Récord carril' : 'Lane record'}</span>
      <span class="tr-srec-time" id="tr-srec-time-${lane.lane}">${sessionRecords[lane.lane] ? formatMs(sessionRecords[lane.lane]) : '—'}</span>
    </div>
    <div class="tr-card__best" id="tr-best-${lane.lane}">${formatMs(lane.lastMs)}</div>
    <div class="tr-card__avg-row">
      <div class="tr-card__avg-cell">
        <span class="tr-card__avg-label">${LANG === 'es' ? 'Media' : 'Avg'}</span>
        <span class="tr-card__avg-val" id="tr-avg-${lane.lane}">${formatMs(lane.avgMs)}</span>
      </div>
      <div class="tr-card__avg-cell">
        <span class="tr-card__avg-label">${LANG === 'es' ? 'Mejor' : 'Best'}</span>
        <span class="tr-card__avg-val" id="tr-record-${lane.lane}" style="color:var(--card-color)">${formatMs(lane.bestMs)}</span>
      </div>
    </div>
    <div class="tr-card__divider"></div>
    <div class="tr-card__laps" id="tr-laps-${lane.lane}">
      ${renderLapList(lane.laps)}
    </div>`;
  return card;
}

const TR_HISTORY_MAX = 20;
function renderLapList(laps) {
  if (!laps || laps.length === 0) return `<div class="tr-lap-empty">—</div>`;
  const best = Math.min(...laps);
  // Solo las últimas TR_HISTORY_MAX vueltas (la mejor sigue resaltada si
  // entra en la ventana visible).
  const recent = laps.slice(-TR_HISTORY_MAX);
  return recent.map(ms =>
    `<div class="tr-lap-item${ms === best ? ' tr-lap-item--best' : ''}">${formatMs(ms)}</div>`
  ).join('');
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
  const countEl = document.getElementById(`tr-count-${data.lane}`);
  const bestEl  = document.getElementById(`tr-best-${data.lane}`);
  const avgEl   = document.getElementById(`tr-avg-${data.lane}`);
  const lapsEl  = document.getElementById(`tr-laps-${data.lane}`);
  const recordEl = document.getElementById(`tr-record-${data.lane}`);
  if (countEl)  countEl.textContent  = `${data.count} ${LANG === 'es' ? 'vlt' : 'lps'}`;
  const lastMs = data.lastMs ?? data.lapTimeMs;
  if (bestEl) {
    bestEl.textContent = formatMs(lastMs);
    applyLvColor(bestEl, ultColorMs(lastMs, data.bestMs, data.avgMs));
  }
  if (avgEl)    avgEl.textContent    = formatMs(data.avgMs);
  if (recordEl) recordEl.textContent = formatMs(data.bestMs);
  if (lapsEl)   lapsEl.innerHTML     = renderLapList(data.laps);
}

// ── View picker (modal) — 2 modos: historial (default) / compacta ─────────
const TR_VIEW_KEY = 'slotime.training.view';
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
TRAINING_DATA.lanes.forEach(lane => grid.appendChild(buildCard(lane)));

// Vista por defecto: ahora la maneja el picker (historial / compacta). No
// añadimos clases extra en init.

// ── Voice announcements ───────────────────────────────────────────────────────
const speechQueue = [];
let   speechBusy  = false;

// Modos: 'all' = canta cada cruce (default), 'best' = solo cuando es nueva
// vuelta rápida de la tanda actual, 'off' = silenciado.
const VOICE_KEY = 'slotime.training.voiceMode';
const VOICE_MODES = ['all', 'best', 'off'];
// Default: en competición arranca silenciado (hay muchos pilotos y cantar
// todo es ruido); en libre arranca con todas las vueltas.
const _isCompetition = !!(window.TRAINING_DATA && TRAINING_DATA.isCompetition);
let voiceMode = localStorage.getItem(VOICE_KEY) || (_isCompetition ? 'off' : 'all');

function voiceLabel() {
  const isES = LANG === 'es';
  if (voiceMode === 'off')  return isES ? '🔇 Sin voz'      : '🔇 No voice';
  if (voiceMode === 'best') return isES ? '⚡ Sólo rápidas'  : '⚡ Fast only';
  return                              isES ? '🔊 Todas'        : '🔊 All';
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
  btn.textContent = voiceLabel();
  btn.title       = voiceTitle();
  btn.classList.toggle('tr-btn--voice-off',  voiceMode === 'off');
  btn.classList.toggle('tr-btn--voice-best', voiceMode === 'best');
  btn.classList.toggle('tr-btn--voice-all',  voiceMode === 'all');
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

// ── Semaphore ─────────────────────────────────────────────────────────────────
let _semaphoreL2Timer = null;
let _semaphoreL3Timer = null;
let _semaphoreStartedAt = 0;
const SEMAPHORE_TOTAL_MS = 3000;
function showSemaphore() {
  if (document.getElementById('semaphore-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'semaphore-overlay';
  ov.className = 'semaphore-overlay';
  ov.innerHTML = `<div class="semaphore-panel">${[1,2,3].map(i =>
    `<div class="s-light" id="sl${i}"></div>`).join('')}</div>`;
  document.body.appendChild(ov);
  _semaphoreStartedAt = Date.now();
  // Secuencia DS-300:
  //   A1 (t=0)    → roja 1
  //   t=833       → roja 2
  //   t=1666      → roja 3
  //   A2 (t=2500) → todas → verde
  //   A3 (t=2953) → overlay desaparece a t=3000ms (50ms de verde extra)
  document.getElementById('sl1')?.classList.add('lit');
  _semaphoreL2Timer = setTimeout(() => document.getElementById('sl2')?.classList.add('lit'), 833);
  _semaphoreL3Timer = setTimeout(() => document.getElementById('sl3')?.classList.add('lit'), 1666);
}
function semaphoreStep() {
  if (_semaphoreL2Timer) { clearTimeout(_semaphoreL2Timer); _semaphoreL2Timer = null; }
  if (_semaphoreL3Timer) { clearTimeout(_semaphoreL3Timer); _semaphoreL3Timer = null; }
  [1,2,3].forEach(n => {
    const el = document.getElementById(`sl${n}`);
    if (!el) return;
    el.classList.remove('lit');
    el.classList.add('go');
  });
}
function semaphoreGo() {
  const ov = document.getElementById('semaphore-overlay');
  if (!ov) return;
  if (_semaphoreL2Timer) { clearTimeout(_semaphoreL2Timer); _semaphoreL2Timer = null; }
  if (_semaphoreL3Timer) { clearTimeout(_semaphoreL3Timer); _semaphoreL3Timer = null; }
  // Si A2 no llegó (firmware antiguo), forzamos verde antes de quitar.
  [1,2,3].forEach(n => {
    const el = document.getElementById(`sl${n}`);
    if (!el) return;
    el.classList.remove('lit');
    el.classList.add('go');
  });
  const elapsed = Date.now() - _semaphoreStartedAt;
  const wait = Math.max(0, SEMAPHORE_TOTAL_MS - elapsed);
  setTimeout(() => ov.remove(), wait);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => socket.emit('training:request'));
socket.on('race:semaphore', () => showSemaphore());
socket.on('race:semaphore_step', () => semaphoreStep());
socket.on('training:autostart', () => semaphoreGo());

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
  durationMs = 0;
  elapsedMs  = 0;
  setStandby(true);
  lanes.forEach(lane => updateCard(lane));
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
    if (sub) sub.textContent = `⏳ ${heatLabel} — ${LANG === 'es' ? 'Esperando GO…' : 'Waiting for GO…'}`;
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
      <span class="resting-chip__name">${r.name}</span>
    </div>
  `).join('');
}

socket.on('training:stopped', () => {
  location.href = TRAINING_DATA.isCompetition ? '/training/competition' : '/training';
});
