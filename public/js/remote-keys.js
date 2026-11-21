/*
 * Control remoto (teclado de macros). `window.pwRemote(action)` pulsa el botón de
 * software de la pantalla (GO / pausa-reanudar / STOP) y devuelve true si ha
 * actuado. Lo llama la app de escritorio con un atajo global (electron/main.js)
 * y, en el navegador, el keydown de más abajo. Los botones se marcan con
 * data-remote="go|pause|resume|stop".
 */
(function () {
  var STOP_WINDOW_MS = 3000;
  var REPEAT_GUARD_MS = 400;
  var stopArmedUntil = 0;
  var lastAt = {};
  var toastEl = null, toastTimer = null;

  function toast(text, kind, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483000;' +
        'padding:14px 26px;border-radius:12px;font:700 22px/1.2 system-ui,sans-serif;color:#fff;' +
        'box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:none;max-width:90vw;text-align:center';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = kind === 'warn' ? '#c0392b' : '#1e8e3e';
    toastEl.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, ms || 1500);
  }

  function usable(el) {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  function find(name) {
    var all = document.querySelectorAll('[data-remote="' + name + '"]');
    for (var i = 0; i < all.length; i++) if (usable(all[i])) return all[i];
    return null;
  }

  // Un confirm() modal bloquearía el mando: se contesta «sí» solo durante este clic.
  function clickSkippingConfirm(btn) {
    var orig = window.confirm;
    window.confirm = function () { return true; };
    try { btn.click(); } finally { window.confirm = orig; }
  }

  function pwRemote(action) {
    var now = Date.now();
    if (lastAt[action] && now - lastAt[action] < REPEAT_GUARD_MS) return true;

    var btn;
    if (action === 'go') {
      btn = find('go');
      if (!btn) return false;
      lastAt[action] = now;
      btn.click();
      toast(I18N.t('client.remote.go_enviado'));
      return true;
    }
    if (action === 'pause') {
      btn = find('pause');
      if (btn) {
        lastAt[action] = now;
        btn.click();
        toast(I18N.t('client.remote.pausa_enviada'));
        return true;
      }
      btn = find('resume');
      if (!btn) return false;
      lastAt[action] = now;
      btn.click();
      toast(I18N.t('client.remote.reanudar_enviado'));
      return true;
    }
    if (action === 'stop') {
      btn = find('stop');
      if (!btn) return false;
      lastAt[action] = now;
      if (now < stopArmedUntil) {
        stopArmedUntil = 0;
        toast(I18N.t('client.remote.stop_enviado'), 'warn');
        clickSkippingConfirm(btn);
      } else {
        stopArmedUntil = now + STOP_WINDOW_MS;
        toast(I18N.t('client.remote.pulsa_stop_otra_vez'), 'warn', STOP_WINDOW_MS);
      }
      return true;
    }
    return false;
  }
  window.pwRemote = pwRemote;

  // Navegador (o ventana sin atajo global): el mismo acelerador, como keydown.
  var cfg = window.PW_REMOTE_KEYS, RK = window.PWRemoteKeys;
  if (cfg && RK) {
    var platform = /Mac/i.test(navigator.platform || '') ? 'darwin' : 'other';
    window.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var action = RK.actionFor(cfg, e, platform);
      if (!action) return;
      var t = e.target, p = RK.parse(cfg[action]);
      var editing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (editing && p && p.mods.length === 0) return;
      e.preventDefault();
      pwRemote(action);
    }, true);
  }
})();
