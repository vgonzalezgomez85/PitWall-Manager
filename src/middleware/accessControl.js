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

// Rutas PÚBLICAS (accesibles desde cualquier IP): el index (que a externos
// muestra solo los accesos públicos), las estadísticas en vivo y los
// resultados de carreras finalizadas (landing + por carrera, sin corrección).
function isPublicPath(p) {
  return p === '/' || p === '/race-stats' || /^\/races\/\d+\/live-stats(\.json)?$/.test(p)
      // Clasificación Le Mans (seguimiento en vivo de la carrera): solo lectura.
      || /^\/races\/\d+\/lemans$/.test(p)
      || p === '/results' || /^\/results\/\d+$/.test(p)
      // Cliente web "Lap" (timing del equipo desde el móvil). El acceso a los
      // datos de timing lo gatea el PIN por equipo; estas rutas deben ser
      // alcanzables desde cualquier IP de la red del evento. La hoja de PINs
      // (/lap/:id/pins) NO es pública: es de la organización y se queda tras la
      // restricción por IP (solo localhost/allowlist).
      || p === '/lap'
      || /^\/lap\/\d+(\/team\/\d+|\/login)?$/.test(p)
      || /^\/api\/lap\/\d+\/team\/\d+$/.test(p);
}

// ── Race Link (maestro↔esclavo) ─────────────────────────────────────────────
// Endpoints que una instancia REMOTA de PitWall (el otro extremo del enlace)
// debe poder alcanzar aunque su IP no esté en la allowlist. Se dividen en:
//   - Solo lectura, SIN token (provisión de la carrera): la lista de carreras
//     y el export.json. Son inocuos (mismos datos que /results) y ya existían.
//   - Control CON token (/link/state, /link/event): un maestro remoto empuja el
//     estado deseado. La exención de IP es incondicional aquí, pero la ACEPTACIÓN
//     la gatea linkControlAuthorized() (role=slave + x-link-token correcto). Si
//     no autoriza, el controlador responde 401/403.
// NO se eximen /link (página), /link/master/races, /link/provision, /link/import:
// esos los usa el operador LOCAL del esclavo y siguen tras la restricción normal.
function isLinkReadPath(p) {
  return p === '/link/races' || /^\/link\/races\/\d+\/export\.json$/.test(p)
      || p === '/link/laps';   // el comparador del otro sistema pide las vueltas (read-only)
}
function isLinkControlPath(p) {
  return p === '/link/state' || p === '/link/event';
}

// ¿La petición de control del enlace está autorizada? Solo si esta instancia es
// ESCLAVO y la cabecera x-link-token coincide con el secreto compartido. El
// token vacío/no configurado nunca autoriza (evita aceptar por defecto).
function linkControlAuthorized(req) {
  if (Settings.get('link_role', 'off') !== 'slave') return false;
  const expected = String(Settings.get('link_token', '') || '');
  if (!expected) return false;
  const got = String(req.headers['x-link-token'] || '');
  return got === expected;
}

// ── Express middleware ──────────────────────────────────────────────────────
function restrictAccess(req, res, next) {
  if (!isRestrictEnabled()) return next();
  if (req.path.startsWith('/api/mobile/')) return next();   // app móvil (REST)
  if (isPublicPath(req.path)) return next();                // vistas públicas
  // Enlace maestro↔esclavo: exención de IP (el otro extremo está en otra IP).
  // Las de solo-lectura pasan libres; las de control las gatea el token DENTRO
  // del controlador (aquí solo levantamos el bloqueo por IP).
  if (isLinkReadPath(req.path) || isLinkControlPath(req.path)) return next();
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
  if (q.view === 'livestats') return true;   // espectador de estadísticas en vivo (público)
  if (q.view === 'lap') return true;         // cliente web "Lap" del equipo (público)
  // app móvil: se identifica (client=mobile) o NO es un navegador (sin "Mozilla")
  return q.client === 'mobile' || !/mozilla/i.test(ua);
}

// ── Legacy (se conservan; ya no se usan directamente) ───────────────────────
function isLocalRequest(req) { return isLocal(reqIp(req)); }
// Admin = acceso completo (localhost o allowlist; o restricción desactivada).
// Guest = IP externa no permitida → ve la home reducida (solo botón).
function annotateAccess(req, res, next) {
  const admin = !isRestrictEnabled() || ipAllowed(reqIp(req));
  res.locals.isAdminAccess = admin;
  res.locals.isGuestAccess = !admin;
  next();
}

module.exports = {
  normIp, isLocal, ipToInt, ipMatches, isRestrictEnabled, getAllowlist,
  ipAllowed, restrictAccess, isSocketAllowed,
  isLocalRequest, annotateAccess,
  isLinkReadPath, isLinkControlPath, linkControlAuthorized,
};
