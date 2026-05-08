// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMs(ms) {
  if (ms == null) return '—';
  const totalSec   = Math.floor(ms / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  return `${mins > 0 ? mins + ':' : ''}${String(secs).padStart(mins > 0 ? 2 : 1, '0')}.${String(hundredths).padStart(2, '0')}`;
}

function formatRemaining(ms) {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Countdown timer ───────────────────────────────────────────────────────────
let remainingMs = RACE_DATA.durationMs;
let lastTickAt  = null;
let timerInt    = null;
const timerEl   = document.getElementById('raceTimer');
const statusEl  = document.getElementById('timerStatus');

function startCountdown(remaining) {
  remainingMs = remaining;
  lastTickAt  = Date.now();
  if (timerInt) clearInterval(timerInt);
  timerInt = setInterval(() => {
    const now     = Date.now();
    const elapsed = now - lastTickAt;
    lastTickAt    = now;
    remainingMs   = Math.max(0, remainingMs - elapsed);
    timerEl.textContent = formatRemaining(remainingMs);
    if (remainingMs <= 0) {
      clearInterval(timerInt);
      timerInt = null;
      statusEl.innerHTML = `<span class="status-text status-text--finished">${LANG === 'es' ? 'Finalizada' : 'Finished'}</span>`;
    }
  }, 250);
}

// ── Previous-manga lap totals (race cumulative base per lane) ─────────────────
const prevLapCountMap = {};
RACE_DATA.lanes.forEach(l => { prevLapCountMap[l.lane] = l.prevLapCount || 0; });
function getTotalLaps(lane, lapCount) { return (prevLapCountMap[lane] || 0) + lapCount; }

// ── Lane cards ────────────────────────────────────────────────────────────────
const lanesGrid = document.getElementById('lanesGrid');
const laneLabel = LANG === 'es' ? 'CARRIL' : 'LANE';

function buildCard(lane) {
  const card = document.createElement('div');
  card.className = 'lane-card' + (lane.isRest ? ' is-rest' : '');
  card.id = `card-${lane.lane}`;
  card.style.setProperty('--card-color', lane.isRest ? '#21262d' : lane.color);

  if (lane.isRest) {
    card.innerHTML = `<div class="lane-card__label">${laneLabel} ${lane.lane}</div>`;
    return card;
  }

  const initTotal = getTotalLaps(lane.lane, lane.lapCount ?? 0);
  card.innerHTML = `
    <div class="lane-card__label">${laneLabel} ${lane.lane}</div>
    <div class="lane-card__name">${lane.name}</div>
    <div class="lane-card__laps" id="card-laps-${lane.lane}">${lane.lapCount ?? 0}</div>
    <div class="lane-card__total-row">
      <span class="lane-card__total-label">${LANG === 'es' ? 'Total carrera' : 'Race total'}</span>
      <span class="lane-card__total-val" id="card-total-${lane.lane}">${initTotal}</span>
    </div>
    <div class="lane-card__times">
      <div class="lane-card__time-row">
        <span class="lane-card__time-label">${LANG === 'es' ? 'Última' : 'Last'}</span>
        <span class="lane-card__time-val" id="card-last-${lane.lane}">${formatMs(lane.lastLapMs)}</span>
      </div>
      <div class="lane-card__time-row">
        <span class="lane-card__time-label">${LANG === 'es' ? 'Mejor' : 'Best'}</span>
        <span class="lane-card__time-val lane-card__time-val--best" id="card-best-${lane.lane}">${formatMs(lane.bestLapMs)}</span>
      </div>
      <div class="lane-card__time-row">
        <span class="lane-card__time-label">${LANG === 'es' ? 'Media' : 'Avg'}</span>
        <span class="lane-card__time-val lane-card__time-val--avg" id="card-avg-${lane.lane}">${formatMs(lane.avgLapMs)}</span>
      </div>
      <div class="lane-card__time-row">
        <span class="lane-card__time-label">${LANG === 'es' ? 'Salidas' : 'Exits'}</span>
        <span class="lane-card__time-val lane-card__time-val--exits" id="card-exits-${lane.lane}">${lane.exitCount ?? 0}</span>
      </div>
    </div>`;
  return card;
}

function initCards() {
  RACE_DATA.lanes.forEach(lane => lanesGrid.appendChild(buildCard(lane)));
}

function updateCard(lane, lapCount, lastLapMs, bestLapMs, avgLapMs, exitCount) {
  const lapsEl  = document.getElementById(`card-laps-${lane}`);
  const lastEl  = document.getElementById(`card-last-${lane}`);
  const bestEl  = document.getElementById(`card-best-${lane}`);
  const avgEl   = document.getElementById(`card-avg-${lane}`);
  const totalEl = document.getElementById(`card-total-${lane}`);
  const exitsEl = document.getElementById(`card-exits-${lane}`);
  if (lapsEl)  lapsEl.textContent  = lapCount;
  if (lastEl)  lastEl.textContent  = formatMs(lastLapMs);
  if (bestEl)  bestEl.textContent  = formatMs(bestLapMs);
  if (avgEl && avgLapMs != null) avgEl.textContent = formatMs(avgLapMs);
  if (totalEl) totalEl.textContent = getTotalLaps(lane, lapCount);
  if (exitsEl) {
    exitsEl.textContent = exitCount ?? 0;
    exitsEl.classList.toggle('lane-card__time-val--exits-active', (exitCount ?? 0) > 0);
  }
}

function flashCard(lane, isExit) {
  const el = document.getElementById(`card-${lane}`);
  if (!el) return;
  el.classList.remove('flash', 'exit-flash');
  void el.offsetWidth;
  el.classList.add(isExit ? 'exit-flash' : 'flash');
}

// ── Sidebar standings ─────────────────────────────────────────────────────────
const standingsBody = document.getElementById('standingsBody');
const projectedBody = document.getElementById('projectedBody');

function posClass(pos) {
  return ['p1','p2','p3'][pos - 1] || 'pn';
}

function sortCards(rows) {
  // Sort by total race laps desc, then best lap asc
  const sorted = [...rows]
    .filter(r => !r.isRest)
    .sort((a, b) => {
      const ta = getTotalLaps(a.lane, a.lapCount);
      const tb = getTotalLaps(b.lane, b.lapCount);
      return tb - ta || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity);
    });
  sorted.forEach((r, i) => {
    const card = document.getElementById(`card-${r.lane}`);
    if (card) card.style.order = i;
  });
  // Rest cards go to the end
  RACE_DATA.lanes.filter(l => l.isRest).forEach(l => {
    const card = document.getElementById(`card-${l.lane}`);
    if (card) card.style.order = 999;
  });
}

function renderStandings(data) {
  if (!data?.standings) return;
  // Sort sidebar by total race laps
  const rows = [...data.standings].sort((a, b) => {
    const ta = getTotalLaps(a.lane, a.lapCount);
    const tb = getTotalLaps(b.lane, b.lapCount);
    return tb - ta || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity);
  });

  standingsBody.innerHTML = rows.map((r, i) => `
    <tr class="srow" id="srow-${r.lane}">
      <td><span class="sr-pos ${posClass(i+1)}">${i+1}</span></td>
      <td style="max-width:80px"><span class="sr-name" title="${r.name}">${r.name}</span></td>
      <td class="sr-right"><span class="sr-laps">${r.lapCount}</span></td>
      <td class="sr-right"><span class="sr-total">${getTotalLaps(r.lane, r.lapCount)}</span></td>
      <td class="sr-right"><span class="sr-best">${formatMs(r.bestLapMs)}</span></td>
      <td class="sr-right"><span class="sr-avg">${formatMs(r.avgLapMs)}</span></td>
    </tr>`).join('');

  data.standings.forEach(r => updateCard(r.lane, r.lapCount, r.lastLapMs, r.bestLapMs, r.avgLapMs, r.exitCount));
  sortCards(data.standings);

  renderProjected(data);
}

function renderProjected(data) {
  if (!data?.standings) return;
  const elapsed   = data.elapsedMs   ?? 0;
  const remaining = data.remainingMs ?? 0;

  const projected = data.standings.map(r => {
    const total = getTotalLaps(r.lane, r.lapCount);
    // Project additional laps for remaining time based on current manga pace,
    // then add to the total already accumulated across the whole race
    const extraProj = elapsed > 5000 && r.lapCount > 0
      ? Math.round((r.lapCount / elapsed) * remaining)
      : 0;
    return { ...r, total, projectedTotal: total + extraProj };
  }).sort((a, b) => b.projectedTotal - a.projectedTotal || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));

  projectedBody.innerHTML = projected.map((r, i) => `
    <tr class="srow">
      <td><span class="sr-pos ${posClass(i+1)}">${i+1}</span></td>
      <td style="max-width:80px"><span class="sr-name" title="${r.name}">${r.name}</span></td>
      <td class="sr-right"><span class="sr-proj">${r.projectedTotal}</span></td>
      <td class="sr-right"><span class="sr-ontrack">${r.total}</span></td>
    </tr>`).join('');
}

// ── Lap ticker ────────────────────────────────────────────────────────────────
const ticker    = document.getElementById('lapTicker');
const MAX_TICKS = 20;

function addTick(lap) {
  const el = document.createElement('div');
  el.className = 'ticker-item';
  el.style.borderLeftColor = lap.color;
  el.innerHTML = `
    <span class="ticker-dot" style="background:${lap.color}">${lap.lane}</span>
    <span class="ticker-name">${lap.name}</span>
    <span class="ticker-lapn">V${lap.lapNumber}</span>
    <span class="ticker-time">${formatMs(lap.lapTimeMs)}</span>`;
  ticker.insertBefore(el, ticker.firstChild);
  setTimeout(() => el.classList.add('visible'), 10);
  const items = ticker.querySelectorAll('.ticker-item');
  if (items.length > MAX_TICKS) items[items.length - 1].remove();
}

// ── Initialize ────────────────────────────────────────────────────────────────
initCards();

if (RACE_DATA.standings) {
  renderStandings(RACE_DATA.standings);
  if (RACE_DATA.standings.remainingMs != null) {
    startCountdown(RACE_DATA.standings.remainingMs);
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
}

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
  if (!window.speechSynthesis || voiceMuted) return;
  speechQueue.push(text);
  if (!speechBusy) drainSpeech();
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
if (RACE_DATA.isActive || RACE_DATA.mangaStatus === 'pending') {
  const socket = io();

  if (RACE_DATA.isActive) {
    socket.on('connect', () => socket.emit('standings:request'));

    socket.on('standings', (data) => {
      renderStandings(data);
      if (data.remainingMs != null && timerInt && lastTickAt) {
        remainingMs = data.remainingMs;
      }
    });

    socket.on('lap', (lap) => {
      addTick(lap);
      flashCard(lap.lane, lap.isExit);

      // Announce new best lap (skip exits and the very first lap of each lane)
      if (!lap.isExit && lap.lapNumber > 1 && lap.lapTimeMs === lap.bestLapMs) {
        const time = formatMsForSpeech(lap.lapTimeMs);
        const text = LANG === 'es'
          ? `${lap.name}, vuelta rápida, ${time}`
          : `${lap.name}, fast lap, ${time}`;
        announce(text);
      }
    });

    socket.on('tick', ({ elapsedMs }) => {
      if (timerInt === null && RACE_DATA.durationMs) {
        startCountdown(RACE_DATA.durationMs - elapsedMs);
      }
    });

    socket.on('manga:stopped', (data) => {
      if (timerInt) { clearInterval(timerInt); timerInt = null; }
      statusEl.innerHTML = `<span class="status-text status-text--finished">${LANG === 'es' ? 'Finalizada' : 'Finished'}</span>`;
      timerEl.textContent = '00:00';

      // Show next-lane indicator on each card
      if (data?.nextLanes && Object.keys(data.nextLanes).length > 0) {
        Object.entries(data.nextLanes).forEach(([currentLane, nextLane]) => {
          const card = document.getElementById(`card-${currentLane}`);
          if (!card || card.classList.contains('is-rest')) return;
          const existing = card.querySelector('.next-lane-badge');
          if (existing) existing.remove();
          const badge = document.createElement('div');
          badge.className = 'next-lane-badge';
          badge.innerHTML = `<span class="next-lane-arrow">→</span> ${LANG === 'es' ? 'Carril' : 'Lane'} <strong>${nextLane}</strong>`;
          card.appendChild(badge);
        });

        // Show banner inviting to press GO
        const grid = document.getElementById('lanesGrid');
        const banner = document.createElement('div');
        banner.id = 'next-manga-banner';
        banner.className = 'next-manga-banner';
        banner.textContent = LANG === 'es'
          ? '▶ Siguiente manga preparada — pulsa GO para iniciar'
          : '▶ Next heat ready — press GO to start';
        grid.parentNode.insertBefore(banner, grid);
      }
    });

    socket.on('manga:cancelled', (data) => {
      if (!data.mangaId || data.mangaId === RACE_DATA.mangaId) {
        location.reload();
      }
    });
  }

  // Navigate to next manga when DS hardware GO starts it after current finished
  socket.on('manga:started', (data) => {
    if (RACE_DATA.isActive) return; // current manga still active, ignore
    if (data.mangaId && data.mangaId !== RACE_DATA.mangaId) {
      // A new manga started — navigate to its live page
      location.href = `/races/${RACE_DATA.raceId}/mangas/${data.mangaId}/live`;
    } else {
      location.reload();
    }
  });
}
