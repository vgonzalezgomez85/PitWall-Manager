const TeamCatalog = require('../models/TeamCatalog');
const DriverProfile = require('../models/DriverProfile');
const db          = require('../config/database');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const { resolveCountry } = require('../config/countries');

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

  // CSV con cabecera (es o en). Campos soportados (orden libre por cabecera):
  //   nombre,categoria,coche,pais,notas,pilotos
  //   name,category,car,country,notes,drivers
  //
  // Detalles tolerantes a usuarios no técnicos:
  //   - Separador: detecta automáticamente coma o punto y coma (Excel ES usa ';').
  //   - Comillas: campos pueden ir entre " " si llevan comas dentro.
  //   - BOM UTF-8 al inicio: se elimina.
  //   - pais: solo nombre ("España", "Italia", "Brasil"…). La bandera se
  //     resuelve en server vía resolveCountry. Soporta nombres en ES y EN.
  //     Si ya viene en formato "Spain|🇪🇸" también se acepta.
  //   - pilotos: lista separada por "|" o ";". Para cada nombre:
  //       1. Si existe un driver_profile con ese nombre (case-insensitive)
  //          → se enlaza por driver_id.
  //       2. Si NO existe → se crea uno nuevo como categoría 'bronce' y se
  //          enlaza. Aparece de inmediato en /drivers para edición posterior.
  //     El flash final reporta cuántos pilotos se enlazaron y cuántos se
  //     crearon ex-novo, para que el usuario detecte typos.
  //
  // Nota: la columna 'color' del catálogo está en BD por legacy pero no se
  // expone en el form ni se renderiza en ningún sitio, así que el importer
  // no la lee — el modelo le pone el gris por defecto.
  static importCsv(req, res) {
    const lang = req.session?.lang || 'es';
    let raw = req.body.csv_content || '';
    // Strip BOM UTF-8 que Excel suele añadir al guardar como CSV
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.trim();
    if (!raw) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Fichero vacío' : 'Empty file' };
      return res.redirect('/teams');
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'El CSV debe tener cabecera y al menos una fila' : 'CSV needs a header and at least one row' };
      return res.redirect('/teams');
    }

    // Autodetectar separador: si la primera línea tiene más ';' que ',', usar ';'
    const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';

    // Cabecera — mapeo de columnas
    const headerCols = parseCsvLine(lines[0], sep).map(c => c.trim().toLowerCase());
    const idx = (...names) => {
      for (const n of names) {
        const i = headerCols.indexOf(n);
        if (i !== -1) return i;
      }
      return -1;
    };
    const iName    = idx('nombre', 'name');
    const iCat     = idx('categoria', 'category');
    const iCoche   = idx('coche', 'car');
    const iCountry = idx('pais', 'país', 'country');
    const iNotes   = idx('notas', 'notes');
    const iPilots  = idx('pilotos', 'drivers', 'pilots');

    if (iName === -1) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Falta la columna "nombre" en la cabecera' : 'Missing "name" column in header' };
      return res.redirect('/teams');
    }

    // Caché de pilotos existentes por nombre normalizado (lowercase + trim).
    // Mutamos esta caché si se crean pilotos nuevos durante la importación,
    // así un mismo nombre que aparezca en dos equipos del CSV se enlaza al
    // perfil recién creado en lugar de duplicarse.
    const allDrivers = db.prepare('SELECT id, name FROM driver_profiles').all();
    const driverByName = new Map(allDrivers.map(d => [d.name.toLowerCase().trim(), d]));

    let imported = 0, skipped = 0;
    let pilotsLinked = 0, pilotsCreated = 0;

    for (let li = 1; li < lines.length; li++) {
      const cols = parseCsvLine(lines[li], sep);
      const name = cols[iName]?.trim();
      if (!name || name.length < 2) { skipped++; continue; }

      const rawCountry = iCountry !== -1 ? cols[iCountry]?.trim() : '';
      const country    = resolveCountry(rawCountry);

      try {
        const id = TeamCatalog.create({
          name,
          notes:     iNotes !== -1 ? (cols[iNotes]?.trim() || null) : null,
          country,
          categoria: iCat   !== -1 ? (cols[iCat]?.trim()   || null) : null,
          coche:     iCoche !== -1 ? (cols[iCoche]?.trim() || null) : null,
        });

        if (iPilots !== -1 && cols[iPilots]) {
          const memberNames = cols[iPilots].split(/[|;]/).map(s => s.trim()).filter(Boolean);
          const members = memberNames.map(mn => {
            const key = mn.toLowerCase();
            let d = driverByName.get(key);
            if (d) {
              pilotsLinked++;
            } else {
              // No existe → crear nuevo perfil con categoría por defecto 'bronce'.
              // Aparece en /drivers para que el usuario pueda subirle la
              // categoría después.
              const newId = DriverProfile.create({ name: mn, category: 'bronce' });
              d = { id: newId, name: mn };
              driverByName.set(key, d);
              pilotsCreated++;
            }
            return { name: mn, driver_id: d.id };
          });
          if (members.length) TeamCatalog.setMembers(id, members);
        }
        imported++;
      } catch { skipped++; }
    }

    const parts = [];
    parts.push(lang === 'es' ? `${imported} equipos importados` : `${imported} teams imported`);
    if (pilotsLinked  > 0) parts.push(lang === 'es' ? `${pilotsLinked} pilotos enlazados`  : `${pilotsLinked} drivers linked`);
    if (pilotsCreated > 0) parts.push(lang === 'es' ? `${pilotsCreated} pilotos creados`   : `${pilotsCreated} drivers created`);
    if (skipped       > 0) parts.push(lang === 'es' ? `${skipped} omitidos`                : `${skipped} skipped`);
    req.session.flash = {
      type: imported > 0 ? 'success' : 'error',
      text: parts.join(' · '),
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
}

/**
 * Parsea una línea CSV soportando comillas. Devuelve array de strings.
 * Reglas mínimas (subset RFC 4180):
 *   - Separador parametrizable (',' o ';').
 *   - Campo entre " " preserva el separador y comas dentro: "foo, bar".
 *   - "" dentro de un campo entrecomillado → " literal.
 *   - Espacios en blanco alrededor del separador no se eliminan aquí
 *     (lo hace cada caller con .trim() si quiere).
 */
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

module.exports = TeamCatalogController;
