/* Inicio (vista admin): abrir secciones en ventanas aparte y reloj de la manga viva. */
(function () {
  const MODE_KEY = 'pw:home:openMode';
  const es = document.documentElement.lang !== 'en';

  function getMode() {
    try { return localStorage.getItem(MODE_KEY) || 'new'; } catch (_) { return 'new'; }
  }

  function paintMode() {
    const mode = getMode();
    document.querySelectorAll('.hm-seg button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
  }

  document.querySelectorAll('.hm-seg button').forEach(b => {
    b.addEventListener('click', () => {
      try { localStorage.setItem(MODE_KEY, b.dataset.mode); } catch (_) {}
      paintMode();
    });
  });
  paintMode();

  // Un nombre de ventana fijo por destino: un segundo clic trae al frente la que
  // ya está abierta en vez de abrir otra (y sin recargarla, para no perder el
  // estado del directo).
  function winName(a) {
    if (a.dataset.win) return a.dataset.win;
    return 'pw' + new URL(a.href).pathname.replace(/[^a-z0-9]+/gi, '-');
  }

  const opened = new Map();

  function openIn(a) {
    const name = winName(a);
    let w = null;
    try { w = window.open('', name); } catch (_) {}
    if (!w) return false;
    let blank = true;
    try { blank = w.location.href === 'about:blank'; } catch (_) {}
    if (blank) w.location.href = a.href;
    w.focus();
    opened.set(name, w);
    refreshWindows();
    return true;
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-win]');
    if (!a || e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (getMode() !== 'new') return;
    if (openIn(a)) e.preventDefault();
  });

  // ── Contador de ventanas abiertas ───────────────────────────────
  const pill = document.getElementById('hmWinPill');

  function paintWindows(titles) {
    if (!pill) return;
    const n = titles.length;
    pill.hidden = n === 0;
    pill.textContent = n + (es ? (n === 1 ? ' ventana abierta' : ' ventanas abiertas')
                               : (n === 1 ? ' open window' : ' open windows'));
    pill.title = titles.filter(Boolean).join(' · ');
  }

  async function refreshWindows() {
    // En Electron el proceso principal conoce todas las ventanas; en el
    // navegador solo las abiertas desde esta pestaña desde que se cargó.
    if (window.pitwallWindows && typeof window.pitwallWindows.list === 'function') {
      try { paintWindows(await window.pitwallWindows.list()); return; } catch (_) {}
    }
    const titles = [];
    for (const [name, w] of opened) {
      if (!w || w.closed) { opened.delete(name); continue; }
      let t = '';
      try { t = w.document.title; } catch (_) {}
      titles.push(t);
    }
    paintWindows(titles);
  }
  refreshWindows();
  setInterval(refreshWindows, 2000);

  // ── Reloj de la manga viva ──────────────────────────────────────
  const hero  = document.querySelector('.hm-hero[data-race-id]');
  const clock = document.getElementById('hmClock');
  if (typeof io === 'undefined') return;
  const socket = io();

  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  if (clock && hero && hero.dataset.running === '1') {
    socket.on('tick', (d) => {
      if (d && typeof d.remainingMs === 'number') clock.textContent = fmt(d.remainingMs);
    });
  }

  // Cambio de manga: la franja (manga, progreso, enlaces) se pinta en servidor.
  let reloadT = null;
  const reloadSoon = () => {
    clearTimeout(reloadT);
    reloadT = setTimeout(() => location.reload(), 800);
  };
  ['manga:started', 'manga:stopped', 'manga:cancelled', 'manga:paused', 'manga:resumed'].forEach(ev => socket.on(ev, reloadSoon));
})();
