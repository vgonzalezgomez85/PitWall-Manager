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
const TeamCatalog = require('../models/TeamCatalog');
const DriverProfile = require('../models/DriverProfile');
const db          = require('../config/database');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const { resolveCountry } = require('../config/countries');
const { parseCsvRaw, parseCsvLine, normalize } = require('../utils/csv');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../public/uploads/cars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `car_${Date.now()}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

class TeamCatalogController {

  static index(req, res) {
    const teams = TeamCatalog.findAll();
    res.render('teams/index', { t: req.t, teams });
  }

  static newForm(req, res) {
    const drivers = db.prepare('SELECT * FROM driver_profiles ORDER BY name ASC').all();
    res.render('teams/form', { t: req.t, team: null, errors: [], body: {}, drivers });
  }

  static create(req, res) {
    upload.single('car_photo')(req, res, (err) => {
      if (err) req.fileError = err.message;

      const errors = [];
      const name = (req.body.name || '').trim();
      if (name.length < 2) errors.push('name_required');

      const color     = (req.body.color    || '#8b949e').trim();
      const notes     = (req.body.notes    || '').trim() || null;
      const country   = (req.body.country  || '').trim() || null;
      const categoria = (req.body.categoria || '').trim() || null;
      const coche     = (req.body.coche    || '').trim() || null;
      const car_photo = req.file ? `/uploads/cars/${req.file.filename}` : null;
      const members   = TeamCatalogController._parseMembers(req.body);

      if (errors.length) {
        if (req.file) fs.unlinkSync(req.file.path);
        const drivers = db.prepare('SELECT * FROM driver_profiles ORDER BY name ASC').all();
        return res.render('teams/form', { t: req.t, team: null, errors, body: req.body, drivers });
      }

      const id = TeamCatalog.create({ name, color, notes, country, categoria, coche, car_photo });
      if (members.length) TeamCatalog.setMembers(id, members);
      res.redirect('/teams');
    });
  }

  static editForm(req, res) {
    const team = TeamCatalog.findById(req.params.id);
    if (!team) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    const drivers = db.prepare('SELECT * FROM driver_profiles ORDER BY name ASC').all();
    res.render('teams/form', { t: req.t, team, errors: [], body: team, drivers });
  }

  static update(req, res) {
    const team = TeamCatalog.findById(req.params.id);
    if (!team) return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });

    upload.single('car_photo')(req, res, (err) => {
      if (err) req.fileError = err.message;

      const errors = [];
      const name = (req.body.name || '').trim();
      if (name.length < 2) errors.push('name_required');

      const color     = (req.body.color    || '#8b949e').trim();
      const notes     = (req.body.notes    || '').trim() || null;
      const country   = (req.body.country  || '').trim() || null;
      const categoria = (req.body.categoria || '').trim() || null;
      const coche     = (req.body.coche    || '').trim() || null;

      let car_photo = undefined; // undefined = don't update the column
      if (req.file) {
        // Delete old photo if exists
        if (team.car_photo) {
          const oldPath = path.join(__dirname, '../../public', team.car_photo);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        car_photo = `/uploads/cars/${req.file.filename}`;
      }
      // Allow explicit removal via hidden checkbox
      if (req.body.remove_car_photo === '1') {
        if (team.car_photo) {
          const oldPath = path.join(__dirname, '../../public', team.car_photo);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        car_photo = null;
      }

      const members = TeamCatalogController._parseMembers(req.body);

      if (errors.length) {
        if (req.file) fs.unlinkSync(req.file.path);
        const drivers = db.prepare('SELECT * FROM driver_profiles ORDER BY name ASC').all();
        return res.render('teams/form', { t: req.t, team, errors, body: req.body, drivers });
      }

      TeamCatalog.update(req.params.id, { name, color, notes, country, categoria, coche, car_photo });
      TeamCatalog.setMembers(req.params.id, members);
      res.redirect('/teams');
    });
  }

  static delete(req, res) {
    const team = TeamCatalog.findById(req.params.id);
    if (team?.car_photo) {
      const p = path.join(__dirname, '../../public', team.car_photo);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    TeamCatalog.delete(req.params.id);
    res.redirect('/teams');
  }

  static quickCreate(req, res) {
    const name = (req.body.name || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'name_required' });
    const country   = (req.body.country  || '').trim() || null;
    const categoria = (req.body.categoria || '').trim() || null;
    const coche     = (req.body.coche    || '').trim() || null;
    const members   = [].concat(req.body.members || [])
      .map(m => typeof m === 'string'
        ? { name: m.trim(), driver_id: null }
        : { name: (m.name || '').trim(), driver_id: parseInt(m.driver_id, 10) || null })
      .filter(m => m.name);
    const id = TeamCatalog.create({ name, color: '#8b949e', notes: null, country, categoria, coche });
    if (members.length) TeamCatalog.setMembers(id, members);
    const team = TeamCatalog.findById(id);
    res.json({ ok: true, team });
  }

  // ── Parser CSV de equipos ───────────────────────────────────────────
  //   - Separador: detecta automáticamente ',' o ';' (Excel ES usa ';').
  //   - Comillas: campos pueden ir entre " " si llevan comas dentro.
  //   - BOM UTF-8 al inicio: se elimina.
  //   - pais: solo nombre. La bandera se autorrresuelve.
  //   - pilotos: lista separada por "|" — al confirmar, los que no existan
  //     se crean como bronce.
  // Duplicados detectados por nombre normalizado (case+accent insensitive).
  static _parseTeamsCsv(rawCsv) {
    const csv = rawCsv || '';
    const parsed = parseCsvRaw(csv);
    const sep = parsed.sep;

    const headerCols = parsed.header;
    const idxOf = (...names) => {
      for (const n of names) {
        const i = headerCols.indexOf(n);
        if (i !== -1) return i;
      }
      return -1;
    };
    const iName    = idxOf('nombre', 'name');
    const iCat     = idxOf('categoria', 'category');
    const iCoche   = idxOf('coche', 'car');
    const iCountry = idxOf('pais', 'país', 'country');
    const iNotes   = idxOf('notas', 'notes');
    const iPilots  = idxOf('pilotos', 'drivers', 'pilots');

    if (iName === -1) {
      return { rows: [], csv_content: csv, headerError: 'name_column_missing' };
    }

    const index = TeamCatalog.buildNameIndex();
    const seenInCsv = new Map();

    const rows = parsed.dataLines.map((line, i) => {
      const cols = parseCsvLine(line, sep);
      const name = (cols[iName] || '').trim();
      const categoria  = iCat     !== -1 ? (cols[iCat]?.trim()     || '') : '';
      const coche      = iCoche   !== -1 ? (cols[iCoche]?.trim()   || '') : '';
      const rawCountry = iCountry !== -1 ? (cols[iCountry]?.trim() || '') : '';
      const country    = resolveCountry(rawCountry) || null;
      const notes      = iNotes   !== -1 ? (cols[iNotes]?.trim()   || '') : '';
      const pilotsRaw  = iPilots  !== -1 ? (cols[iPilots]?.trim()  || '') : '';
      const pilots     = pilotsRaw ? pilotsRaw.split(/[|;]/).map(s => s.trim()).filter(Boolean) : [];

      const base = { idx: i, name, categoria, coche, country, rawCountry, notes, pilots };

      if (!name || name.length < 2) {
        return { ...base, status: 'error', reason: 'name_too_short' };
      }

      const key = normalize(name);
      const existing = index.get(key);
      const seenAt = seenInCsv.get(key);
      seenInCsv.set(key, i);

      if (existing) return { ...base, status: 'duplicate', existing };
      if (seenAt !== undefined) return { ...base, status: 'duplicate_in_csv', existingIdx: seenAt };
      return { ...base, status: 'new' };
    });

    return { rows, csv_content: csv };
  }

  static importPreview(req, res) {
    const lang = req.session?.lang || 'es';
    const result = TeamCatalogController._parseTeamsCsv(req.body.csv_content || '');
    if (result.headerError === 'name_column_missing') {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Falta la columna "nombre" en la cabecera' : 'Missing "name" column in header' };
      return res.redirect('/teams');
    }
    const { rows, csv_content } = result;
    if (rows.length === 0) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Fichero vacío o sin filas válidas' : 'Empty file or no valid rows' };
      return res.redirect('/teams');
    }
    const stats = {
      total:     rows.length,
      new:       rows.filter(r => r.status === 'new').length,
      duplicate: rows.filter(r => r.status === 'duplicate' || r.status === 'duplicate_in_csv').length,
      error:     rows.filter(r => r.status === 'error').length,
    };
    res.render('teams/import-preview', { t: req.t, rows, csv_content, stats });
  }

  static importConfirm(req, res) {
    const lang = req.session?.lang || 'es';
    const { rows } = TeamCatalogController._parseTeamsCsv(req.body.csv_content || '');
    const decisions = req.body.decisions || {};

    const allDrivers = db.prepare('SELECT id, name FROM driver_profiles').all();
    const driverByName = new Map(allDrivers.map(d => [normalize(d.name), d]));

    let created = 0, updated = 0, skipped = 0;
    let pilotsLinked = 0, pilotsCreated = 0;
    const teamCreatedInRun = new Map(); // normName → teamId

    const resolveMembers = (pilotsArr) => {
      return pilotsArr.map(mn => {
        const key = normalize(mn);
        let d = driverByName.get(key);
        if (d) { pilotsLinked++; }
        else {
          try {
            const newId = DriverProfile.create({ name: mn, category: 'bronce' });
            d = { id: newId, name: mn };
            driverByName.set(key, d);
            pilotsCreated++;
          } catch { d = { id: null, name: mn }; }
        }
        return { name: mn, driver_id: d.id || null };
      });
    };

    rows.forEach(r => {
      if (r.status === 'error') { skipped++; return; }

      const payload = {
        name:      r.name,
        notes:     r.notes || null,
        country:   r.country || null,
        categoria: r.categoria || null,
        coche:     r.coche || null,
      };

      if (r.status === 'new') {
        try {
          const id = TeamCatalog.create(payload);
          if (r.pilots.length) TeamCatalog.setMembers(id, resolveMembers(r.pilots));
          teamCreatedInRun.set(normalize(r.name), id);
          created++;
        } catch { skipped++; }
        return;
      }

      const dec = (decisions[String(r.idx)] || 'update').toLowerCase();

      if (r.status === 'duplicate') {
        const ex = r.existing;
        if (dec === 'skip') { skipped++; return; }
        if (dec === 'duplicate') {
          try {
            const id = TeamCatalog.create(payload);
            if (r.pilots.length) TeamCatalog.setMembers(id, resolveMembers(r.pilots));
            created++;
          } catch { skipped++; }
          return;
        }
        // update: actualiza el equipo existente. Para color y car_photo el
        // modelo respeta su default; conservamos los campos no enviados.
        try {
          TeamCatalog.update(ex.id, {
            name: r.name,
            color: '#8b949e',
            notes: payload.notes,
            country: payload.country,
            categoria: payload.categoria,
            coche: payload.coche,
            // car_photo: undefined → modelo conserva el actual
          });
          // Re-set members del CSV. Si el CSV no trae pilotos, los miembros
          // existentes se borran (consistente con el form, que también
          // re-graba members).
          TeamCatalog.setMembers(ex.id, r.pilots.length ? resolveMembers(r.pilots) : []);
          updated++;
        } catch { skipped++; }
        return;
      }

      if (r.status === 'duplicate_in_csv') {
        if (dec === 'skip') { skipped++; return; }
        if (dec === 'duplicate') {
          try {
            const id = TeamCatalog.create(payload);
            if (r.pilots.length) TeamCatalog.setMembers(id, resolveMembers(r.pilots));
            created++;
          } catch { skipped++; }
          return;
        }
        // update: si la fila previa del CSV ya creó el equipo, lo actualizamos.
        const prevId = teamCreatedInRun.get(normalize(r.name));
        if (prevId) {
          try {
            TeamCatalog.update(prevId, {
              name: r.name,
              color: '#8b949e',
              notes: payload.notes,
              country: payload.country,
              categoria: payload.categoria,
              coche: payload.coche,
            });
            TeamCatalog.setMembers(prevId, r.pilots.length ? resolveMembers(r.pilots) : []);
            updated++;
          } catch { skipped++; }
        } else {
          // Sin previo (fue 'skip' o error): creamos uno nuevo igualmente.
          try {
            const id = TeamCatalog.create(payload);
            if (r.pilots.length) TeamCatalog.setMembers(id, resolveMembers(r.pilots));
            teamCreatedInRun.set(normalize(r.name), id);
            created++;
          } catch { skipped++; }
        }
      }
    });

    const parts = [];
    if (created > 0) parts.push(lang === 'es' ? `${created} equipos creados`        : `${created} teams created`);
    if (updated > 0) parts.push(lang === 'es' ? `${updated} equipos actualizados`   : `${updated} teams updated`);
    if (pilotsLinked  > 0) parts.push(lang === 'es' ? `${pilotsLinked} pilotos enlazados` : `${pilotsLinked} drivers linked`);
    if (pilotsCreated > 0) parts.push(lang === 'es' ? `${pilotsCreated} pilotos creados`  : `${pilotsCreated} drivers created`);
    if (skipped       > 0) parts.push(lang === 'es' ? `${skipped} omitidos`               : `${skipped} skipped`);
    req.session.flash = {
      type: (created + updated) > 0 ? 'success' : 'error',
      text: parts.join(' · ') || (lang === 'es' ? 'Sin cambios' : 'No changes'),
    };
    res.redirect('/teams');
  }

  static _parseMembers(body) {
    const names     = [].concat(body.member_name      || []);
    const driverIds = [].concat(body.member_driver_id || []);
    const members   = [];
    for (let i = 0; i < names.length; i++) {
      const n = (names[i] || '').trim();
      if (n) members.push({ name: n, driver_id: parseInt(driverIds[i], 10) || null });
    }
    return members;
  }

  // GET /teams/qr-export — QR de todos los pilotos agrupados por equipo,
  // para imprimir. Solo los miembros enlazados a un perfil de piloto
  // (driver_id) tienen QR; los escritos a mano sin enlazar salen marcados.
  static async qrByTeam(req, res, next) {
    try {
      const QRCode = require('qrcode');
      const DriverProfileController = require('./DriverProfileController');
      const teams = TeamCatalog.findAll();

      const groups = await Promise.all(teams.map(async team => {
        const items = await Promise.all(team.members.map(async m => {
          const profile = m.driver_id ? DriverProfile.findById(m.driver_id) : null;
          if (!profile) return { name: m.name, category: null, qrDataUrl: null, qr_code: null };

          DriverProfileController._ensureQR(db, profile);
          let qrDataUrl = null;
          try {
            if (profile.qr_code) qrDataUrl = await QRCode.toDataURL(profile.qr_code, { width: 200, margin: 2 });
          } catch (e) {
            console.error('[qrByTeam] error generando QR para piloto', profile.id, e.message);
          }
          return { name: profile.name, category: profile.category, qrDataUrl, qr_code: profile.qr_code };
        }));
        return { team, items };
      }));

      res.render('teams/qr-by-team', { t: req.t, groups });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = TeamCatalogController;
