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

function renderTable(standings) {
  if (!standings?.standings) return;

  const rows = [...standings.standings].sort((a, b) => {
    const ta = getTotalLaps(a.lane, a.lapCount);
    const tb = getTotalLaps(b.lane, b.lapCount);
    return tb - ta || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity);
  });

  const leaderTotal = rows[0] ? getTotalLaps(rows[0].lane, rows[0].lapCount) : 0;

  tbody.innerHTML = rows.map((r, i) => {
    const total = getTotalLaps(r.lane, r.lapCount);
    const gap   = leaderTotal - total;
    const gapHtml = i === 0
      ? `<span class="tv-gap tv-gap--leader">${LANG === 'es' ? 'LÍDER' : 'LEADER'}</span>`
      : `<span class="tv-gap tv-gap--behind">−${gap} ${LANG === 'es' ? 'vlt' : 'lps'}</span>`;

    return `
      <tr class="tv-row" id="tvrow-${r.lane}">
        <td style="width:6vw"><span class="tv-pos ${posClass(i+1)}">${i+1}</span></td>
        <td>
          <div style="display:flex;align-items:center">
            <span class="tv-stripe" style="background:${r.color}"></span>
            <span class="tv-name">${r.name}</span>
          </div>
        </td>
        <td class="tv-right" style="width:12vw"><span class="tv-total">${total}</span></td>
        <td class="tv-right" style="width:10vw"><span class="tv-manga-laps">${r.lapCount}</span></td>
        <td class="tv-right" style="width:12vw"><span class="tv-best">${formatMs(r.bestLapMs)}</span></td>
        <td class="tv-right" style="width:10vw">${gapHtml}</td>
      </tr>`;
  }).join('');
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
      <span class="tv-tick-name">${t.name}</span>
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

  socket.on('manga:stopped', () => {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    timerEl.textContent = '00:00';
    document.getElementById('tvStatus').className = 'tv-status tv-status--finished';
    document.getElementById('tvStatus').innerHTML =
      `<span class="tv-status-dot"></span>${LANG === 'es' ? 'FINALIZADA' : 'FINISHED'}`;
  });

  socket.on('manga:cancelled', () => { location.reload(); });
}
