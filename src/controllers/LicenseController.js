class LicenseController {

  // GET /eula
  static eula(req, res) {
    const lang = req.session?.lang || 'es';
    res.render('license/eula', { t: req.t, lang });
  }
}

module.exports = LicenseController;
