/* Inicio (vista admin): abrir secciones en ventanas aparte, buscador «Ir a…»,
   barra de ventanas abiertas y datos en vivo de la carrera en curso. */
(function () {
  const MODE_KEY = 'pw:home:openMode';
  const es = document.documentElement.lang !== 'en';
  const desktop = window.pitwallWindows && typeof window.pitwallWindows.open === 'function';

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
  // ya está abierta en vez de abrir otra.
  function winName(a) {
    if (a.dataset.win) return a.dataset.win;
    return 'pw' + new URL(a.href).pathname.replace(/[^a-z0-9]+/gi, '-');
  }

  // ¿La ventana sigue dentro de la sección? Si el usuario navegó fuera (p. ej.
  // «Volver» al inicio), hay que llevarla otra vez al destino, no solo enfocarla.
  function sameSection(curPath, href) {
    const norm = (p) => p.replace(/\/+$/, '') || '/';
    const cur = norm(curPath);
    const tgt = norm(new URL(href, location.href).pathname);
    return tgt !== '/' && (cur === tgt || cur.startsWith(tgt + '/'));
  }

  const opened = new Map();   // navegador: nombre → { w, label }

  function openIn(a) {
    const name = winName(a);
    if (desktop) {
      window.pitwallWindows.open(a.href, name).then(refreshWindows).catch(() => { location.href = a.href; });
      return true;
    }
    let w = null;
    try { w = window.open('', name); } catch (_) {}
    if (!w) return false;
    let path = '';
    try { path = w.location.href === 'about:blank' ? '' : w.location.pathname; } catch (_) {}
    if (!path || !sameSection(path, a.href)) w.location.href = a.href;
    try { w.focus(); } catch (_) {}
    opened.set(name, { w, label: (a.textContent || '').trim() });
    refreshWindows();
    return true;
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-win]');
    if (!a || e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Mayús + clic = abrir aquí.
    if (e.shiftKey) { e.preventDefault(); location.href = a.href; return; }
    if (getMode() !== 'new') return;
    if (openIn(a)) e.preventDefault();
  });

  // ── Barra de ventanas abiertas ─────────────────────────────────
  const dock = document.getElementById('hmDock');
  const dockList = document.getElementById('hmDockList');
  let lastKey = '';

  function paintWindows(list) {
    if (!dock || !dockList) return;
    const key = JSON.stringify(list.map(w => [w.id, w.title]));
    if (key === lastKey) return;
    lastKey = key;
    dock.hidden = list.length === 0;
    dockList.textContent = '';
    list.forEach(w => {
      const item = document.createElement('div');
      item.className = 'hm-win';
      const t = document.createElement('span');
      t.className = 'hm-win__t';
      t.textContent = w.title || (es ? 'Ventana' : 'Window');
      t.title = t.textContent;
      const bring = document.createElement('button');
      bring.type = 'button';
      bring.textContent = es ? 'Traer' : 'Show';
      bring.addEventListener('click', () => w.focus());
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '✕';
      close.setAttribute('aria-label', (es ? 'Cerrar ' : 'Close ') + t.textContent);
      close.addEventListener('click', () => { w.close(); setTimeout(refreshWindows, 300); });
      item.append(t, bring, close);
      dockList.appendChild(item);
    });
  }

  async function refreshWindows() {
    // En Electron el proceso principal conoce todas las ventanas; en el
    // navegador solo las abiertas desde esta pestaña desde que se cargó.
    if (desktop) {
      try {
        const list = await window.pitwallWindows.list();
        paintWindows((list || []).map(w => ({
          id: w.id, title: w.title,
          focus: () => window.pitwallWindows.focus(w.id),
          close: () => window.pitwallWindows.close(w.id),
        })));
        return;
      } catch (_) {}
    }
    const list = [];
    for (const [name, o] of opened) {
      if (!o.w || o.w.closed) { opened.delete(name); continue; }
      let t = o.label;
      try { t = o.w.document.title || t; } catch (_) {}
      list.push({ id: name, title: t, focus: () => o.w.focus(), close: () => o.w.close() });
    }
    paintWindows(list);
  }
  refreshWindows();
  setInterval(refreshWindows, 2000);

  // ── Buscador «Ir a…» ───────────────────────────────────────────
  const search = document.getElementById('hmSearch');
  const kbd = document.getElementById('hmKbd');
  if (kbd && !/Mac|iPhone|iPad/.test(navigator.platform || '')) kbd.textContent = 'Ctrl K';
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function applySearch() {
    const q = norm(search.value.trim());
    let first = null;
    let any = false;
    document.querySelectorAll('.hm-group').forEach(g => {
      let visible = 0;
      g.querySelectorAll('[data-search]').forEach(el => {
        const hit = !q || norm(el.dataset.search).includes(q);
        el.hidden = !hit;
        el.classList.remove('is-first');
        if (hit) {
          visible++;
          if (q && !first) first = el.matches('a') ? el : el.querySelector('a[data-win]');
        }
      });
      const total = g.querySelectorAll('[data-search]').length;
      g.hidden = !!q && total > 0 && visible === 0;
      if (!g.hidden) any = true;
    });
    if (first && first.classList.contains('hm-tile')) first.classList.add('is-first');
    const nores = document.getElementById('hmNoRes');
    if (nores) nores.hidden = !q || any;
    return first;
  }

  if (search) {
    search.addEventListener('input', applySearch);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = applySearch();
        if (first) { e.preventDefault(); first.click(); }
      } else if (e.key === 'Escape') {
        search.value = '';
        applySearch();
        search.blur();
      }
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.focus();
        search.select();
      }
    });
  }

  // ── Datos en vivo de la carrera en curso ───────────────────────
  // Reloj y líder estimado se actualizan con el socket; el resto de la franja
  // (manga, progreso, enlaces) se pinta en servidor y se recarga al cambiar.
  let reloadT = null;
  const reloadSoon = () => {
    clearTimeout(reloadT);
    reloadT = setTimeout(() => location.reload(), 800);
  };

  // Firma del estado: cubre lo que los eventos de socket no avisan (pasar una
  // carrera a «en curso», arrancar una pole…). Si cambia, recargar.
  let sig = null;
  async function pollState() {
    if (document.hidden) return;
    try {
      const r = await fetch('/api/home/state', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (sig !== null && d.sig !== sig) reloadSoon();
      sig = d.sig;
    } catch (_) {}
  }
  pollState();
  setInterval(pollState, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollState(); });

  if (typeof io === 'undefined') return;
  const hero   = document.querySelector('.hm-hero[data-race-id]');
  const clock  = document.getElementById('hmClock');
  const leader = document.getElementById('hmLeader');
  const socket = io();

  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  if (hero && hero.dataset.running === '1') {
    socket.on('tick', (d) => {
      if (clock && d && typeof d.remainingMs === 'number') clock.textContent = fmt(d.remainingMs);
    });
    socket.on('standings', (d) => {
      if (!d || String(d.raceId) !== hero.dataset.raceId) return;
      if (clock && typeof d.remainingMs === 'number') clock.textContent = fmt(d.remainingMs);
      if (leader && Array.isArray(d.projection) && d.projection[0] && d.projection[0].name) {
        leader.textContent = d.projection[0].name;
      }
    });
  }

  ['manga:started', 'manga:stopped', 'manga:cancelled', 'manga:paused', 'manga:resumed'].forEach(ev => socket.on(ev, reloadSoon));
})();
