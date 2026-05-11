// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMs(ms) {
  if (ms == null) return '—';
  const totalSec   = Math.floor(ms / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
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

function formatRemaining(ms) {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── View toggle ───────────────────────────────────────────────────────────────
function toggleView() {
  if (RACE_DATA.lanes.filter(l => !l.isRest).length > 8) return;
  const grid = document.getElementById('lanesGrid');
  const btn  = document.getElementById('viewBtn');
  const expanded = grid.classList.toggle('live-lanes--expanded');
  btn.classList.toggle('active', expanded);
}

// ── Semaphore ─────────────────────────────────────────────────────────────────
let _semaphoreFallback = null;

function showSemaphore() {
  if (document.getElementById('semaphore-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'semaphore-overlay';
  ov.className = 'semaphore-overlay';
  ov.innerHTML = `<div class="semaphore-panel">${[1,2,3,4,5].map(i =>
    `<div class="s-light" id="sl${i}"></div>`).join('')}</div>`;
  document.body.appendChild(ov);
  [1,2,3,4,5].forEach((n, i) =>
    setTimeout(() => document.getElementById(`sl${n}`)?.classList.add('lit'), i * 1000)
  );
  _semaphoreFallback = setTimeout(() => semaphoreGo(null), 10000);
}

function semaphoreGo(callback) {
  if (_semaphoreFallback) { clearTimeout(_semaphoreFallback); _semaphoreFallback = null; }
  [1,2,3,4,5].forEach(n => {
    const el = document.getElementById(`sl${n}`);
    if (!el) return;
    el.classList.remove('lit');
    el.classList.add('go');
  });
  setTimeout(() => {
    document.getElementById('semaphore-overlay')?.remove();
    if (callback) callback();
  }, 900);
}

// ── Countdown timer ───────────────────────────────────────────────────────────
let remainingMs = RACE_DATA.durationMs;
let lastTickAt  = null;
let timerInt    = null;
const timerEl   = document.getElementById('raceTimer');
const statusEl  = document.getElementById('timerStatus');
let warned60 = false;
let warned30 = false;

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
    }
  }, 250);
}

// ── Previous-manga lap totals (race cumulative base per lane) ─────────────────
const prevLapCountMap = {};
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
  card.id = `card-${lane.lane}`;
  card.style.setProperty('--card-color', lane.color);

  if (lane.isRest) {
    const restTotal = lane.prevLapCount || 0;
    card.innerHTML = `
      <div class="lane-card__rest-icon">💤</div>
      <div class="lane-card__rest-name">${lane.name}</div>
      <div class="lane-card__rest-laps" id="card-rest-laps-${lane.lane}">${restTotal}</div>
      <div class="lane-card__rest-label">${LANG === 'es' ? 'Descansando' : 'Resting'}</div>`;
    return card;
  }

  const initTotal = getTotalLaps(lane.lane, lane.lapCount ?? 0);
  card.innerHTML = `
    <div class="lane-card__label"><span class="lane-card__lane-num">${lane.lane}</span></div>
    <div class="lane-card__name-row">
      <span class="lane-card__pos" id="card-pos-${lane.lane}"></span>
      <span class="lane-card__name">${lane.name}</span>
    </div>
    <div class="lane-card__driver-row" id="card-driver-${lane.lane}"></div>
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
      <div class="lane-card__time-row">
        <span class="lane-card__time-label">Δ</span>
        <span class="lane-card__time-val lane-card__time-val--delta" id="card-delta-${lane.lane}">${formatDelta(lane.bestLapMs, lane.avgLapMs)}</span>
      </div>
    </div>`;
  return card;
}

function initCards() {
  RACE_DATA.lanes.forEach(lane => {
    lanesGrid.appendChild(buildCard(lane));
    if (lane.activeDriver) setActiveDriver(lane.lane, lane.activeDriver);
  });
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
    exitsEl.classList.toggle('lane-card__time-val--exits-active', (exitCount ?? 0) > 0);
  }
  if (deltaEl) deltaEl.textContent = formatDelta(bestLapMs, avgLapMs);
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
    const posEl = document.getElementById(`card-pos-${r.lane}`);
    if (posEl) {
      posEl.textContent = `P${i + 1}`;
      posEl.className = `lane-card__pos lane-card__pos--${['1','2','3'][i] ?? 'n'}`;
    }
  });
  // Rest cards go to the end
  RACE_DATA.lanes.filter(l => l.isRest).forEach(l => {
    const card = document.getElementById(`card-${l.lane}`);
    if (card) card.style.order = 999;
  });
}

// Tracks previous gap (in total laps) from each lane to the driver ahead
let prevGapToAhead = {};

function renderStandings(data) {
  if (!data?.standings) return;
  // Merge active lanes with resting entities (lapCount=0 this manga)
  const restRows = restLanes.map(l => ({
    lane: l.lane, name: l.name, color: l.color,
    lapCount: 0, lastLapMs: null, bestLapMs: null, avgLapMs: null,
    exitCount: 0, isRest: true, prevLapCount: l.prevLapCount || 0,
  }));

  const rowTotal = r => r.isRest ? (r.prevLapCount || 0) : getTotalLaps(r.lane, r.lapCount);

  // Sort sidebar by total race laps
  const rows = [...data.standings, ...restRows].sort((a, b) =>
    rowTotal(b) - rowTotal(a) || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity)
  );

  // Compute current gap to the driver immediately ahead for each row
  const currentGap = {};
  rows.forEach((r, i) => {
    if (i === 0) return;
    currentGap[r.lane] = rowTotal(rows[i-1]) - rowTotal(r);
  });

  // Determine arrows: ↑ green if closing to ahead, ↓ red if driver behind is closing
  const aheadArrow  = {}; // lane → '↑' or ''
  const behindArrow = {}; // lane → '↓' or ''
  rows.forEach((r, i) => {
    // Arrow up: this driver's gap to ahead shrank
    if (i > 0) {
      const prev = prevGapToAhead[r.lane];
      const curr = currentGap[r.lane];
      aheadArrow[r.lane] = (prev != null && curr < prev) ? '↑' : '';
    }
    // Arrow down: the driver behind's gap to us shrank (i.e. they're catching up)
    if (i < rows.length - 1) {
      const behindLane = rows[i+1].lane;
      const prev = prevGapToAhead[behindLane];
      const curr = currentGap[behindLane];
      behindArrow[r.lane] = (prev != null && curr < prev) ? '↓' : '';
    }
  });

  // Save gaps for next render
  prevGapToAhead = { ...currentGap };

  standingsBody.innerHTML = rows.map((r, i) => {
    if (r.isRest) {
      return `
      <tr class="srow srow--rest" id="srow-rest-${i}">
        <td><span class="sr-pos">${i+1}</span></td>
        <td style="max-width:80px" colspan="2"><span class="sr-name sr-name--rest" title="${r.name}">💤 ${r.name}</span></td>
        <td class="sr-right">—</td>
        <td class="sr-right"><span class="sr-total">${r.prevLapCount}</span></td>
        <td class="sr-right">—</td>
        <td class="sr-right">—</td>
        <td class="sr-right">—</td>
      </tr>`;
    }
    const upActive   = !!aheadArrow[r.lane]  && i > 0;
    const downActive = !!behindArrow[r.lane] && i < rows.length - 1;
    const arrows = `<span class="sr-arrow-up ${upActive ? 'active' : ''}">${i > 0 ? '↑' : ''}</span><span class="sr-arrow-down ${downActive ? 'active' : ''}">${i < rows.length - 1 ? '↓' : ''}</span>`;
    return `
    <tr class="srow" id="srow-${r.lane}">
      <td><span class="sr-pos ${posClass(i+1)}">${i+1}</span></td>
      <td style="max-width:80px"><span class="sr-name" title="${r.name}">${r.name}</span></td>
      <td class="sr-arrows">${arrows}</td>
      <td class="sr-right"><span class="sr-laps">${r.lapCount}</span></td>
      <td class="sr-right"><span class="sr-total">${getTotalLaps(r.lane, r.lapCount)}</span></td>
      <td class="sr-right"><span class="sr-best">${formatMs(r.bestLapMs)}</span></td>
      <td class="sr-right"><span class="sr-avg">${formatMs(r.avgLapMs)}</span></td>
      <td class="sr-right"><span class="sr-delta">${formatDelta(r.bestLapMs, r.avgLapMs)}</span></td>
    </tr>`;
  }).join('');

  data.standings.forEach(r => updateCard(r.lane, r.lapCount, r.lastLapMs, r.bestLapMs, r.avgLapMs, r.exitCount));
  sortCards(data.standings);

  updateRaceBestLaps(data.raceBestLaps);
  renderProjected(data);
}

function renderProjected(data) {
  if (!data?.standings) return;
  const elapsed   = data.elapsedMs   ?? 0;
  const remaining = data.remainingMs ?? 0;

  // Build map of active participants with in-memory totals + projection
  const totalMangaDuration = elapsed + remaining;
  const activeMap = new Map();
  data.standings.forEach(r => {
    const prevLaps  = prevLapCountMap[r.lane] || 0;
    const total     = prevLaps + r.lapCount;
    // Project: how many complete laps will they finish in the full manga duration?
    const avgLapMs  = r.lapCount > 1 ? elapsed / r.lapCount : null;
    const projMangaLaps = avgLapMs && totalMangaDuration > 0
      ? Math.floor(totalMangaDuration / avgLapMs)
      : r.lapCount;
    activeMap.set(r.name, {
      name: r.name, color: r.color,
      total, projectedTotal: prevLaps + projMangaLaps,
      bestLapMs: r.bestLapMs, avgLapMs: r.avgLapMs,
    });
  });

  // Merge: all race participants (DB totals) + active overrides (in-memory)
  const seen = new Set();
  const rows = [];

  (RACE_DATA.allParticipants || []).forEach(p => {
    const name = p.entity_name;
    if (seen.has(name)) return;
    seen.add(name);
    if (activeMap.has(name)) {
      rows.push(activeMap.get(name));
    } else {
      rows.push({
        name, color: p.color || '#8b949e',
        total: p.total_laps,
        projectedTotal: p.total_laps,
        bestLapMs: p.best_lap_ms ?? null,
        avgLapMs:  p.avg_lap_ms  != null ? Math.round(p.avg_lap_ms) : null,
      });
    }
  });

  // Active participants not yet in DB (no laps before this manga)
  activeMap.forEach((r, name) => {
    if (!seen.has(name)) rows.push(r);
  });

  rows.sort((a, b) => b.projectedTotal - a.projectedTotal || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));

  projectedBody.innerHTML = rows.map((r, i) => `
    <tr class="srow">
      <td><span class="sr-pos ${posClass(i+1)}">${i+1}</span></td>
      <td style="max-width:80px"><span class="sr-name" title="${r.name}">${r.name}</span></td>
      <td class="sr-right"><span class="sr-proj">${r.projectedTotal}</span></td>
      <td class="sr-right"><span class="sr-ontrack">${r.total}</span></td>
      <td class="sr-right"><span class="sr-avg">${formatMs(r.avgLapMs)}</span></td>
    </tr>`).join('');
}

// ── Best laps panel ──────────────────────────────────────────────────────────
const bestLapsBody = document.getElementById('bestLapsBody');
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

  if (!bestLapsBody) return;
  if (rows.length === 0) { bestLapsBody.innerHTML = ''; return; }

  const fastest = rows[0].bestLapMs;
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

function updateRaceBestLaps(raceBestLaps) {
  if (!raceBestLaps) return;
  let changed = false;
  Object.entries(raceBestLaps).forEach(([lane, info]) => {
    const prev = _raceBestLaps[lane];
    if (!prev || info.bestLapMs < prev.bestLapMs) {
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

// Default view: expanded for ≤8 lanes; hide button for >8
if (RACE_DATA.lanes.filter(l => !l.isRest).length <= 8) {
  lanesGrid.classList.add('live-lanes--expanded');
  document.getElementById('viewBtn')?.classList.add('active');
} else {
  document.getElementById('viewBtn')?.style.setProperty('display', 'none');
}

if (RACE_DATA.standings) {
  renderStandings(RACE_DATA.standings);
  renderBestLaps();
  if (RACE_DATA.standings.remainingMs != null) {
    if (RACE_DATA.standings.elapsedMs != null)
      RACE_DATA.durationMs = RACE_DATA.standings.remainingMs + RACE_DATA.standings.elapsedMs;
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
  renderBestLaps();
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
      if (data.remainingMs != null) {
        if (data.elapsedMs != null) RACE_DATA.durationMs = data.remainingMs + data.elapsedMs;
        if (!timerInt) {
          startCountdown(data.remainingMs);
        } else if (lastTickAt) {
          remainingMs = data.remainingMs;
        }
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
      // durationMs is set from standings data; this fires only if standings was missed
      if (timerInt === null && RACE_DATA.durationMs) {
        startCountdown(RACE_DATA.durationMs - elapsedMs);
      }
    });

    socket.on('manga:stopped', (data) => {
      if (data?.mangaId && data.mangaId !== RACE_DATA.mangaId) return;
      RACE_DATA.isActive = false;
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
          badge.className = nextLane === 'rest' ? 'next-lane-badge next-lane-badge--rest' : 'next-lane-badge';
          badge.innerHTML = nextLane === 'rest'
            ? `<span class="next-lane-arrow">→</span> <strong>${LANG === 'es' ? 'Descanso' : 'Rest'}</strong>`
            : `<span class="next-lane-arrow">→</span> ${LANG === 'es' ? 'Carril' : 'Lane'} <strong>${nextLane}</strong>`;
          card.appendChild(badge);
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
    });

    socket.on('manga:cancelled', (data) => {
      RACE_DATA.isActive = false;
      if (!data.mangaId || data.mangaId === RACE_DATA.mangaId) {
        location.reload();
      }
    });

    socket.on('manga:paused', () => {
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
      document.getElementById('pause-overlay')?.remove();
    });
  }

  socket.on('race:semaphore', () => showSemaphore());

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
  if (!el) return;
  if (driverName) {
    el.innerHTML = `<span class="lane-card__driver-name">👤 ${driverName}</span>`;
    el.classList.add('lane-card__driver-row--active');
    // Flash animation
    const card = document.getElementById(`card-${lane}`);
    if (card) { card.classList.add('card-checkin-flash'); setTimeout(() => card.classList.remove('card-checkin-flash'), 800); }
  } else {
    el.innerHTML = '';
    el.classList.remove('lane-card__driver-row--active');
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
