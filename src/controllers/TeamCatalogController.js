const TeamCatalog = require('../models/TeamCatalog');
const db          = require('../config/database');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');

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

module.exports = TeamCatalogController;
