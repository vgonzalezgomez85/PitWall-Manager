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
const AccessPassword = require('../services/AccessPassword');
const { reqIp, isLocal } = require('../middleware/accessControl');

// Solo rutas internas: `next` viene de la URL y no puede sacar a otro sitio.
function safeNext(raw) {
  const n = String(raw || '/');
  return (n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\')) ? n : '/';
}

function render(req, res, { error = null, status = 200 } = {}) {
  res.status(status).render('login', { t: req.t, next: safeNext(req.query.next || req.body?.next), error });
}

const AuthController = {
  page(req, res) {
    if (!AccessPassword.isEnabled() || req.session.pwAuthed) return res.redirect(safeNext(req.query.next));
    render(req, res);
  },

  login(req, res) {
    const next = safeNext(req.body.next);
    if (!AccessPassword.isEnabled()) return res.redirect(next);
    const ip = reqIp(req);
    const { ok, lockedMs } = AccessPassword.attempt(ip, req.body.password || '', { lockable: !isLocal(ip) });
    const es = req.session.lang !== 'en';
    if (!ok) {
      const error = lockedMs
        ? (req.t('auth.too_many_attempts_wait_v_s', { v: Math.ceil(lockedMs / 1000) }))
        : (req.t('auth.wrong_password'));
      return render(req, res, { error, status: 401 });
    }
    // Sesión nueva al entrar (no se reutiliza un id que existía sin autenticar).
    const lang = req.session.lang;
    req.session.regenerate(err => {
      if (err) return render(req, res, { error: err.message, status: 500 });
      if (lang) req.session.lang = lang;
      req.session.pwAuthed = true;
      res.redirect(next);
    });
  },

  logout(req, res) {
    const lang = req.session.lang;
    req.session.regenerate(() => {
      if (lang) req.session.lang = lang;
      res.redirect('/login');
    });
  },
};

module.exports = AuthController;
