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

const Settings       = require('../models/Settings');
const AccessPassword = require('../services/AccessPassword');

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
  return p === '/' || p === '/race-stats' || p === '/changelog'
      || /^\/races\/\d+\/live-stats(\.json)?$/.test(p)
      // Clasificación Le Mans (seguimiento en vivo de la carrera): solo lectura.
      || /^\/races\/\d+\/lemans$/.test(p)
      // Pantalla en directo de la pole (cronometraje): solo lectura para
      // invitado — la vista oculta sus propios botones de control (arrancar,
      // parar, siguiente piloto) con `isGuestAccess`; los POST de control
      // siguen bloqueados por IP igualmente (mismo patrón que /control/shifts).
      || /^\/races\/\d+\/pole\/timing$/.test(p)
      || p === '/results' || /^\/results\/\d+$/.test(p)
      // Cliente web "Lap" (timing del equipo desde el móvil). El acceso a los
      // datos de timing lo gatea el PIN por equipo; estas rutas deben ser
      // alcanzables desde cualquier IP de la red del evento. La hoja de PINs
      // (/lap/:id/pins) NO es pública: es de la organización y se queda tras la
      // restricción por IP (solo localhost/allowlist).
      || p === '/lap'
      || /^\/lap\/\d+(\/team\/\d+|\/login)?$/.test(p)
      || /^\/api\/lap\/\d+\/team\/\d+(\/tracking)?$/.test(p)
      // Certificado de la CA: los dispositivos que escanean el QR por la LAN
      // necesitan bajarlo para instalarlo y que la cámara vaya sin aviso. Es un
      // certificado público (sin clave privada), seguro de exponer.
      || p === '/cert' || p === '/cert/ca'
      // Control de pilotos en directo (kiosco de turnos): solo LECTURA para
      // invitado, la vista oculta sus propios botones de acción (escaneo,
      // corrección) con `isGuestAccess` — los POST de checkin/correct-time
      // siguen bloqueados por IP igualmente.
      || p === '/control/shifts';
}

// ── Conexión ecosistema (PitWall Control) ───────────────────────────────────
// Interruptor único que decide si Control puede alcanzar a Manager desde la
// LAN: envío de tandas y verificaciones (POST /import/tanda, POST
// /import/verificaciones, ambos con PIN) y lectura de resultados (GET
// /link/races/:id/results.json). '1' por defecto (comportamiento previo a
// este ajuste). El operador local (localhost/allowlist) nunca se ve afectado
// por este interruptor, solo los dispositivos de Control en la LAN.
function ecosystemBridgeEnabled() {
  return Settings.get('ecosystem_control_enabled', '1') === '1';
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
      || /^\/link\/races\/\d+\/results\.json$/.test(p)  // resultados por tanda → PitWall Control
      || p === '/link/laps';   // el comparador del otro sistema pide las vueltas (read-only)
}
function isLinkControlPath(p) {
  return p === '/link/state' || p === '/link/event';
}

// Importación de tandas/verificaciones desde PitWall Control (LAN). El POST
// debe ser alcanzable aunque la IP de Control no esté en la allowlist; la
// ACEPTACIÓN la gatea el PIN dentro de ImportController/VerificationController
// (importAuthorized). Las páginas (GET) NO se eximen: las abre el operador
// local y se quedan tras la restricción por IP normal.
function isImportPath(p, method) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  return p === '/import/tanda' || p === '/import/verificaciones';
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

// ── Contraseña de organización (Ajustes → Seguridad) ────────────────────────
// Protege los apartados Sistema y Catálogo del inicio, también en localhost y
// en la app de escritorio. El inicio y todo lo de Competición (carreras,
// entrenos, resultados, directo…) siguen sin contraseña.
function isLoggedIn(req) {
  return !AccessPassword.isEnabled() || !!(req.session && req.session.pwAuthed);
}

function isLoginPath(p) {
  return p === '/login' || p === '/logout';
}

// Sistema: ajustes, base de datos, sincronizaciones, ecosistema, diagnóstico y
// túnel. Catálogo: pilotos, equipos, coches, categorías y escenarios (+ el alta
// de categoría desde la ficha del circuito). /api/teams-catalog/quick NO: lo usa
// el alta de tanda, que es de Competición.
const PROTECTED_RE = /^\/(settings|api\/settings|database|catalog-sync|link|ecosystem|diagnostico|tunnel|api\/serial\/close|drivers|teams|cars|categories|api\/categories|circuits)(\/|$)/;
function isPasswordProtectedPath(p) {
  return PROTECTED_RE.test(p);
}

function askForLogin(req, res) {
  const wantsHtml = req.method === 'GET' && !req.xhr && /html/.test(req.headers.accept || '');
  if (wantsHtml) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  return res.status(401).json({ error: 'auth_required' });
}

// ── Express middleware ──────────────────────────────────────────────────────
function restrictAccess(req, res, next) {
  if (isLoginPath(req.path)) return next();
  const ipOk = !isRestrictEnabled() || ipAllowed(reqIp(req));
  if (req.path.startsWith('/api/mobile/')) return next();   // app móvil (REST)
  if (isPublicPath(req.path)) return next();                // vistas públicas
  // Enlace maestro↔esclavo: exención de IP (el otro extremo está en otra IP).
  // Las de solo-lectura pasan libres; las de control las gatea el token DENTRO
  // del controlador (aquí solo levantamos el bloqueo por IP).
  if (isLinkReadPath(req.path) || isLinkControlPath(req.path)) return next();
  // Import de tandas por LAN: exención de IP para el POST; el PIN lo valida
  // ImportController. La página (GET) sigue tras la restricción por IP.
  if (isImportPath(req.path, req.method)) return next();
  if (!ipOk) {
    return res.status(403).render('error', {
      t: req.t, code: 403,
      // Sin el middleware de idioma por delante (tests, rutas tempranas) no hay req.t.
      message: (req.t || require('./i18n').translator(req.session?.lang))('errors.acceso_restringido'),
    });
  }
  if (isPasswordProtectedPath(req.path) && !isLoggedIn(req)) return askForLogin(req, res);
  next();
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
  if (q.view === 'pole') return true;        // espectador de la pole en directo (público)
  // app móvil: se identifica (client=mobile) o NO es un navegador (sin "Mozilla")
  return q.client === 'mobile' || !/mozilla/i.test(ua);
}

// Admin = acceso completo (localhost o allowlist; o restricción desactivada).
// Guest = IP externa no permitida → ve la home reducida (solo botón).
// `pwLocked`: hay contraseña y esta sesión no ha entrado (Sistema y Catálogo
// la piden; el inicio lo marca con un candado).
function annotateAccess(req, res, next) {
  const admin = !isRestrictEnabled() || ipAllowed(reqIp(req));
  res.locals.isAdminAccess = admin;
  res.locals.isGuestAccess = !admin;
  res.locals.passwordEnabled = AccessPassword.isEnabled();
  res.locals.pwLocked = res.locals.passwordEnabled && !isLoggedIn(req);
  next();
}

module.exports = {
  normIp, isLocal, ipToInt, ipMatches, isRestrictEnabled, getAllowlist,
  ipAllowed, restrictAccess, isSocketAllowed,
  annotateAccess, isLoggedIn, reqIp, isPasswordProtectedPath,
  isLinkReadPath, isLinkControlPath, linkControlAuthorized,
  isImportPath, ecosystemBridgeEnabled,
};
