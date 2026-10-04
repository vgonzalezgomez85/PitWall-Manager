/* Buscador de listas de catálogo (pilotos, equipos, coches).
   Marcado: <input data-list-search="#ambito">; dentro del ámbito filtra las
   filas de tabla (tbody tr) y las filas .vt-list-row por su texto, oculta las
   secciones (.vt-list-section) que se quedan vacías y actualiza el contador
   [data-list-search-count]. «/» enfoca el buscador; Esc lo vacía. */
(function () {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

  document.querySelectorAll('input[data-list-search]').forEach((input) => {
    const scope = document.querySelector(input.dataset.listSearch);
    if (!scope) return;
    const rows = [...scope.querySelectorAll('tbody tr, .vt-list-row')];
    const text = new Map(rows.map(r => [r, norm(r.textContent + ' ' + (r.dataset.searchExtra || ''))]));
    const sections = [...scope.querySelectorAll('.vt-list-section')];
    const count = document.querySelector('[data-list-search-count]');
    const empty = document.querySelector('[data-list-search-empty]');
    const total = rows.length;
    const key = 'pw:search:' + location.pathname;

    function apply() {
      const terms = norm(input.value.trim()).split(' ').filter(Boolean);
      let shown = 0;
      rows.forEach(r => {
        const hit = terms.every(t => text.get(r).includes(t));
        r.hidden = !hit;
        if (hit) shown++;
      });
      sections.forEach(s => {
        s.hidden = !!terms.length && !s.querySelector('.vt-list-row:not([hidden])');
      });
      if (count) count.textContent = terms.length ? `${shown} / ${total}` : String(total);
      if (empty) empty.hidden = !terms.length || shown > 0;
      try { sessionStorage.setItem(key, input.value); } catch (_) {}
    }

    input.addEventListener('input', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; apply(); input.blur(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
    // Al volver de editar uno, el filtro sigue puesto.
    try { const saved = sessionStorage.getItem(key); if (saved) input.value = saved; } catch (_) {}
    apply();
  });
})();
