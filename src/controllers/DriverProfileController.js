const DriverProfile = require('../models/DriverProfile');

const VALID_CATEGORIES = ['platino', 'oro', 'plata', 'bronce'];

class DriverProfileController {

  static index(req, res) {
    const profiles = DriverProfile.findAll();
    res.render('drivers/index', { t: req.t, profiles });
  }

  static newForm(req, res) {
    res.render('drivers/new', { t: req.t, errors: [], body: {} });
  }

  static create(req, res) {
    const { name, category } = req.body;
    const errors = [];
    const trimmedName = (name || '').trim();
    if (trimmedName.length < 2) errors.push('name_required');
    if (!VALID_CATEGORIES.includes(category)) errors.push('category_required');
    if (errors.length) return res.render('drivers/new', { t: req.t, errors, body: req.body });
    DriverProfile.create({ name: trimmedName, category });
    res.redirect('/drivers');
  }

  static editForm(req, res) {
    const profile = DriverProfile.findById(req.params.id);
    if (!profile) return res.status(404).render('error', { t: req.t, code: 404, message: 'Driver not found' });
    res.render('drivers/edit', { t: req.t, profile, errors: [], body: {} });
  }

  static update(req, res) {
    const profile = DriverProfile.findById(req.params.id);
    if (!profile) return res.status(404).render('error', { t: req.t, code: 404, message: 'Driver not found' });

    const { name, category } = req.body;
    const errors = [];
    const trimmedName = (name || '').trim();
    if (trimmedName.length < 2) errors.push('name_required');
    if (!VALID_CATEGORIES.includes(category)) errors.push('category_required');
    if (errors.length) return res.render('drivers/edit', { t: req.t, profile, errors, body: req.body });

    DriverProfile.update(req.params.id, { name: trimmedName, category });
    res.redirect('/drivers');
  }

  static delete(req, res) {
    DriverProfile.delete(req.params.id);
    res.redirect('/drivers');
  }

  static importCsv(req, res) {
    const raw = (req.body.csv_content || '').trim();
    if (!raw) return res.redirect('/drivers');

    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return res.redirect('/drivers');

    // Detect if first line is a header (contains 'nombre' or 'name')
    let dataLines = lines;
    const firstLower = lines[0].toLowerCase();
    if (firstLower.startsWith('nombre') || firstLower.startsWith('name')) {
      dataLines = lines.slice(1);
    }

    let imported = 0;
    dataLines.forEach(line => {
      const cols = line.split(',').map(c => c.trim());
      const name = cols[0];
      if (!name || name.length < 2) return;
      const cat = VALID_CATEGORIES.includes(cols[1]?.toLowerCase())
        ? cols[1].toLowerCase()
        : 'bronce';
      DriverProfile.create({ name, category: cat });
      imported++;
    });

    res.redirect('/drivers');
  }
}

module.exports = DriverProfileController;
