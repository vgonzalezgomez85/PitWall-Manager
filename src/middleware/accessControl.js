function isLocalRequest(req) {
  const candidates = [
    req.ip,
    req.connection?.remoteAddress,
    req.socket?.remoteAddress,
  ].filter(Boolean);

  return candidates.some(ip =>
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip === '::ffff:127.0.0.1' ||
    /^127\./.test(ip) ||
    /^::ffff:127\./.test(ip)
  );
}

function annotateAccess(req, res, next) {
  res.locals.isAdminAccess = isLocalRequest(req);
  res.locals.isGuestAccess = !res.locals.isAdminAccess;
  next();
}

function requireLocalAccess(req, res, next) {
  if (isLocalRequest(req)) return next();

  return res.status(403).render('error', {
    t: req.t,
    code: 403,
    message: req.session?.lang === 'en'
      ? 'This management page is only available from the race computer.'
      : 'Esta página de gestión solo está disponible desde el ordenador de carrera.',
  });
}

module.exports = {
  annotateAccess,
  isLocalRequest,
  requireLocalAccess,
};
