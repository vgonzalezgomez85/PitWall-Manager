const DriverProfile = require('../models/DriverProfile');
const QRCode        = require('qrcode');

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
    const lang = req.session?.lang || 'es';
    let raw = req.body.csv_content || '';
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.trim();
    if (!raw) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Fichero vacío' : 'Empty file' };
      return res.redirect('/drivers');
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Sin filas válidas' : 'No valid rows' };
      return res.redirect('/drivers');
    }

    const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';

    let dataLines = lines;
    const firstLower = lines[0].toLowerCase();
    if (firstLower.startsWith('nombre') || firstLower.startsWith('name')) {
      dataLines = lines.slice(1);
    }

    let imported = 0, skipped = 0;
    dataLines.forEach(line => {
      const cols = parseCsvLine(line, sep).map(c => c.trim());
      const name = cols[0];
      if (!name || name.length < 2) { skipped++; return; }
      const cat = VALID_CATEGORIES.includes(cols[1]?.toLowerCase())
        ? cols[1].toLowerCase()
        : 'bronce';
      try {
        DriverProfile.create({ name, category: cat });
        imported++;
      } catch { skipped++; }
    });

    const parts = [];
    parts.push(lang === 'es' ? `${imported} pilotos importados` : `${imported} drivers imported`);
    if (skipped > 0) parts.push(lang === 'es' ? `${skipped} omitidos` : `${skipped} skipped`);
    req.session.flash = {
      type: imported > 0 ? 'success' : 'error',
      text: parts.join(' · '),
    };
    res.redirect('/drivers');
  }
  // Garantiza que el perfil tenga un qr_code válido. Si el target DRV:{id} ya
  // está ocupado por otra fila (regresión histórica) o el UPDATE falla por
  // cualquier motivo, devuelve el profile original sin matar al caller — la
  // vista mostrará un warning y se podrá regenerar a mano.
  static _ensureQR(db, profile) {
    if (profile.qr_code) return profile;
    const target = `DRV:${profile.id}`;
    try {
      // ¿Hay colisión con otro perfil?
      const existing = db.prepare('SELECT id FROM driver_profiles WHERE qr_code = ?').get(target);
      if (existing && existing.id !== profile.id) {
        // Colisión: generar uno alternativo con sufijo aleatorio corto.
        const alt = `DRV:${profile.id}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        db.prepare('UPDATE driver_profiles SET qr_code=? WHERE id=?').run(alt, profile.id);
        profile.qr_code = alt;
      } else {
        db.prepare('UPDATE driver_profiles SET qr_code=? WHERE id=?').run(target, profile.id);
        profile.qr_code = target;
      }
    } catch (err) {
      console.error('[DriverProfile._ensureQR] error asignando QR a piloto', profile.id, err.message);
    }
    return profile;
  }

  static async qrAll(req, res, next) {
    try {
      const db = require('../config/database');
      const profiles = DriverProfile.findAll().map(p => DriverProfileController._ensureQR(db, p));
      const items = await Promise.all(profiles.map(async p => {
        let qrDataUrl = null;
        try {
          if (p.qr_code) qrDataUrl = await QRCode.toDataURL(p.qr_code, { width: 200, margin: 2 });
        } catch (e) {
          console.error('[qrAll] error generando QR para piloto', p.id, e.message);
        }
        return { ...p, qrDataUrl };
      }));
      res.render('drivers/qr-all', { t: req.t, items });
    } catch (err) {
      next(err);
    }
  }

  static async qrPage(req, res, next) {
    try {
      const db = require('../config/database');
      let profile = DriverProfile.findById(req.params.id);
      if (!profile) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
      profile = DriverProfileController._ensureQR(db, profile);
      let qrDataUrl = null;
      if (profile.qr_code) {
        try {
          qrDataUrl = await QRCode.toDataURL(profile.qr_code, { width: 240, margin: 2 });
        } catch (e) {
          console.error('[qrPage] error generando QR para piloto', profile.id, e.message);
        }
      }
      res.render('drivers/qr', { t: req.t, profile, qrDataUrl });
    } catch (err) {
      next(err);
    }
  }
}

function parseCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

module.exports = DriverProfileController;
