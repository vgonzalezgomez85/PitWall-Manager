/*
 * PitWall — pantalla de tandas (nueva, varias a la vez y edición).
 * Dos formas de apuntar, según Ajustes → Preferencias (CFG.mode):
 *   write: cada carril es un campo con sugerencias del catálogo.
 *   drag : lista de participantes a la izquierda y se arrastran (o se tocan) a un carril.
 * Una tanda = casillas por posición de la secuencia de carriles (null = libre);
 * lo que se envía es el mismo contrato que usa TandaBatch en el servidor.
 */
(function () {
  'use strict';
  const cfgEl = document.getElementById('tdCfg');
  if (!cfgEl) return;
  const CFG = JSON.parse(cfgEl.textContent);

  const MODE = CFG.canRestructure ? CFG.mode : 'rename';
  const SEQ = CFG.seqLen;
  const MAX_TANDAS = 40;
  const ACTIVE_LANES = CFG.rows.filter(r => r.lane > 0).length;
  const PREVIEW_URL = '/races/' + CFG.raceId + '/tandas/preview';

  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const $ = (s, r) => (r || document).querySelector(s);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgIcon(path, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 18); s.setAttribute('height', size || 18);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', path); s.appendChild(p);
    return s;
  }

  // ── Datos ───────────────────────────────────────────────────────────────────
  const CAT = CFG.catalog.map(c => Object.assign({ key: norm(c.name) }, c));
  const CAT_BY_KEY = new Map(CAT.map(c => [c.key, c]));
  const OTHER = new Map((CFG.otherNames || []).map(o => [o.key, o.tandas]));
  const ERR_BY_TANDA = new Map();
  (CFG.errors || []).forEach(e => { (ERR_BY_TANDA.get(e.tanda) || ERR_BY_TANDA.set(e.tanda, []).get(e.tanda)).push(e.key); });

  function mkSlot(raw) {
    if (!raw) return null;
    return {
      id: raw.id || null,
      name: raw.name || '',
      catalogId: raw.catalogId || null,
      categoria: raw.categoria == null ? null : String(raw.categoria),
      coche: raw.coche == null ? null : String(raw.coche),
      members: raw.members == null ? null : raw.members.map(m => ({ id: m.id || null, name: m.name || '' })),
      confirmed: !!raw.name,
      open: MODE === 'rename',
    };
  }
  function padSlots(slots) {
    const out = (slots || []).map(mkSlot);
    while (out.length < SEQ) out.push(null);
    return out;
  }

  const state = {
    tandas: CFG.tandas.map(t => ({ slots: padSlots(t.slots) })),
    sel: null,
    ask: null,
    roster: [],
    filter: '',
    focus: null,
    sugActive: 0,
    sugMoved: false,
    sugHidden: false,
    preview: false,
    clientErrors: [],
  };
  if (!state.tandas.length) state.tandas.push({ slots: padSlots([]) });

  function addToRoster(name, extra) {
    const key = norm(name);
    if (!key || state.roster.some(r => r.key === key)) return;
    state.roster.push(Object.assign({ key, name: name.trim() }, extra || {}));
  }
  if (MODE === 'drag') {
    CAT.forEach(c => addToRoster(c.name, c));
    state.tandas.forEach(t => t.slots.forEach(s => { if (s && s.name) addToRoster(s.name, s.catalogId ? CAT_BY_KEY.get(norm(s.name)) : null); }));
  }

  // ── Consultas ───────────────────────────────────────────────────────────────
  const numberOf = ti => (CFG.isEdit ? CFG.baseNumber : CFG.baseNumber + ti);
  const filled = t => t.slots.filter(s => s && s.name.trim()).length;
  const rowByPos = new Map(CFG.rows.map(r => [r.pos, r]));
  const laneOf = pos => (rowByPos.get(pos) ? rowByPos.get(pos).lane : 0);
  function dscLabel(pos, total) { return I18N.t('client.common.dsc').trim() + (total - pos); }
  function laneLabel(pos, total) { const l = laneOf(pos); return l > 0 ? String(l) : dscLabel(pos, total); }
  function keyOf(s) { return norm(s && s.name); }

  function occurrences() {
    const m = new Map();
    state.tandas.forEach((t, ti) => t.slots.forEach((s, pos) => {
      const k = keyOf(s); if (!k) return;
      (m.get(k) || m.set(k, []).get(k)).push({ ti, pos });
    }));
    return m;
  }
  function otherNumbers(ti, key, occ) {
    const nums = new Set();
    (occ.get(key) || []).forEach(o => { if (o.ti !== ti) nums.add(numberOf(o.ti)); });
    (OTHER.get(key) || []).forEach(n => { if (!(CFG.isEdit && n === CFG.baseNumber)) nums.add(n); });
    return [...nums].sort((a, b) => a - b);
  }
  function sameTandaDup(ti, key, occ) { return (occ.get(key) || []).filter(o => o.ti === ti).length > 1; }

  function counts() {
    let pilots = 0, free = 0;
    state.tandas.forEach(t => {
      pilots += filled(t);
      CFG.rows.forEach(r => { if (r.lane > 0 && !(t.slots[r.pos] && t.slots[r.pos].name.trim())) free++; });
    });
    return { pilots, free };
  }
  function countText(n, kind) {
    if (kind === 'team') return n === 1 ? I18N.t('client.tandas.equipo_uno', { n }) : I18N.t('client.tandas.equipo_varios', { n });
    return n === 1 ? I18N.t('client.tandas.piloto_uno', { n }) : I18N.t('client.tandas.piloto_varios', { n });
  }
  const noun = n => countText(n, CFG.isTeam ? 'team' : 'driver');

  // ── Operaciones sobre las casillas ─────────────────────────────────────────
  function slotFromRoster(r) {
    return mkSlot({
      name: r.name, catalogId: r.id || null,
      categoria: r.categoria || null, coche: r.coche || null,
      members: r.members ? r.members.map(n => ({ id: null, name: n })) : null,
    });
  }
  function applyCatalog(slot, c) {
    slot.name = c.name;
    slot.catalogId = c.id || null;
    if (CFG.isTeam) {
      if (slot.categoria == null || slot.categoria === '') slot.categoria = c.categoria || null;
      if (slot.coche == null || slot.coche === '') slot.coche = c.coche || null;
      slot.members = (c.members || []).map(n => ({ id: null, name: n }));
    }
    slot.confirmed = true;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function mixTanda(ti) {
    const slots = state.tandas[ti].slots;
    const head = shuffle(slots.slice(0, SEQ));
    head.forEach((s, i) => { slots[i] = s; });
    render();
  }
  function emptyTanda(ti) {
    state.tandas[ti].slots = padSlots([]);
    render();
  }
  function freeRoster() {
    const occ = occurrences();
    return state.roster.filter(r => !occ.has(r.key));
  }
  function fillTanda(ti) {
    const free = shuffle(freeRoster());
    const slots = state.tandas[ti].slots;
    for (let i = 0; i < SEQ && free.length; i++) if (!slots[i]) slots[i] = slotFromRoster(free.shift());
    render();
  }
  function placeFromRoster(r, ti, pos) {
    state.tandas[ti].slots[pos] = slotFromRoster(r);
    state.sel = null;
    render();
  }
  function moveLane(src, ti, pos) {
    if (src.ti === ti && src.pos === pos) { state.sel = null; render(); return; }
    const a = state.tandas[src.ti].slots, b = state.tandas[ti].slots;
    const moving = a[src.pos], displaced = b[pos];
    b[pos] = moving;
    a[src.pos] = displaced || null;
    state.sel = null;
    render();
  }
  function removeAt(ti, pos) {
    const slots = state.tandas[ti].slots;
    slots[pos] = null;
    state.sel = null;
    render();
  }
  function dropOn(ti, pos, src) {
    if (!src) return;
    if (src.kind === 'lane') moveLane(src, ti, pos);
    else {
      const r = state.roster.find(x => x.key === src.key);
      if (r) placeFromRoster(r, ti, pos);
    }
  }
  function addTanda() {
    if (state.tandas.length >= MAX_TANDAS) return;
    state.tandas.push({ slots: padSlots([]) });
    render();
  }
  function lessTanda(ti) {
    if (state.tandas.length <= 1) return;
    const idx = ti == null ? state.tandas.length - 1 : ti;
    if (filled(state.tandas[idx]) > 0) { state.ask = idx; render(); return; }
    state.tandas.splice(idx, 1);
    render();
  }

  // ── Dibujo ──────────────────────────────────────────────────────────────────
  const board = $('#tdBoard');
  const countBox = $('#tdCount');
  const askBox = $('#tdAsk');
  const summaryEl = $('#tdSummary');
  const errBox = $('#tdErrors');
  const previewBox = $('#tdPreview');
  const previewBtn = $('#tdPreviewBtn');
  const form = $('#tdForm');
  const auxPainters = [];

  function chipFor(pos, total, on) {
    const row = rowByPos.get(pos);
    const chip = el('span', 'td-chip' + (row && row.lane > 0 ? '' : ' td-chip--rest') + (on ? '' : ' is-off'), laneLabel(pos, total));
    if (row && row.lane > 0) { chip.style.background = row.color; chip.style.color = row.ink; }
    return chip;
  }
  function hasDetails() { return CFG.isTeam || CFG.showCat || CFG.showCar; }

  function buildDetails(slot) {
    const box = el('div', 'td-details');
    if (CFG.isTeam) {
      if (slot.members == null) {
        const c = CAT_BY_KEY.get(norm(slot.name));
        slot.members = c ? c.members.map(n => ({ id: null, name: n })) : [];
      }
      box.appendChild(el('div', 'td-details__t', I18N.t('client.tandas.miembros')));
      const list = el('div', 'td-members');
      const addInput = (m, n) => {
        const inp = el('input', 'vt-inp td-inp td-inp--sm');
        inp.type = 'text'; inp.value = m.name; inp.autocomplete = 'off';
        inp.placeholder = I18N.t('client.tandas.piloto_n', { n });
        inp.setAttribute('aria-label', inp.placeholder);
        inp.addEventListener('input', () => { m.name = inp.value; });
        list.appendChild(inp);
      };
      slot.members.forEach((m, i) => addInput(m, i + 1));
      if (CFG.canRestructure) {
        const more = el('button', 'vt-btn vt-btn--ghost vt-btn--sm', '+ ' + I18N.t('client.tandas.anadir_miembro'));
        more.type = 'button';
        more.addEventListener('click', () => {
          const m = { id: null, name: '' }; slot.members.push(m);
          addInput(m, slot.members.length);
          list.lastChild.focus();
        });
        if (!slot.members.length) more.click();
        box.appendChild(list); box.appendChild(more);
      } else box.appendChild(list);
    }
    if (CFG.showCat || CFG.showCar) {
      const attrs = el('div', 'td-attrs');
      const add = (prop, ph) => {
        const inp = el('input', 'vt-inp td-inp td-inp--sm');
        inp.type = 'text'; inp.autocomplete = 'off'; inp.placeholder = ph; inp.setAttribute('aria-label', ph);
        inp.value = slot[prop] || '';
        inp.addEventListener('input', () => { slot[prop] = inp.value; });
        attrs.appendChild(inp);
      };
      if (CFG.showCat) add('categoria', I18N.t('client.tandas.categoria'));
      if (CFG.showCar) add('coche', I18N.t('client.tandas.coche'));
      box.appendChild(attrs);
    }
    return box;
  }

  function detailsBtn(slot, rerender) {
    const b = el('button', 'td-det', (slot.open ? I18N.t('client.tandas.cerrar_detalles') : I18N.t('client.tandas.detalles')));
    b.type = 'button';
    b.setAttribute('aria-expanded', slot.open ? 'true' : 'false');
    b.addEventListener('click', e => { e.stopPropagation(); slot.open = !slot.open; rerender(); });
    return b;
  }

  // Sugerencias del catálogo (modo write).
  // Carril vacío con el foco: lista de lo del catálogo que aún no está en ninguna tanda (`browse`).
  function suggestionsFor(ti, pos) {
    if (MODE === 'rename' || state.sugHidden || !state.focus || state.focus.ti !== ti || state.focus.pos !== pos) return null;
    const slot = state.tandas[ti].slots[pos];
    if (!slot) {
      if (!CAT.length) return null;
      const occ = occurrences();
      const options = CAT.filter(c => !occ.has(c.key) && !OTHER.has(c.key)).slice(0, 8);
      return options.length ? { q: '', options, browse: true } : null;
    }
    if (slot.confirmed) return null;
    const q = norm(slot.name);
    if (!q || CAT_BY_KEY.has(q)) return null;
    const options = CAT.filter(c => c.key.startsWith(q) || c.key.split(' ').some(w => w.startsWith(q))).slice(0, 6);
    return { q, options };
  }
  const sugItems = sug => sug.options.map(c => ({ kind: 'cat', c })).concat(sug.browse ? [] : [{ kind: 'new' }]);

  function buildAux(ti, pos, occ) {
    const frag = document.createDocumentFragment();
    const slot = state.tandas[ti].slots[pos];
    const key = keyOf(slot);
    if (key) {
      if (sameTandaDup(ti, key, occ)) frag.appendChild(el('div', 'td-note td-note--bad', I18N.t('client.tandas.repetido_aqui')));
      else {
        const others = otherNumbers(ti, key, occ);
        if (others.length) frag.appendChild(el('div', 'td-note', I18N.t('client.tandas.tambien_en_tanda', { n: others.join(', ') })));
      }
    }
    const sug = suggestionsFor(ti, pos);
    if (sug) {
      const panel = el('div', 'td-sug');
      panel.setAttribute('role', 'listbox');
      if (sug.options.length) panel.appendChild(el('div', 'td-sug__h', I18N.t('client.tandas.del_catalogo')));
      const items = sugItems(sug);
      if (state.sugActive >= items.length) state.sugActive = 0;
      items.forEach((it, i) => {
        const b = el('button', 'td-sug__i' + (i === state.sugActive && (!sug.browse || state.sugMoved) ? ' is-active' : ''));
        b.type = 'button';
        b.setAttribute('role', 'option');
        if (it.kind === 'cat') {
          b.appendChild(el('span', null, it.c.name));
          const at = otherNumbers(ti, it.c.key, occ);
          if (!sug.browse || at.length) b.appendChild(el('span', 'td-sug__n', at.length ? I18N.t('client.tandas.ya_en_tanda', { n: at.join(', ') }) : I18N.t('client.tandas.intro_elegir')));
        } else {
          b.classList.add('td-sug__i--new');
          b.textContent = (CFG.isTeam ? I18N.t('client.tandas.apuntar_nuevo_equipo', { name: slot.name.trim() }) : I18N.t('client.tandas.apuntar_nuevo', { name: slot.name.trim() }));
        }
        b.addEventListener('mousedown', e => { e.preventDefault(); pickSuggestion(ti, pos, it); });
        panel.appendChild(b);
      });
      frag.appendChild(panel);
    }
    return frag;
  }

  function pickSuggestion(ti, pos, it) {
    let slot = state.tandas[ti].slots[pos];
    if (!slot && it.kind === 'cat') slot = state.tandas[ti].slots[pos] = mkSlot({ name: it.c.name });
    if (!slot) return;
    if (it.kind === 'cat') applyCatalog(slot, it.c); else slot.confirmed = true;
    state.focus = null;
    const next = nextInputAfter(pos);
    render();
    const target = $('#td-in-' + ti + '-' + (next != null ? next : pos));
    if (target) target.focus();
  }
  function displayOrder(ti) {
    const total = state.tandas[ti].slots.length;
    const order = CFG.rows.map(r => r.pos);
    for (let p = SEQ; p < total; p++) order.push(p);
    return MODE === 'rename' ? order.filter(p => state.tandas[ti].slots[p]) : order;
  }
  function nextInputAfter(pos) {
    const order = displayOrder(0);
    const i = order.indexOf(pos);
    return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
  }

  function buildWriteRow(ti, pos, occ, laneBox) {
    const t = state.tandas[ti];
    const slot = t.slots[pos];
    const isExtra = pos >= SEQ;
    const row = el('div', 'td-lane');
    const main = el('div', 'td-lane__main');
    const label = el('label', null);
    label.htmlFor = 'td-in-' + ti + '-' + pos;
    label.appendChild(chipFor(pos, t.slots.length, !!slot));
    const inp = el('input', 'vt-inp td-inp' + (slot ? '' : ' is-empty'));
    inp.id = 'td-in-' + ti + '-' + pos;
    inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.value = slot ? slot.name : '';
    inp.placeholder = isExtra ? I18N.t('client.tandas.descansa_extra') : I18N.t('client.tandas.descansa');
    main.appendChild(label); main.appendChild(inp);
    const detHolder = el('span', 'td-det-holder');
    main.appendChild(detHolder);
    if (isExtra && CFG.canRestructure) {
      const x = el('button', 'td-x'); x.type = 'button';
      x.setAttribute('aria-label', I18N.t('client.tandas.quitar_fila'));
      x.appendChild(svgIcon('M6 6l12 12M18 6L6 18', 14));
      x.addEventListener('click', () => { t.slots.splice(pos, 1); render(); });
      main.appendChild(x);
    }
    const aux = el('div', 'td-aux');
    row.appendChild(main); row.appendChild(aux);
    const detBox = el('div', 'td-details-wrap');
    row.appendChild(detBox);

    const paintDet = () => {
      detHolder.replaceChildren(); detBox.replaceChildren();
      const s = t.slots[pos];
      if (s && s.name.trim() && hasDetails()) {
        detHolder.appendChild(detailsBtn(s, paintDet));
        if (s.open) detBox.appendChild(buildDetails(s));
      }
    };
    const paintAux = () => { aux.replaceChildren(buildAux(ti, pos, occurrences())); };
    auxPainters.push(paintAux);
    paintDet(); aux.appendChild(buildAux(ti, pos, occ));

    inp.addEventListener('focus', () => { state.focus = { ti, pos }; state.sugActive = 0; state.sugMoved = false; state.sugHidden = false; paintAux(); });
    inp.addEventListener('blur', () => {
      setTimeout(() => {
        if (state.focus && state.focus.ti === ti && state.focus.pos === pos) {
          state.focus = null;
          const s = t.slots[pos];
          if (s && !s.confirmed) s.confirmed = true;
          paintAux();
        }
      }, 140);
    });
    inp.addEventListener('input', () => {
      const v = inp.value;
      if (MODE === 'rename') {
        if (t.slots[pos]) t.slots[pos].name = v;
        lightUpdate(ti);
        return;
      }
      if (!v.trim()) t.slots[pos] = null;
      else {
        let s = t.slots[pos];
        if (!s) s = t.slots[pos] = mkSlot({ name: v });
        s.name = v; s.confirmed = false;
        if (s.catalogId) {
          const c = CAT.find(x => x.id === s.catalogId);
          if (!c || norm(c.name) !== norm(v)) s.catalogId = null;
        }
      }
      state.focus = { ti, pos }; state.sugActive = 0; state.sugMoved = false; state.sugHidden = false;
      inp.classList.toggle('is-empty', !t.slots[pos]);
      const chip = main.querySelector('.td-chip'); if (chip) chip.classList.toggle('is-off', !t.slots[pos]);
      paintDet(); paintAux();
      lightUpdate(ti);
    });
    inp.addEventListener('keydown', e => {
      const sug = suggestionsFor(ti, pos);
      if (e.key === 'Enter') {
        e.preventDefault();
        if (sug && (!sug.browse || state.sugMoved)) {
          const items = sugItems(sug);
          pickSuggestion(ti, pos, items[Math.min(state.sugActive, items.length - 1)]);
        } else {
          const next = nextInputAfter(pos);
          const target = $('#td-in-' + ti + '-' + (next != null ? next : pos));
          if (target) target.focus();
        }
      } else if (sug && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const n = sugItems(sug).length;
        if (sug.browse && !state.sugMoved) state.sugActive = e.key === 'ArrowDown' ? 0 : n - 1;
        else state.sugActive = (state.sugActive + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        state.sugMoved = true;
        paintAux();
      } else if (e.key === 'Escape' && sug) {
        const s = t.slots[pos]; if (s) s.confirmed = true; else state.sugHidden = true;
        paintAux();
      }
    });
    return row;
  }

  // Modo arrastrar: una fila de carril.
  function buildDragRow(ti, pos) {
    const t = state.tandas[ti];
    const slot = t.slots[pos];
    const isExtra = pos >= SEQ;
    const sel = state.sel;
    const row = el('div', 'td-lane td-lane--drag' + (slot ? ' is-filled' : '') + (!slot && sel ? ' is-target' : ''));
    const main = el('div', 'td-lane__main');
    main.appendChild(chipFor(pos, t.slots.length, !!slot));
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('is-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('is-over'));
    row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('is-over'); dropOn(ti, pos, dragSrc); dragSrc = null; });
    row.addEventListener('click', () => {
      if (!state.sel) return;
      dropOn(ti, pos, state.sel);
    });
    if (slot) {
      const name = el('span', 'td-lane__name' + (state.sel && state.sel.kind === 'lane' && state.sel.ti === ti && state.sel.pos === pos ? ' is-sel' : ''), slot.name);
      name.draggable = true;
      name.addEventListener('dragstart', e => { dragSrc = { kind: 'lane', ti, pos }; e.dataTransfer.setData('text/plain', slot.name); e.dataTransfer.effectAllowed = 'move'; });
      name.addEventListener('click', e => {
        e.stopPropagation();
        const same = state.sel && state.sel.kind === 'lane' && state.sel.ti === ti && state.sel.pos === pos;
        if (state.sel && !same) { dropOn(ti, pos, state.sel); return; }
        state.sel = same ? null : { kind: 'lane', ti, pos };
        render();
      });
      main.appendChild(name);
      if (hasDetails()) { const d = detailsBtn(slot, render); main.appendChild(d); }
      const x = el('button', 'td-x'); x.type = 'button';
      x.setAttribute('aria-label', I18N.t('client.tandas.quitar_del_carril'));
      x.appendChild(svgIcon('M6 6l12 12M18 6L6 18', 14));
      x.addEventListener('click', e => {
        e.stopPropagation();
        if (isExtra) { t.slots.splice(pos, 1); state.sel = null; render(); } else removeAt(ti, pos);
      });
      main.appendChild(x);
    } else {
      const txt = state.sel
        ? I18N.t('client.tandas.toca_para_poner', { name: (state.sel.kind === 'lane' ? state.tandas[state.sel.ti].slots[state.sel.pos].name : state.sel.name).split(' ')[0] })
        : I18N.t('client.tandas.suelta_aqui');
      main.appendChild(el('span', 'td-lane__empty', txt));
      if (isExtra) {
        const x = el('button', 'td-x'); x.type = 'button';
        x.setAttribute('aria-label', I18N.t('client.tandas.quitar_fila'));
        x.appendChild(svgIcon('M6 6l12 12M18 6L6 18', 14));
        x.addEventListener('click', e => { e.stopPropagation(); t.slots.splice(pos, 1); render(); });
        main.appendChild(x);
      }
    }
    row.appendChild(main);
    if (slot && slot.open && hasDetails()) row.appendChild(buildDetails(slot));
    return row;
  }

  function countBadge(ti) {
    const t = state.tandas[ti];
    let used = 0;
    CFG.rows.forEach(r => { if (r.lane > 0 && t.slots[r.pos] && t.slots[r.pos].name.trim()) used++; });
    const b = el('span', 'td-count ' + (used === ACTIVE_LANES ? 'is-full' : used === 0 ? 'is-none' : 'is-some'),
      I18N.t('client.tandas.de', { k: used, l: ACTIVE_LANES }));
    b.dataset.tdCount = ti;
    return b;
  }

  function buildCard(ti, occ) {
    const t = state.tandas[ti];
    const card = el('section', 'vt-card td-card' + (ERR_BY_TANDA.has(numberOf(ti)) || state.clientErrors.includes(ti) ? ' td-card--err' : ''));
    card.dataset.ti = ti;
    const head = el('div', 'td-card__h');
    head.appendChild(el('h2', null, I18N.t('client.tandas.tanda_n', { n: numberOf(ti) })));
    const right = el('span', 'td-card__r');
    right.appendChild(countBadge(ti));
    if (MODE === 'drag' && CFG.createAll && state.tandas.length > 1) {
      const rm = el('button', 'td-x'); rm.type = 'button';
      rm.setAttribute('aria-label', I18N.t('client.tandas.quitar_tanda'));
      rm.title = I18N.t('client.tandas.quitar_tanda');
      rm.appendChild(svgIcon('M6 6l12 12M18 6L6 18', 14));
      rm.addEventListener('click', () => lessTanda(ti));
      right.appendChild(rm);
    }
    head.appendChild(right);
    card.appendChild(head);

    const lanes = el('div', 'td-lanes');
    let lastCi = null;
    displayOrder(ti).forEach(pos => {
      const row = rowByPos.get(pos);
      if (CFG.multiCircuit && row && row.lane > 0 && row.ci !== lastCi) {
        lastCi = row.ci;
        lanes.appendChild(el('div', 'td-circuit', I18N.t('client.tandas.circuito_n', { n: row.ci + 1 })));
      }
      lanes.appendChild(MODE === 'drag' ? buildDragRow(ti, pos) : buildWriteRow(ti, pos, occ));
    });
    card.appendChild(lanes);

    const tools = el('div', 'td-tools');
    if (CFG.canRestructure) {
      const more = el('button', 'vt-btn vt-btn--ghost vt-btn--sm', '+ ' + I18N.t('client.tandas.anadir_descanso'));
      more.type = 'button';
      more.addEventListener('click', () => { t.slots.push(null); render(); });
      tools.appendChild(more);
      if (MODE === 'drag') {
        const fill = el('button', 'vt-btn vt-btn--ghost vt-btn--sm', I18N.t('client.tandas.rellenar_azar')); fill.type = 'button';
        fill.addEventListener('click', () => fillTanda(ti));
        tools.appendChild(fill);
      } else {
        const mix = el('button', 'vt-btn vt-btn--ghost vt-btn--sm', I18N.t('client.tandas.mezclar')); mix.type = 'button';
        mix.addEventListener('click', () => mixTanda(ti));
        tools.appendChild(mix);
      }
      const clr = el('button', 'vt-btn vt-btn--ghost vt-btn--sm', I18N.t('client.tandas.vaciar')); clr.type = 'button';
      clr.addEventListener('click', () => emptyTanda(ti));
      tools.appendChild(clr);
    }
    card.appendChild(tools);
    return card;
  }

  // Lista de participantes (modo arrastrar).
  let dragSrc = null;
  function buildPool(occ) {
    const side = el('aside', 'vt-card td-pool');
    side.addEventListener('dragover', e => { if (dragSrc && dragSrc.kind === 'lane') { e.preventDefault(); side.classList.add('is-over'); } });
    side.addEventListener('dragleave', e => { if (e.target === side) side.classList.remove('is-over'); });
    side.addEventListener('drop', e => {
      e.preventDefault(); side.classList.remove('is-over');
      if (dragSrc && dragSrc.kind === 'lane') removeAt(dragSrc.ti, dragSrc.pos);
      dragSrc = null;
    });
    const free = freeRoster();
    const h = el('div', 'td-pool__h');
    h.appendChild(el('h2', null, (CFG.isTeam ? I18N.t('client.tandas.equipos') : I18N.t('client.tandas.pilotos'))));
    h.appendChild(el('span', 'td-pool__c', I18N.t('client.tandas.sin_tanda_n', { n: free.length })));
    side.appendChild(h);

    const add = el('div', 'td-pool__add');
    const inp = el('input', 'vt-inp td-inp'); inp.type = 'text'; inp.autocomplete = 'off';
    inp.value = state.filter;
    inp.placeholder = (CFG.isTeam ? I18N.t('client.tandas.nuevo_equipo_ph') : I18N.t('client.tandas.nuevo_piloto_ph'));
    inp.setAttribute('aria-label', inp.placeholder);
    const btn = el('button', 'vt-btn vt-btn--ghost', I18N.t('client.tandas.anadir')); btn.type = 'button';
    const doAdd = () => {
      const v = inp.value.trim();
      if (v.length < 1) return;
      addToRoster(v);
      state.filter = '';
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      const next = board.querySelector('.td-pool__add input');
      if (next) next.focus({ preventScroll: true });
    };
    btn.addEventListener('click', doAdd);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    inp.addEventListener('input', () => { state.filter = inp.value; paintList(); });
    add.appendChild(inp); add.appendChild(btn);
    side.appendChild(add);

    side.appendChild(el('div', 'td-pool__lbl', I18N.t('client.tandas.sin_tanda')));
    const listFree = el('div', 'td-pool__list');
    const empty = el('div', 'td-pool__ok', state.roster.length === 0
      ? I18N.t('client.tandas.lista_vacia')
      : (CFG.isTeam ? I18N.t('client.tandas.todos_tienen_tanda_equipos') : I18N.t('client.tandas.todos_tienen_tanda')));
    side.appendChild(listFree);
    side.appendChild(empty);

    const lblPlaced = el('div', 'td-pool__lbl', I18N.t('client.tandas.ya_en_una_tanda'));
    const listPlaced = el('div', 'td-pool__list');
    side.appendChild(lblPlaced);
    side.appendChild(listPlaced);

    const poolItem = (r, kind, extra) => {
      const b = el('button', 'td-pil' + (state.sel && state.sel.kind === 'pool' && state.sel.key === r.key ? ' is-sel' : ''));
      b.type = 'button'; b.draggable = true;
      b.appendChild(svgIcon('M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', 14));
      b.appendChild(el('span', 'td-pil__n', r.name));
      if (extra) b.appendChild(el('span', 'td-pil__x', extra));
      b.addEventListener('dragstart', e => { dragSrc = { kind: 'pool', key: r.key }; e.dataTransfer.setData('text/plain', r.name); e.dataTransfer.effectAllowed = 'copyMove'; });
      b.addEventListener('click', () => {
        const same = state.sel && state.sel.kind === 'pool' && state.sel.key === r.key;
        state.sel = same ? null : { kind: 'pool', key: r.key, name: r.name };
        render();
      });
      return b;
    };
    function paintList() {
      const q = norm(state.filter);
      listFree.replaceChildren();
      const shown = free.filter(r => !q || r.key.includes(q));
      shown.forEach(r => {
        const saved = OTHER.get(r.key);
        listFree.appendChild(poolItem(r, 'pool', saved && saved.length ? I18N.t('client.tandas.ya_en_tanda', { n: saved.join(', ') }) : ''));
      });
      empty.hidden = free.length > 0;
    }
    paintList();

    const seen = new Set();
    state.tandas.forEach((t, ti) => t.slots.forEach((s, pos) => {
      const k = keyOf(s); if (!k || seen.has(k)) return;
      seen.add(k);
      const r = state.roster.find(x => x.key === k) || { key: k, name: s.name };
      const lane = laneOf(pos);
      const where = I18N.t('client.tandas.donde', { t: numberOf(ti), c: lane > 0 ? I18N.t('client.tandas.c_n', { n: lane }) : dscLabel(pos, t.slots.length) });
      listPlaced.appendChild(poolItem(r, 'copy', where));
    }));
    lblPlaced.hidden = listPlaced.hidden = seen.size === 0;
    return side;
  }

  function buildAddTile() {
    const b = el('button', 'td-addtile'); b.type = 'button';
    b.appendChild(svgIcon('M12 5v14M5 12h14', 28));
    b.appendChild(el('span', null, I18N.t('client.tandas.anadir_tanda')));
    b.addEventListener('click', addTanda);
    return b;
  }

  function buildCount() {
    countBox.replaceChildren();
    if (!(CFG.createAll && MODE !== 'drag')) { countBox.hidden = true; return; }
    countBox.hidden = false;
    const txt = el('div', 'td-count-box__t');
    txt.appendChild(el('span', 'td-count-box__q', I18N.t('client.tandas.cuantas_tandas')));
    txt.appendChild(el('span', 'td-count-box__d', I18N.t('client.tandas.cuantas_tandas_desc', { n: ACTIVE_LANES })));
    const step = el('div', 'td-step');
    const less = el('button', 'td-step__b'); less.type = 'button';
    less.setAttribute('aria-label', I18N.t('client.tandas.una_menos'));
    less.appendChild(svgIcon('M5 12h14', 20));
    less.addEventListener('click', () => lessTanda(null));
    const more = el('button', 'td-step__b'); more.type = 'button';
    more.setAttribute('aria-label', I18N.t('client.tandas.una_mas'));
    more.appendChild(svgIcon('M12 5v14M5 12h14', 20));
    more.addEventListener('click', addTanda);
    const n = el('span', 'td-step__n', String(state.tandas.length));
    n.setAttribute('aria-live', 'polite');
    step.appendChild(less); step.appendChild(n); step.appendChild(more);
    countBox.appendChild(txt); countBox.appendChild(step);
  }

  function buildAsk() {
    askBox.replaceChildren();
    if (state.ask == null) { askBox.hidden = true; return; }
    askBox.hidden = false;
    const ti = state.ask;
    const n = filled(state.tandas[ti]);
    askBox.appendChild(svgIcon('M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z', 22));
    askBox.appendChild(el('span', 'td-ask__t', (n === 1 ? I18N.t('client.tandas.ask_borrar_uno', { n: numberOf(ti), a: noun(n) }) : I18N.t('client.tandas.ask_borrar', { n: numberOf(ti), a: noun(n) }))));
    const no = el('button', 'vt-btn vt-btn--ghost td-ask__b', I18N.t('client.tandas.no_dejarla')); no.type = 'button';
    no.addEventListener('click', () => { state.ask = null; render(); });
    const yes = el('button', 'vt-btn vt-btn--primary td-ask__b', I18N.t('client.tandas.si_borrar')); yes.type = 'button';
    yes.addEventListener('click', () => { state.tandas.splice(ti, 1); state.ask = null; render(); });
    askBox.appendChild(no); askBox.appendChild(yes);
  }

  function summaryText() {
    const c = counts();
    const m = state.tandas.length;
    const a = noun(c.pilots);
    const b = (m === 1 ? I18N.t('client.tandas.tanda_una', { n: m }) : I18N.t('client.tandas.tanda_varias', { n: m }));
    const d = (c.free === 1 ? I18N.t('client.tandas.descansa_uno', { n: c.free }) : I18N.t('client.tandas.descansa_varios', { n: c.free }));
    return I18N.t('client.tandas.resumen', { a, b, c: d });
  }
  function lightUpdate(ti) {
    auxPainters.forEach(f => f());
    const old = board.querySelector('[data-td-count="' + ti + '"]');
    if (old) old.replaceWith(countBadge(ti));
    summaryEl.textContent = summaryText();
    if (state.preview) schedulePreview();
  }

  function render() {
    auxPainters.length = 0;
    buildCount(); buildAsk();
    const occ = occurrences();
    board.replaceChildren();
    board.className = 'td-board td-board--' + (MODE === 'drag' ? 'drag' : 'write');
    if (MODE === 'drag') board.appendChild(buildPool(occ));
    const grid = el('div', 'td-grid');
    state.tandas.forEach((_, ti) => grid.appendChild(buildCard(ti, occ)));
    if (MODE === 'drag' && CFG.createAll && state.tandas.length < MAX_TANDAS) grid.appendChild(buildAddTile());
    board.appendChild(grid);
    summaryEl.textContent = summaryText();
    const btn = $('#tdSubmit');
    if (btn && CFG.createAll) btn.firstChild.textContent = (state.tandas.length === 1 ? I18N.t('client.tandas.crear_una') : I18N.t('client.tandas.crear_varias')) + ' ';
    const another = $('#tdAnother');
    if (another) another.hidden = state.tandas.length !== 1;
    if (state.preview) schedulePreview();
  }

  // ── Vista previa de las mangas (la calcula el servidor con buildSchedule) ───
  let pvTimer = null, pvSeq = 0;
  const PV_MAX = 60;
  function slotNames(t) {
    const names = t.slots.map(s => (s && s.name.trim()) || null);
    return names;
  }
  function currentMode() {
    const r = document.querySelector('input[name="empty_lane_mode"]:checked');
    return r ? r.value : 'rotate';
  }
  function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(runPreview, 250); }
  async function runPreview() {
    const seq = ++pvSeq;
    const out = [];
    for (let ti = 0; ti < state.tandas.length; ti++) {
      const names = slotNames(state.tandas[ti]);
      if (!names.some(Boolean)) continue;
      try {
        const r = await fetch(PREVIEW_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slots: names, mode: currentMode() }) });
        if (!r.ok) continue;
        out.push({ ti, data: await r.json() });
      } catch (_) { /* sin vista previa */ }
      if (seq !== pvSeq) return;
    }
    if (seq !== pvSeq) return;
    renderPreview(out);
  }
  function previewTable(d) {
    const table = el('table', 'td-pv__table');
    const used = new Set(d.usedLanes || []);
    const hasRests = d.mangas.some(m => m.rests.length);
    const thead = el('thead'), hr = el('tr');
    hr.appendChild(el('th', 'td-pv__m', I18N.t('client.tanda-new.manga')));
    d.lanes.forEach(l => {
      const th = el('th', null, I18N.t('client.tanda-new.carril_n', { n: l }));
      th.style.borderBottomColor = CFG.colors[(l - 1) % CFG.colors.length];
      hr.appendChild(th);
    });
    if (hasRests) hr.appendChild(el('th', null, I18N.t('client.tanda-new.descansan')));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el('tbody');
    d.mangas.slice(0, PV_MAX).forEach((m, i) => {
      const tr = el('tr');
      tr.appendChild(el('th', 'td-pv__m', I18N.t('client.tanda-new.manga_n', { n: i + 1 })));
      d.lanes.forEach(l => {
        if (m.byLane[l]) tr.appendChild(el('td', null, m.byLane[l]));
        else if (!used.has(l)) tr.appendChild(el('td', 'td-pv__off', I18N.t('client.tanda-new.no_se_usa')));
        else tr.appendChild(el('td', 'td-pv__free', I18N.t('client.tanda-new.libre')));
      });
      if (hasRests) tr.appendChild(el('td', 'td-pv__rest', m.rests.join(', ')));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const restN = Math.max(0, ...d.mangas.map(m => m.rests.length));
    const off = d.lanes.filter(l => !used.has(l));
    const parts = [I18N.t('client.tanda-new.preview_n_mangas', { n: d.mangas.length })];
    if (restN > 0) parts.push(I18N.t('client.tanda-new.preview_descansan', { n: restN }));
    if (off.length) parts.push(I18N.t('client.tanda-new.preview_no_se_usan', { lanes: off.join(', ') }));
    if (d.mangas.length > PV_MAX) parts.push(I18N.t('client.tanda-new.preview_primeras', { n: PV_MAX }));
    return { table, sum: parts.join(' ') };
  }
  function renderPreview(list) {
    previewBox.replaceChildren();
    previewBox.hidden = !state.preview;
    if (!state.preview) return;
    previewBox.appendChild(el('h2', 'td-pv__title', I18N.t('client.tandas.asi_quedan_mangas')));
    if (!list.length) previewBox.appendChild(el('p', 'td-pv__sum', I18N.t('client.tandas.nada_que_ver')));
    list.forEach(({ ti, data }) => {
      const block = el('div', 'td-pv__block');
      block.appendChild(el('h3', null, I18N.t('client.tandas.tanda_n', { n: numberOf(ti) })));
      const { table, sum } = previewTable(data);
      block.appendChild(el('p', 'td-pv__sum', sum));
      const wrap = el('div', 'td-pv__wrap'); wrap.appendChild(table);
      block.appendChild(wrap);
      previewBox.appendChild(block);
    });
  }
  if (previewBtn) previewBtn.addEventListener('click', () => {
      state.preview = !state.preview;
      previewBtn.textContent = (state.preview ? I18N.t('client.tandas.ocultar_mangas') : I18N.t('client.tandas.ver_mangas'));
      if (state.preview) { previewBox.hidden = false; runPreview(); previewBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      else previewBox.hidden = true;
  });
  document.querySelectorAll('input[name="empty_lane_mode"]').forEach(r => r.addEventListener('change', () => { if (state.preview) schedulePreview(); }));

  // ── Envío ───────────────────────────────────────────────────────────────────
  function slotPayload(s) {
    if (!s || !s.name.trim()) return null;
    const out = { name: s.name.trim() };
    if (s.id) out.id = s.id;
    const cat = CAT_BY_KEY.get(norm(s.name));
    if (CFG.isTeam) out.catalogId = s.catalogId || (cat ? cat.id : null);
    if (s.categoria != null) out.categoria = s.categoria;
    if (s.coche != null) out.coche = s.coche;
    if (s.members) out.members = s.members.filter(m => m.name.trim() || m.id).map(m => ({ id: m.id, name: m.name.trim() }));
    return out;
  }
  function validate() {
    const bad = [], msgs = [];
    const occ = occurrences();
    state.tandas.forEach((t, ti) => {
      if (!filled(t)) { bad.push(ti); msgs.push(I18N.t('client.tandas.err_vacia', { n: numberOf(ti) })); return; }
      for (const [k, list] of occ) {
        if (list.filter(o => o.ti === ti).length > 1) { bad.push(ti); msgs.push(I18N.t('client.tandas.err_repetidos', { n: numberOf(ti) })); break; }
      }
    });
    return { bad, msgs };
  }
  form.addEventListener('submit', e => {
    const v = validate();
    state.clientErrors = v.bad;
    errBox.replaceChildren();
    if (v.msgs.length) {
      e.preventDefault();
      errBox.hidden = false;
      v.msgs.forEach(m => errBox.appendChild(el('p', null, m)));
      render();
      errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    errBox.hidden = true;
    const payload = { mode: currentMode(), tandas: state.tandas.map(t => ({ slots: t.slots.map(slotPayload) })) };
    $('#tdPayload').value = JSON.stringify(payload);
    const another = $('#tdAfter');
    if (another) another.disabled = !(e.submitter && e.submitter.id === 'tdAnother');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.sel) { state.sel = null; render(); }
  });

  if (previewBtn) previewBtn.textContent = I18N.t('client.tandas.ver_mangas');
  render();
})();
