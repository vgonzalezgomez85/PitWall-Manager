const LicenseService = require('../services/LicenseService');

// Redirect with an upgrade message
function blocked(req, res, module) {
  const messages = {
    races_unlimited: { es: 'Las carreras completas requieren licencia Club o Pro.', en: 'Full races require a Club or Pro license.' },
    export:          { es: 'La exportación requiere licencia Club o Pro.',           en: 'Export requires a Club or Pro license.' },
    mobile:          { es: 'La app móvil requiere licencia Club o Pro.',             en: 'Mobile app requires a Club or Pro license.' },
    pole:            { es: 'La pole position requiere licencia Club o Pro.',         en: 'Pole position requires a Club or Pro license.' },
    multi_circuit:   { es: 'Multi-circuito requiere licencia Pro.',                  en: 'Multi-circuit requires a Pro license.' },
    tv:              { es: 'La vista TV requiere licencia Pro.',                     en: 'TV view requires a Pro license.' },
  };
  const lang = req.session?.lang || 'es';
  const msg  = messages[module]?.[lang] ?? 'Funcionalidad no disponible en tu licencia.';
  req.session.flash = { type: 'error', text: msg + ' <a href="/license">Ver licencia</a>' };
  res.redirect('back');
}

// Factory: create a middleware that requires a specific module
function requireModule(module) {
  return (req, res, next) => {
    if (LicenseService.has(module)) return next();
    blocked(req, res, module);
  };
}

module.exports = { requireModule };
