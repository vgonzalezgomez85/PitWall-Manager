const DriverProfile = require('../models/DriverProfile');
const QRCode        = require('qrcode');
const { parseCsvRaw, parseCsvLine, normalize } = require('../utils/csv');

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

  // ── Parser CSV de pilotos ───────────────────────────────────────────
  // Devuelve { rows, csv_content } donde rows[i] = { idx, name, category,
  // status: 'new'|'duplicate'|'error', existing?, reason? }.
  static _parseDriversCsv(rawCsv) {
    const csv = rawCsv || '';
    let parsed = parseCsvRaw(csv);

    // Si la primera línea NO es cabecera (no empieza por nombre/name), la
    // tratamos como dato. Pero parseCsvRaw ya quita la cabecera, así que
    // reincorporamos si era data.
    let dataLines = parsed.dataLines;
    const headerLooksReal = parsed.header[0] === 'nombre' || parsed.header[0] === 'name';
    if (!headerLooksReal) {
      // No había cabecera: la línea que parseamos como header en realidad
      // era data. Volvemos a leer todo crudo.
      const full = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
      dataLines = full;
    }

    const index = DriverProfile.buildNameIndex();
    const seenInCsv = new Map(); // norm → idx en CSV donde apareció

    const rows = dataLines.map((line, i) => {
      const cols = parseCsvLine(line, parsed.sep).map(c => c.trim());
      const name = cols[0];
      const catRaw = (cols[1] || '').toLowerCase();
      const category = VALID_CATEGORIES.includes(catRaw) ? catRaw : 'bronce';

      if (!name || name.length < 2) {
        return { idx: i, raw: line, name: name || '', category, status: 'error', reason: 'name_too_short' };
      }

      const key = normalize(name);
      const existing = index.get(key);
      const seenAt = seenInCsv.get(key);
      seenInCsv.set(key, i);

      if (existing) {
        return { idx: i, name, category, status: 'duplicate', existing };
      }
      if (seenAt !== undefined) {
        return { idx: i, name, category, status: 'duplicate_in_csv', existingIdx: seenAt };
      }
      return { idx: i, name, category, status: 'new' };
    });

    return { rows, csv_content: csv };
  }

  // POST /drivers/import/preview — devuelve la vista de previsualización
  // sin tocar la BD. Recibe el csv_content del file picker.
  static importPreview(req, res) {
    const lang = req.session?.lang || 'es';
    const { rows, csv_content } = DriverProfileController._parseDriversCsv(req.body.csv_content || '');
    if (rows.length === 0) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Fichero vacío o sin filas válidas' : 'Empty file or no valid rows' };
      return res.redirect('/drivers');
    }
    const stats = {
      total:     rows.length,
      new:       rows.filter(r => r.status === 'new').length,
      duplicate: rows.filter(r => r.status === 'duplicate' || r.status === 'duplicate_in_csv').length,
      error:     rows.filter(r => r.status === 'error').length,
    };
    res.render('drivers/import-preview', { t: req.t, rows, csv_content, stats });
  }

  // POST /drivers/import — aplica las decisiones del preview.
  // Body: csv_content + decisions[i] = 'update' | 'skip' | 'duplicate'
  // (solo se respeta para filas con status 'duplicate'; las 'new' se crean,
  // las 'error' se omiten, las 'duplicate_in_csv' siguen la decisión por
  // defecto = update sobre la fila previa del propio CSV).
  static importConfirm(req, res) {
    const lang = req.session?.lang || 'es';
    const { rows } = DriverProfileController._parseDriversCsv(req.body.csv_content || '');
    const decisions = req.body.decisions || {};

    let created = 0, updated = 0, skipped = 0;
    // Para 'duplicate_in_csv' necesitamos resolver al perfil creado en esta
    // misma pasada. Mantenemos un mapa norm → id según vamos creando.
    const createdInRun = new Map();

    rows.forEach(r => {
      if (r.status === 'error') { skipped++; return; }

      if (r.status === 'new') {
        try {
          const id = DriverProfile.create({ name: r.name, category: r.category });
          createdInRun.set(normalize(r.name), id);
          created++;
        } catch { skipped++; }
        return;
      }

      const dec = (decisions[String(r.idx)] || 'update').toLowerCase();

      if (r.status === 'duplicate') {
        const ex = r.existing;
        if (dec === 'skip') { skipped++; return; }
        if (dec === 'duplicate') {
          try { DriverProfile.create({ name: r.name, category: r.category }); created++; }
          catch { skipped++; }
          return;
        }
        // 'update' (default)
        try {
          DriverProfile.update(ex.id, { name: r.name, category: r.category });
          updated++;
        } catch { skipped++; }
        return;
      }

      if (r.status === 'duplicate_in_csv') {
        // Apunta a una fila previa del CSV. Buscamos el perfil que se haya
        // creado/actualizado para esa fila. Si fue 'skip' allí, podríamos
        // tratar ésta como 'new'; para simplificar, aplicamos la decisión
        // por defecto 'update' contra el perfil con ese nombre normalizado.
        const key = normalize(r.name);
        const id = createdInRun.get(key);
        if (dec === 'skip') { skipped++; return; }
        if (dec === 'duplicate') {
          try { DriverProfile.create({ name: r.name, category: r.category }); created++; }
          catch { skipped++; }
          return;
        }
        if (id) {
          try { DriverProfile.update(id, { name: r.name, category: r.category }); updated++; }
          catch { skipped++; }
        } else {
          try { const nid = DriverProfile.create({ name: r.name, category: r.category }); createdInRun.set(key, nid); created++; }
          catch { skipped++; }
        }
      }
    });

    const parts = [];
    if (created > 0) parts.push(lang === 'es' ? `${created} pilotos creados`     : `${created} drivers created`);
    if (updated > 0) parts.push(lang === 'es' ? `${updated} pilotos actualizados`: `${updated} drivers updated`);
    if (skipped > 0) parts.push(lang === 'es' ? `${skipped} omitidos`             : `${skipped} skipped`);
    req.session.flash = {
      type: (created + updated) > 0 ? 'success' : 'error',
      text: parts.join(' · ') || (lang === 'es' ? 'Sin cambios' : 'No changes'),
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

module.exports = DriverProfileController;
