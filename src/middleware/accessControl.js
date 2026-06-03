// Control de acceso "blando" a la web (no es seguridad fuerte): bloquea el
// acceso desde cualquier IP salvo localhost y una allowlist (IPs sueltas o
// rangos CIDR). Exentos del bloqueo:
//   - La API móvil (/api/mobile/*) y la conexión socket.io de la app móvil
//     (identificada por query client=mobile o por NO ser un navegador), para
//     que la app siga recibiendo el vuelta a vuelta.
//   - Infolap (UDP :4441) no pasa por aquí, así que queda exento por naturaleza.
//
// Config en Settings: `access_restrict_enabled` ('1' por defecto = ON) y
// `access_allowlist` (JSON array de IPs/CIDR).

const Settings = require('../models/Settings');

// ::ffff:1.2.3.4 → 1.2.3.4
function normIp(ip) {
  if (!ip) return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

function isLocal(ip) {
  ip = normIp(ip);
  return ip === '::1' || ip === '127.0.0.1' || /^127\./.test(ip);
}

function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) { const x = parseInt(o, 10); if (!(x >= 0 && x <= 255)) return null; n = (n * 256) + x; }
  return n >>> 0;
}

// Coincidencia de una IP contra una regla: IP exacta o CIDR IPv4 (a.b.c.d/n).
function ipMatches(ip, rule) {
  ip = normIp(ip);
  rule = String(rule || '').trim();
  if (!rule) return false;
  if (rule.includes('/')) {
    const [base, bitsStr] = rule.split('/');
    const bits = parseInt(bitsStr, 10);
    const ipN = ipToInt(ip), baseN = ipToInt(base);
    if (ipN == null || baseN == null || !(bits >= 0 && bits <= 32)) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (ipN & mask) === (baseN & mask);
  }
  return ip === rule;
}

function isRestrictEnabled() {
  return Settings.get('access_restrict_enabled', '1') === '1';
}

function getAllowlist() {
  try { const a = JSON.parse(Settings.get('access_allowlist', '[]')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

// ¿IP permitida? localhost SIEMPRE; o si está en la allowlist (IP/CIDR).
function ipAllowed(ip) {
  if (isLocal(ip)) return true;
  return getAllowlist().some(rule => ipMatches(ip, rule));
}

function reqIp(req) {
  return normIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '');
}

// ── Express middleware ──────────────────────────────────────────────────────
function restrictAccess(req, res, next) {
  if (!isRestrictEnabled()) return next();
  if (req.path.startsWith('/api/mobile/')) return next();   // app móvil (REST)
  if (ipAllowed(reqIp(req))) return next();
  return res.status(403).render('error', {
    t: req.t, code: 403,
    message: (req.session?.lang === 'en')
      ? 'Access restricted: this device is not authorized.'
      : 'Acceso restringido: este dispositivo no está autorizado.',
  });
}

// ── socket.io gate ──────────────────────────────────────────────────────────
// Permite localhost/allowlist y la app móvil; bloquea navegadores desde IPs no
// autorizadas. (Infolap va por UDP, no llega aquí.)
function isSocketAllowed(socket) {
  if (!isRestrictEnabled()) return true;
  if (ipAllowed(normIp(socket.handshake.address))) return true;
  const q  = socket.handshake.query || {};
  const ua = socket.handshake.headers['user-agent'] || '';
  // app móvil: se identifica (client=mobile) o NO es un navegador (sin "Mozilla")
  return q.client === 'mobile' || !/mozilla/i.test(ua);
}

// ── Legacy (se conservan; ya no se usan directamente) ───────────────────────
function isLocalRequest(req) { return isLocal(reqIp(req)); }
function annotateAccess(req, res, next) {
  res.locals.isAdminAccess = isLocalRequest(req);
  res.locals.isGuestAccess = !res.locals.isAdminAccess;
  next();
}

module.exports = {
  normIp, isLocal, ipToInt, ipMatches, isRestrictEnabled, getAllowlist,
  ipAllowed, restrictAccess, isSocketAllowed,
  isLocalRequest, annotateAccess,
};
