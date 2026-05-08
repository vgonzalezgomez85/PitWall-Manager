// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMs(ms) {
  if (ms == null) return '—';
  const totalSec   = Math.floor(ms / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  return `${mins > 0 ? mins + ':' : ''}${String(secs).padStart(mins > 0 ? 2 : 1, '0')}.${String(hundredths).padStart(2, '0')}`;
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

// ── Elapsed timer ─────────────────────────────────────────────────────────────
const timerEl = document.getElementById('trainingTimer');
let elapsedMs = TRAINING_DATA.startedAt ? Date.now() - TRAINING_DATA.startedAt : 0;
timerEl.textContent = formatElapsed(elapsedMs);
setInterval(() => {
  elapsedMs += 250;
  timerEl.textContent = formatElapsed(elapsedMs);
}, 250);

// ── Lane cards ────────────────────────────────────────────────────────────────
const grid  = document.getElementById('trainingGrid');
const laneLabel = LANG === 'es' ? 'CARRIL' : 'LANE';

function buildCard(lane) {
  const card = document.createElement('div');
  card.className = 'tr-card';
  card.id = `tr-card-${lane.lane}`;
  card.style.setProperty('--card-color', lane.color);
  card.innerHTML = `
    <div class="tr-card__header">
      <span class="tr-card__label">${laneLabel} ${lane.lane}</span>
      <span class="tr-card__count" id="tr-count-${lane.lane}">
        ${lane.count} ${LANG === 'es' ? 'vlt' : 'lps'}
      </span>
    </div>
    <div class="tr-card__best" id="tr-best-${lane.lane}">${formatMs(lane.bestMs)}</div>
    <div class="tr-card__avg-row">
      <span class="tr-card__avg-label">${LANG === 'es' ? 'Media' : 'Avg'}</span>
      <span class="tr-card__avg-val" id="tr-avg-${lane.lane}">${formatMs(lane.avgMs)}</span>
    </div>
    <div class="tr-card__divider"></div>
    <div class="tr-card__laps" id="tr-laps-${lane.lane}">
      ${renderLapList(lane.laps)}
    </div>`;
  return card;
}

function renderLapList(laps) {
  if (!laps || laps.length === 0) return `<div class="tr-lap-empty">—</div>`;
  return laps.map((ms, i) =>
    `<div class="tr-lap-item${i === 0 ? ' tr-lap-item--best' : ''}">${formatMs(ms)}</div>`
  ).join('');
}

function updateCard(data) {
  const countEl = document.getElementById(`tr-count-${data.lane}`);
  const bestEl  = document.getElementById(`tr-best-${data.lane}`);
  const avgEl   = document.getElementById(`tr-avg-${data.lane}`);
  const lapsEl  = document.getElementById(`tr-laps-${data.lane}`);
  if (countEl) countEl.textContent = `${data.count} ${LANG === 'es' ? 'vlt' : 'lps'}`;
  if (bestEl)  bestEl.textContent  = formatMs(data.bestMs);
  if (avgEl)   avgEl.textContent   = formatMs(data.avgMs);
  if (lapsEl)  lapsEl.innerHTML    = renderLapList(data.laps);
}

function flashCard(laneNum) {
  const el = document.getElementById(`tr-card-${laneNum}`);
  if (!el) return;
  el.classList.remove('tr-flash');
  void el.offsetWidth;
  el.classList.add('tr-flash');
}

// ── Initialize cards ──────────────────────────────────────────────────────────
TRAINING_DATA.lanes.forEach(lane => grid.appendChild(buildCard(lane)));

// ── Voice announcements ───────────────────────────────────────────────────────
const speechQueue = [];
let   speechBusy  = false;
let   voiceMuted  = false;

function toggleVoice() {
  voiceMuted = !voiceMuted;
  const btn = document.getElementById('voiceBtn');
  if (btn) btn.textContent = voiceMuted ? '🔇' : '🔊';
  if (voiceMuted) {
    speechQueue.length = 0;
    window.speechSynthesis?.cancel();
    speechBusy = false;
  }
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
  if (!window.speechSynthesis || voiceMuted) return;
  speechQueue.push(text);
  if (!speechBusy) drainSpeech();
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => socket.emit('training:request'));

socket.on('training:data', (lanes) => {
  lanes.forEach(lane => updateCard(lane));
});

socket.on('training:lap', (data) => {
  updateCard(data);
  flashCard(data.lane);

  const time = formatMsForSpeech(data.lapTimeMs);
  const text = LANG === 'es'
    ? `Carril ${data.lane}, ${time}`
    : `Lane ${data.lane}, ${time}`;
  announce(text);
});

socket.on('training:stopped', () => {
  location.href = '/training';
});
