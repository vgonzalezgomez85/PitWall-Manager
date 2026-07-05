/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* ════════════════════════════════════════════════════════════════════════
   SEMAPHORE — F1-style gantry (compartido)
   ════════════════════════════════════════════════════════════════════════

   Expone tres funciones globales:

     showSemaphore()            → crea el overlay y enciende secuencia roja
                                  (3 luces a t=0 / 833 / 1666 ms) con beep.
     semaphoreStep()            → A2 del DS-300: pasa las 3 luces a verde
                                  + acorde GO.
     semaphoreGo(callback)      → A3 del DS-300: garantiza verde, deja el
                                  overlay 50ms más, lo retira y llama cb.

   Estos métodos son llamados desde:
     - public/js/live.js              (race live)
     - public/js/training.js          (training live)
     - inline en pole-timing.ejs      (vía socket.on)
     - inline en training/free.ejs    (vía socket.on, autostart)

   Secuencia DS-300:
     A1 (t=0)    → sl1 rojo (440 Hz)
     t=833       → sl2 rojo (540 Hz)
     t=1666      → sl3 rojo (640 Hz)
     A2 (t≈2500) → todas → verde (acorde 880+1320 Hz)
     A3 (t≈2953) → overlay desaparece a t=3000 (50 ms de verde extra)
     Fallback duro: si A3 no llega a los 6000 ms, semaphoreGo() se fuerza.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  const TOTAL_MS = 3000;
  const FALLBACK_MS = 6000;

  let _l2Timer = null, _l3Timer = null, _fbTimer = null, _startedAt = 0;
  let _goBeeped = false;

  // ── Audio ─────────────────────────────────────────────────────────────
  // Los navegadores bloquean AudioContext hasta que haya un gesto del
  // usuario en la página. Como el GO físico del DS-300 entra por socket
  // sin gesto, desbloqueamos el contexto en el primer click/tecla/touch.
  let _actx = null;
  function _ensureActx() {
    if (!_actx) {
      try { _actx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (_actx.state === 'suspended') _actx.resume().catch(() => {});
    return _actx;
  }
  ['click', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, () => _ensureActx(), { passive: true })
  );

  function _beep(freq, dur, type, gain) {
    try {
      const ctx = _ensureActx();
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain != null ? gain : 0.18, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + dur);
    } catch (e) {}
  }
  function _goBeep() {
    if (_goBeeped) return;
    _goBeeped = true;
    // Acorde de quinta justa (880 + 1320 Hz) — sonido "lights out" F1
    _beep(880,  0.5, 'sine', 0.22);
    _beep(1320, 0.5, 'sine', 0.14);
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function _setLightsGo() {
    [1, 2, 3].forEach(n => {
      const el = document.getElementById('sl' + n);
      if (!el) return;
      el.classList.remove('lit');
      el.classList.add('go');
    });
  }
  function _clearTimers() {
    if (_l2Timer) { clearTimeout(_l2Timer); _l2Timer = null; }
    if (_l3Timer) { clearTimeout(_l3Timer); _l3Timer = null; }
    if (_fbTimer) { clearTimeout(_fbTimer); _fbTimer = null; }
  }

  // ── API pública ───────────────────────────────────────────────────────
  function showSemaphore() {
    if (document.getElementById('semaphore-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'semaphore-overlay';
    ov.className = 'semaphore-overlay';
    ov.innerHTML =
      '<div class="semaphore-panel">' +
        '<div class="s-light" id="sl1"></div>' +
        '<div class="s-light" id="sl2"></div>' +
        '<div class="s-light" id="sl3"></div>' +
      '</div>';
    document.body.appendChild(ov);
    _startedAt = Date.now();
    _goBeeped = false;

    document.getElementById('sl1')?.classList.add('lit');
    _beep(440, 0.13, 'square', 0.18);

    _l2Timer = setTimeout(() => {
      document.getElementById('sl2')?.classList.add('lit');
      _beep(540, 0.13, 'square', 0.18);
    }, 833);

    _l3Timer = setTimeout(() => {
      document.getElementById('sl3')?.classList.add('lit');
      _beep(640, 0.13, 'square', 0.18);
    }, 1666);

    // Fallback duro: si A3 no llega a los 6 s, forzamos GO igualmente.
    _fbTimer = setTimeout(() => semaphoreGo(null), FALLBACK_MS);
  }

  function semaphoreStep() {
    _clearTimers();
    _setLightsGo();
    _goBeep();
  }

  function semaphoreGo(callback) {
    _clearTimers();
    _setLightsGo();
    _goBeep();
    const elapsed = Date.now() - _startedAt;
    const wait = Math.max(0, TOTAL_MS - elapsed);
    setTimeout(() => {
      document.getElementById('semaphore-overlay')?.remove();
      if (callback) callback();
    }, wait);
  }

  // Exponer en window para que cualquier script pueda llamarlas
  window.showSemaphore = showSemaphore;
  window.semaphoreStep = semaphoreStep;
  window.semaphoreGo   = semaphoreGo;
})();
