const LicenseService = require('../services/LicenseService');

// Redirect with an upgrade message
function blocked(req, res, module) {
  const messages = {
    races_unlimited:  { es: 'Las carreras completas requieren licencia Pro.', en: 'Full races require a Pro license.' },
    export:           { es: 'La exportación requiere licencia Pro.',          en: 'Export requires a Pro license.' },
    mobile:           { es: 'La app móvil requiere licencia Pro.',            en: 'Mobile app requires a Pro license.' },
    pole:             { es: 'La pole position requiere licencia Pro.',        en: 'Pole position requires a Pro license.' },
    driver_profiles:  { es: 'Los perfiles de piloto requieren licencia Pro.', en: 'Driver profiles require a Pro license.' },
    teams_catalog:    { es: 'El catálogo de equipos requiere licencia Pro.',  en: 'Teams catalog requires a Pro license.' },
    team_races:       { es: 'Las carreras por equipos requieren licencia Pro.', en: 'Team races require a Pro license.' },
    best_laps:        { es: 'El panel de mejores vueltas requiere licencia Pro.', en: 'Best laps panel requires a Pro license.' },
    multi_circuit:    { es: 'Multi-circuito requiere licencia Pro.',                  en: 'Multi-circuit requires a Pro license.' },
    tv:               { es: 'La vista TV requiere licencia Pro.',                     en: 'TV view requires a Pro license.' },
    qr_checkin:       { es: 'El check-in por QR requiere licencia Pro.',             en: 'QR check-in requires a Pro license.' },
    lemans:           { es: 'La clasificación Le Mans requiere licencia Pro.',        en: 'Le Mans standings require a Pro license.' },
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
