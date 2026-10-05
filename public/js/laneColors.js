// Editor de colores de carril (Configuración y ficha del circuito). Cada
// muestra es un <label class="lc-swatch"> con un <input type="color"> dentro.
(function () {
  function ink(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    const lin = (i) => {
      const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
    return L > 0.4 ? '#000' : '#fff';
  }

  function paint(input) {
    const sw = input.closest('.lc-swatch');
    if (!sw) return;
    sw.style.background = input.value;
    sw.style.color = ink(input.value);
  }

  function bind(grid, onChange) {
    if (!grid) return;
    grid.addEventListener('input', (e) => {
      if (e.target.matches('input[type="color"]')) {
        paint(e.target);
        if (onChange) onChange(e.target);
      }
    });
  }

  function setAll(grid, colors) {
    grid.querySelectorAll('input[type="color"]').forEach((inp, i) => {
      if (colors[i]) { inp.value = colors[i]; paint(inp); }
    });
  }

  function values(grid) {
    return [...grid.querySelectorAll('input[type="color"]')].map(i => i.value.toLowerCase());
  }

  window.PWLaneColors = { ink, bind, setAll, values };
})();
