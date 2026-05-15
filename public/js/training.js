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

function updateTimer() {
  if (standby) { timerEl.textContent = '--:--'; return; }
  timerEl.textContent = durationMs > 0
    ? formatElapsed(Math.max(0, durationMs - elapsedMs))
    : formatElapsed(elapsedMs);
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

function renderLapList(laps) {
  if (!laps || laps.length === 0) return `<div class="tr-lap-empty">—</div>`;
  const best = Math.min(...laps);
  return laps.map(ms =>
    `<div class="tr-lap-item${ms === best ? ' tr-lap-item--best' : ''}">${formatMs(ms)}</div>`
  ).join('');
}

function updateCard(data) {
  const countEl = document.getElementById(`tr-count-${data.lane}`);
  const bestEl  = document.getElementById(`tr-best-${data.lane}`);
  const avgEl   = document.getElementById(`tr-avg-${data.lane}`);
  const lapsEl  = document.getElementById(`tr-laps-${data.lane}`);
  const recordEl = document.getElementById(`tr-record-${data.lane}`);
  if (countEl)  countEl.textContent  = `${data.count} ${LANG === 'es' ? 'vlt' : 'lps'}`;
  if (bestEl)   bestEl.textContent   = formatMs(data.lastMs ?? data.lapTimeMs);
  if (avgEl)    avgEl.textContent    = formatMs(data.avgMs);
  if (recordEl) recordEl.textContent = formatMs(data.bestMs);
  if (lapsEl)   lapsEl.innerHTML     = renderLapList(data.laps);
}

function toggleView() {
  const grid = document.getElementById('trainingGrid');
  const btn  = document.getElementById('viewBtn');
  const expanded = grid.classList.toggle('training-grid--expanded');
  btn.classList.toggle('active', expanded);
}

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

// Vista por defecto:
//   ≤8 carriles → expandida (tarjetas grandes), botón activo para alternar.
//   >8 carriles → también expandida (tarjetas en varias filas con buen tamaño),
//                  botón visible para compactar a una sola fila de columnas.
grid.classList.add('training-grid--expanded');
document.getElementById('viewBtn')?.classList.add('active');

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

// ── Semaphore ─────────────────────────────────────────────────────────────────
function showSemaphore() {
  if (document.getElementById('semaphore-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'semaphore-overlay';
  ov.className = 'semaphore-overlay';
  ov.innerHTML = `<div class="semaphore-panel">${[1,2,3].map(i =>
    `<div class="s-light" id="sl${i}"></div>`).join('')}</div>`;
  document.body.appendChild(ov);
  // 3 luces rojas progresivas sobre los ~3.1s de la secuencia GO. La verde se
  // dispara con la trama 3 (race_started → training:autostart) en semaphoreGo().
  [0, 700, 1400].forEach((delay, i) =>
    setTimeout(() => document.getElementById(`sl${i + 1}`)?.classList.add('lit'), delay)
  );
}
function semaphoreGo() {
  const ov = document.getElementById('semaphore-overlay');
  if (!ov) return;
  [1,2,3].forEach(n => {
    const el = document.getElementById(`sl${n}`);
    if (!el) return;
    el.classList.remove('lit');
    el.classList.add('go');
  });
  setTimeout(() => ov.remove(), 700);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => socket.emit('training:request'));
socket.on('race:semaphore', () => showSemaphore());
socket.on('training:autostart', () => semaphoreGo());

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

socket.on('training:activated', (lanes) => {
  elapsedMs = 0;
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
