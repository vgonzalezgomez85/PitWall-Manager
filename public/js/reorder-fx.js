// ── ReorderFX ────────────────────────────────────────────────────────────────
// Transición FLIP (First-Last-Invert-Play) compartida por todas las vistas con
// una clasificación que se reordena en vivo (live.ejs, live-panel.ejs,
// live-panel-fastest.ejs, tv.ejs, lemans.ejs): en vez de que la fila/tarjeta
// salte de golpe a su posición nueva, se desliza — y si cambió de puesto desde
// el render anterior, un destello verde (sube) o rojo (baja) la marca.
//
// Cada elemento animable necesita `data-rfx-key="<id estable>"` (no el índice:
// tiene que sobrevivir a que otras filas se muevan). Uso:
//
//   const finish = ReorderFX.capture(container);   // ANTES de reordenar/cambiar el DOM
//   ...reordenar el DOM (appendChild en el orden final) o cambiar CSS `order`...
//   finish(nuevoOrdenDeKeys);                        // dispara la animación
//
// Requiere en el CSS del contenedor una transición de `transform` y clases
// `.rfx-up` / `.rfx-down` con el destello (ver live.css / <style> de cada panel).
window.ReorderFX = (function () {
  const rankMemory = new WeakMap(); // container → Map(key → rank del último render)

  function capture(container) {
    const before = new Map();
    container.querySelectorAll('[data-rfx-key]').forEach(el => {
      before.set(el.dataset.rfxKey, el.getBoundingClientRect());
    });

    return function play(orderedKeys) {
      const prevRanks = rankMemory.get(container) || new Map();
      const nextRanks = new Map();
      orderedKeys.forEach((k, i) => nextRanks.set(String(k), i));
      rankMemory.set(container, nextRanks);

      container.querySelectorAll('[data-rfx-key]').forEach(el => {
        const key = el.dataset.rfxKey;
        el.classList.remove('rfx-up', 'rfx-down');

        const oldRect = before.get(key);
        if (oldRect) {
          const newRect = el.getBoundingClientRect();
          const dx = oldRect.left - newRect.left;
          const dy = oldRect.top  - newRect.top;
          if (dx || dy) {
            el.style.transition = 'none';
            el.style.transform  = `translate(${dx}px, ${dy}px)`;
            el.getBoundingClientRect(); // fuerza el reflow para que el invert se pinte
            el.style.transition = '';
            el.style.transform  = '';
          }
        }

        const prevRank = prevRanks.get(key);
        const nextRank = nextRanks.get(key);
        if (prevRank != null && nextRank != null && prevRank !== nextRank) {
          void el.offsetWidth; // permite re-disparar la animación si ya estaba en curso
          el.classList.add(nextRank < prevRank ? 'rfx-up' : 'rfx-down');
        }
      });
    };
  }

  // Reconcilia `container` para que sus hijos (identificados por
  // data-rfx-key) queden en el mismo orden que `items`, reutilizando los
  // nodos existentes y creando/soltando solo lo que aparece o desaparece.
  // `renderFn(item, existingEl|null)` debe devolver el elemento (nuevo o
  // reutilizado) ya actualizado con el contenido de `item`.
  function reconcile(container, items, keyFn, renderFn) {
    const existing = new Map();
    container.querySelectorAll('[data-rfx-key]').forEach(el => existing.set(el.dataset.rfxKey, el));
    const used = new Set();

    items.forEach(item => {
      const key = String(keyFn(item));
      const el = renderFn(item, existing.get(key) || null);
      el.dataset.rfxKey = key;
      container.appendChild(el); // inserta o mueve al final → secuencia = orden final
      used.add(key);
    });

    existing.forEach((el, key) => { if (!used.has(key)) el.remove(); });
  }

  // Combina reconcile() + capture()/play() en una sola llamada: el caso común
  // de los paneles que hoy hacen `innerHTML = rows.map(...).join('')`.
  function reconcileAnimated(container, items, keyFn, renderFn) {
    const finish = capture(container);
    reconcile(container, items, keyFn, renderFn);
    finish(items.map(item => String(keyFn(item))));
  }

  return { capture, reconcile, reconcileAnimated };
})();
