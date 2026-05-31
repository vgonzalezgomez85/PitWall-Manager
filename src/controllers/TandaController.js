const Race           = require('../models/Race');
const Tanda          = require('../models/Tanda');
const Manga          = require('../models/Manga');
const Team           = require('../models/Team');
const Driver         = require('../models/Driver');
const DriverProfile  = require('../models/DriverProfile');
const TeamCatalog    = require('../models/TeamCatalog');
const LicenseService = require('../services/LicenseService');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

// Devuelve el array de tamaños de sub-circuitos. Si no hay circuito asignado
// o la config no es válida, devuelve [lanes_count] (un solo sub-circuito).
function _circuitSizesFor(race) {
  try {
    if (race.circuit_id) {
      const Circuit = require('../models/Circuit');
      const c = Circuit.findById(race.circuit_id);
      if (c) {
        const sizes = Circuit.getConfig(c);
        if (Array.isArray(sizes) && sizes.length > 0) return sizes;
      }
    }
    if (race.circuits_config) {
      const arr = JSON.parse(race.circuits_config);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch {}
  return [race.lanes_count || 6];
}

class TandaController {

  // GET /races/:id/tandas/new
  static newForm(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const laneSequence  = Race.getLaneSequence(race);
    const profiles      = DriverProfile.findAll();
    const teamsCatalog  = TeamCatalog.findAll();
    const circuitSizes  = _circuitSizesFor(race);
    res.render('races/tanda-new', { t: req.t, race, laneSequence, LANE_COLORS, profiles, teamsCatalog, circuitSizes, errors: [], body: {} });
  }

  // POST /races/:id/tandas
  static create(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    // Basic tier: max 1 tanda per race
    const maxTandas = LicenseService.maxTandasPerRace;
    if (maxTandas !== Infinity) {
      const existing = Tanda.findByRace(race.id);
      if (existing.length >= maxTandas) {
        const lang = req.session?.lang || 'es';
        req.session.flash = {
          type: 'error',
          text: (lang === 'es'
            ? 'La licencia Basic está limitada a 1 tanda por carrera.'
            : 'Basic license is limited to 1 tanda per race.')
            + ' <a href="/license">Ver licencia</a>',
        };
        return res.redirect(`/races/${race.id}`);
      }
    }

    const laneSequence = Race.getLaneSequence(race);
    const errors = [];

    // Parse participants from form
    // For team format: teams[0][name], teams[0][members][0], ...
    // For individual: drivers[0], drivers[1], ...
    let entities = []; // [{id, type, name}] — filled after DB inserts below

    const tandaId = Tanda.create(race.id);

    if (race.format === 'team') {
      const catalogIds = [].concat(req.body.team_catalog_ids || []).map(id => parseInt(id, 10)).filter(Boolean);

      if (catalogIds.length < laneSequence.filter(l => l !== 0).length) {
        errors.push('not_enough_teams');
      }

      if (errors.length) {
        Tanda.delete(tandaId);
        const teamsCatalog = TeamCatalog.findAll();
        return res.render('races/tanda-new', { t: req.t, race, laneSequence, LANE_COLORS, profiles: DriverProfile.findAll(), teamsCatalog, circuitSizes: _circuitSizesFor(race), errors, body: req.body });
      }

      catalogIds.forEach((catalogId, idx) => {
        const catalogTeam = TeamCatalog.findById(catalogId);
        const teamName = catalogTeam ? catalogTeam.name : `Equipo ${idx + 1}`;
        const teamId = Team.create({
          race_id: race.id, tanda_id: tandaId,
          name: teamName, lane: 0, color: LANE_COLORS[idx % LANE_COLORS.length]
        });
        if (catalogTeam) {
          catalogTeam.members.forEach(m => {
            if (m.name?.trim()) {
              Driver.create({ race_id: race.id, tanda_id: tandaId, team_id: teamId, name: m.name.trim() });
            }
          });
        }
        entities.push({ id: teamId, type: 'team', name: teamName });
      });

    } else {
      const rawDrivers = req.body.drivers || {};
      const driversArray = Array.isArray(rawDrivers) ? rawDrivers : Object.values(rawDrivers);

      if (driversArray.filter(d => d?.trim()).length < laneSequence.length) {
        errors.push('not_enough_drivers');
      }

      if (errors.length) {
        Tanda.delete(tandaId);
        return res.render('races/tanda-new', { t: req.t, race, laneSequence, LANE_COLORS, profiles: DriverProfile.findAll(), circuitSizes: _circuitSizesFor(race), errors, body: req.body });
      }

      driversArray.forEach((name, idx) => {
        if (!name?.trim()) return;
        const driverId = Driver.create({
          race_id: race.id, tanda_id: tandaId, team_id: null,
          name: name.trim(), lane: idx + 1, car_number: idx + 1
        });
        entities.push({ id: driverId, type: 'driver', name: name.trim() });
      });
    }

    // Generate and persist the manga schedule (Basic tier: max 1 manga)
    let schedule = Manga.buildSchedule(laneSequence, entities);
    const maxMangas = LicenseService.maxMangasPerRace;
    if (maxMangas !== Infinity && schedule.length > maxMangas) {
      schedule = schedule.slice(0, maxMangas);
    }
    Manga.persistSchedule(tandaId, race.id, schedule);

    // Mark race as active if it was pending
    if (race.status === 'pending') Race.updateStatus(race.id, 'active');

    res.redirect(`/races/${race.id}`);
  }

  // GET /races/:id/mangas/:mangaId/edit
  static editManga(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const manga = Manga.findById(req.params.mangaId);
    if (!manga || manga.status !== 'pending') return res.redirect(`/races/${race.id}`);

    const lanes = Manga.getLanes(manga.id);

    // Get all participants for this tanda (for the dropdowns)
    const db = require('../config/database');
    const participants = race.format === 'team'
      ? db.prepare('SELECT id, name, color FROM teams WHERE tanda_id = ? ORDER BY name').all(manga.tanda_id)
      : db.prepare('SELECT id, name FROM drivers WHERE tanda_id = ? AND team_id IS NULL ORDER BY name').all(manga.tanda_id);

    res.render('races/manga-edit', {
      t: req.t, race, manga, lanes, participants, LANE_COLORS
    });
  }

  // POST /races/:id/mangas/:mangaId/edit
  static updateManga(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const manga = Manga.findById(req.params.mangaId);
    if (!manga || manga.status !== 'pending') return res.redirect(`/races/${race.id}`);

    // assignments: { [mlId]: entityId }
    const raw = req.body.assignment || {};
    const assignments = Object.entries(raw).map(([mlId, entityId]) => ({
      mlId:     parseInt(mlId, 10),
      teamId:   race.format === 'team'       ? parseInt(entityId, 10) : null,
      driverId: race.format === 'individual' ? parseInt(entityId, 10) : null,
    }));

    // Cascade rebuild: only if NO manga of any tanda in this race has started.
    const db = require('../config/database');
    const allPending = db.prepare(
      `SELECT COUNT(*) AS n FROM mangas WHERE race_id = ? AND status != 'pending'`
    ).get(race.id).n === 0;

    if (allPending) {
      // Read this manga's slots in their original DB order (by id) so we
      // know the position of each slot in the rotation.
      const originalSlots = db.prepare(
        'SELECT id, lane, is_rest FROM manga_lanes WHERE manga_id = ? ORDER BY id ASC'
      ).all(manga.id);

      // For each slot, find the participant the user assigned to it.
      const assignMap = new Map(assignments.map(a => [a.mlId, a]));
      const entities = [];
      for (const slot of originalSlots) {
        const a = assignMap.get(slot.id);
        if (!a) continue; // shouldn't happen — form sends every slot
        if (race.format === 'team') {
          const t = Team.findById(a.teamId);
          if (t) entities.push({ id: t.id, type: 'team', name: t.name });
        } else {
          const d = Driver.findById(a.driverId);
          if (d) entities.push({ id: d.id, type: 'driver', name: d.name });
        }
      }

      const laneSequence = Race.getLaneSequence(race);
      const schedule = Manga.buildSchedule(laneSequence, entities);

      // Drop all mangas of this tanda (cascade kills manga_lanes) and re-persist.
      db.prepare('DELETE FROM mangas WHERE tanda_id = ?').run(manga.tanda_id);
      Manga.persistSchedule(manga.tanda_id, race.id, schedule);

      // Keep tanda status pending after rebuild.
      Tanda.updateStatus(manga.tanda_id, 'pending');
    } else {
      // Some manga has started elsewhere → don't cascade; just save this one.
      Manga.updateLaneAssignments(assignments);
    }

    res.redirect(`/races/${race.id}`);
  }

  // GET /races/:id/tandas/:tandaId/edit
  static editTanda(req, res) {
    const race  = Race.findById(req.params.id);
    const tanda = Tanda.findById(req.params.tandaId);
    if (!race || !tanda || tanda.race_id !== race.id) {
      return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    }

    const laneSequence   = Race.getLaneSequence(race);
    const profiles       = DriverProfile.findAll();
    const mangas         = Manga.findByTanda(tanda.id);
    const canRestructure = mangas.every(m => m.status === 'pending');

    const drivers = race.format === 'individual'
      ? Driver.findByTanda(tanda.id).filter(d => !d.team_id)
      : [];
    const teams = race.format === 'team'
      ? require('../models/Team').findByTandaWithMembers(tanda.id)
      : [];

    res.render('races/tanda-edit', {
      t: req.t, race, tanda, laneSequence, LANE_COLORS, profiles,
      drivers, teams, canRestructure, errors: []
    });
  }

  // POST /races/:id/tandas/:tandaId/edit
  static updateTanda(req, res) {
    const race  = Race.findById(req.params.id);
    const tanda = Tanda.findById(req.params.tandaId);
    if (!race || !tanda || tanda.race_id !== race.id) {
      return res.status(404).render('error', { t: req.t, code: 404, message: 'Not found' });
    }

    const laneSequence   = Race.getLaneSequence(race);
    const mangas         = Manga.findByTanda(tanda.id);
    const canRestructure = mangas.every(m => m.status === 'pending');
    const db             = require('../config/database');

    if (race.format === 'individual') {
      const rawDrivers   = req.body.drivers || {};
      const driversArray = Array.isArray(rawDrivers) ? rawDrivers : Object.values(rawDrivers);

      if (canRestructure) {
        const valid = driversArray.filter(d => (typeof d === 'string' ? d : d?.name)?.trim());
        if (valid.length < laneSequence.length) {
          const drivers = Driver.findByTanda(tanda.id).filter(d => !d.team_id);
          return res.render('races/tanda-edit', {
            t: req.t, race, tanda, laneSequence, LANE_COLORS, profiles: DriverProfile.findAll(),
            drivers, teams: [], canRestructure, errors: ['not_enough_drivers']
          });
        }
        db.prepare('DELETE FROM mangas WHERE tanda_id = ?').run(tanda.id);
        db.prepare('DELETE FROM drivers WHERE tanda_id = ?').run(tanda.id);
        const entities = [];
        valid.forEach((d, idx) => {
          const name = (typeof d === 'string' ? d : d.name).trim();
          const id   = Driver.create({ race_id: race.id, tanda_id: tanda.id, team_id: null, name, lane: idx + 1, car_number: idx + 1 });
          entities.push({ id, type: 'driver', name });
        });
        Manga.persistSchedule(tanda.id, race.id, Manga.buildSchedule(laneSequence, entities));
      } else {
        driversArray.forEach(d => {
          const id   = parseInt(d.id);
          const name = d.name?.trim();
          if (id && name) db.prepare('UPDATE drivers SET name = ? WHERE id = ?').run(name, id);
        });
      }

    } else {
      const rawTeams   = req.body.teams || {};
      const teamsArray = Array.isArray(rawTeams) ? rawTeams : Object.values(rawTeams);

      if (canRestructure) {
        const valid = teamsArray.filter(t => t?.name?.trim());
        if (valid.length < laneSequence.length) {
          const teams = require('../models/Team').findByTandaWithMembers(tanda.id);
          return res.render('races/tanda-edit', {
            t: req.t, race, tanda, laneSequence, LANE_COLORS, profiles: DriverProfile.findAll(),
            drivers: [], teams, canRestructure, errors: ['not_enough_teams']
          });
        }
        db.prepare('DELETE FROM mangas WHERE tanda_id = ?').run(tanda.id);
        db.prepare('DELETE FROM drivers WHERE tanda_id = ?').run(tanda.id);
        db.prepare('DELETE FROM teams   WHERE tanda_id = ?').run(tanda.id);
        const entities = [];
        valid.forEach((team, idx) => {
          const teamName = team.name.trim();
          const teamId   = Team.create({ race_id: race.id, tanda_id: tanda.id, name: teamName, lane: 0, color: LANE_COLORS[idx] });
          const members  = Array.isArray(team.members) ? team.members : Object.values(team.members || {});
          members.forEach(m => {
            const mName = (typeof m === 'string' ? m : m?.name)?.trim();
            if (mName) Driver.create({ race_id: race.id, tanda_id: tanda.id, team_id: teamId, name: mName });
          });
          entities.push({ id: teamId, type: 'team', name: teamName });
        });
        Manga.persistSchedule(tanda.id, race.id, Manga.buildSchedule(laneSequence, entities));
      } else {
        teamsArray.forEach(team => {
          const teamId = parseInt(team.id);
          if (teamId && team.name?.trim()) {
            db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(team.name.trim(), teamId);
          }
          const members = typeof team.members === 'object' ? Object.values(team.members) : [];
          members.forEach(m => {
            const memberId = parseInt(m.id);
            if (memberId && m.name?.trim()) {
              db.prepare('UPDATE drivers SET name = ? WHERE id = ?').run(m.name.trim(), memberId);
            }
          });
        });
      }
    }

    res.redirect(`/races/${race.id}`);
  }

  // DELETE /races/:id/tandas/:tandaId
  static delete(req, res) {
    Tanda.delete(req.params.tandaId);
    res.redirect(`/races/${req.params.id}`);
  }
}

module.exports = TandaController;
