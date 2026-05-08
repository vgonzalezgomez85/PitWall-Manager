const fs           = require('fs');
const path         = require('path');
const LicenseService = require('../services/LicenseService');

const dataDir = process.env.SLOTIME_DATA || path.join(__dirname, '..', '..', 'database');

class LicenseController {

  // GET /license
  static index(req, res) {
    const info = LicenseService.info;
    res.render('license/index', { t: req.t, info, lang: req.session?.lang || 'es' });
  }

  // GET /eula
  static eula(req, res) {
    const lang = req.session?.lang || 'es';
    res.render('license/eula', { t: req.t, lang });
  }

  // POST /license/upload
  static upload(req, res) {
    const lang = req.session?.lang || 'es';

    if (!req.body.eula_accepted) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Debes aceptar el contrato de licencia (EULA) para continuar.' : 'You must accept the End User License Agreement (EULA) to continue.' };
      return res.redirect('/license');
    }

    if (!req.body.license_json) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'No se recibió ningún fichero.' : 'No file received.' };
      return res.redirect('/license');
    }

    const filePath = path.join(dataDir, 'slotime.license');

    try {
      // Validate JSON before saving
      JSON.parse(req.body.license_json);
    } catch (e) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'El fichero no es JSON válido.' : 'File is not valid JSON.' };
      return res.redirect('/license');
    }

    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(filePath, req.body.license_json.trim(), 'utf8');
      LicenseService.load(dataDir);

      if (LicenseService.info.error) {
        req.session.flash = { type: 'error', text: LicenseService.info.error };
      } else {
        const tier = LicenseService.tier.toUpperCase();
        req.session.flash = { type: 'success', text: lang === 'es' ? `Licencia ${tier} activada correctamente.` : `${tier} license activated successfully.` };
      }
    } catch (e) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Error al guardar el fichero.' : 'Error saving the file.' };
    }

    res.redirect('/license');
  }
}

module.exports = LicenseController;
