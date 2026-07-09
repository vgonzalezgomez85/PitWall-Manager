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
const Race         = require('../models/Race');
const Driver       = require('../models/Driver');
const Team         = require('../models/Team');
const Tanda        = require('../models/Tanda');
const Manga        = require('../models/Manga');
const Lap          = require('../models/Lap');
const PoleSession  = require('../models/PoleSession');
const Circuit      = require('../models/Circuit');
const Settings     = require('../models/Settings');
const TimingService = require('../services/TimingService');

const LANE_COLORS = [
  '#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#00bcd4',
  '#ff5722','#607d8b','#795548','#e91e63','#3f51b5','#009688',
  '#cddc39','#ffc107','#f44336','#673ab7','#03a9f4','#8bc34a',
  '#ff6f00','#880e4f','#1a237e','#b71c1c','#004d40','#f57f17',
  '#311b92','#0d47a1','#1b5e20','#33691e','#bf360c','#4a148c',
  '#006064','#827717'
];

// Default lane sequence: odd lanes ascending, then even lanes descending
// e.g. 6 lanes → [1,3,5,6,4,2]
function defaultSequence(n) {
  const odds  = [];
  const evens = [];
  for (let i = 1; i <= n; i++) {
    if (i % 2 !== 0) odds.push(i); else evens.push(i);
  }
  return [...odds, ...evens.reverse()];
}

class RaceController {

  static index(req, res) {
    const fs = require('fs'), path = require('path');
    const { SIM_DIR } = require('../lib/simPaths');
    const races = Race.findAll().map(r => ({
      ...r,
      is_sim: fs.existsSync(path.join(SIM_DIR, `${r.id}.json`)),
    }));
    res.render('races/index', { t: req.t, races });
  }

  // ─── Step 1: name + type + lanes + manga duration ─────────────────────────

  static newStep1(req, res) {
    req.session.wizard = {};
    // Preselect the circuit assigned to the DS-300 in settings (if any).
    // Looks at circuits_serial[].circuit_id; first entry with a circuit wins.
    let defaultCircuitId = '';
    try {
      const cfg = JSON.parse(Settings.get('circuits_serial', '[]')) || [];
      const found = cfg.find(c => c && c.circuit_id);
      if (found) defaultCircuitId = String(found.circuit_id);
    } catch {}
    const body = defaultCircuitId ? { circuit_id: defaultCircuitId } : {};
    const savedCircuits = Circuit.findAll();
    // Map<circuitId, [{ category_id, category_name, min_lap_ms }]> so the
    // wizard can offer a category selector when the chosen circuit has
    // per-category Pt overrides configured.
    const circuitCategoryTimes = {};
    for (const c of savedCircuits) {
      const times = Circuit.getCategoryTimes(c.id);
      if (times.length) circuitCategoryTimes[c.id] = times;
    }
    res.render('races/new-step1', { t: req.t, errors: [], body, savedCircuits, circuitCategoryTimes });
  }

  static postStep1(req, res) {
    const { name, type } = req.body;
    const errors = [];

    const trimmedName = (name || '').trim();
    if (trimmedName.length < 2) errors.push('name_required');
    if (!['club', 'championship'].includes(type)) errors.push('type_required');

    const duration = 99; // DS-300 controls actual duration via GO signal

    // Parse circuit configuration
    const circuitId = parseInt(req.body.circuit_id, 10) || null;
    const categoryId = parseInt(req.body.category_id, 10) || null;
    let circuits = [];
    let minLapMs = 0;

    if (circuitId) {
      const savedCircuit = Circuit.findById(circuitId);
      if (savedCircuit) {
        circuits = Circuit.getConfig(savedCircuit);
        // Pt hierarchy: per-category override > circuit default.
        minLapMs = Circuit.getMinLapMsForCategory(circuitId, categoryId);
      }
    }

    if (!circuits.length) {
      const numCircuits = Math.max(1, Math.min(6, parseInt(req.body.circuits_count, 10) || 1));
      for (let i = 1; i <= numCircuits; i++) {
        const n = parseInt(req.body[`circuit_lanes_${i}`], 10);
        if (isNaN(n) || n < 2 || n > 8) { errors.push('lanes_invalid'); break; }
        circuits.push(n);
      }
      const minLapS = parseFloat(req.body.min_lap_s);
      minLapMs = (!isNaN(minLapS) && minLapS > 0) ? Math.round(minLapS * 1000) : 0;
    }

    const totalLanes = circuits.reduce((a, b) => a + b, 0);
    if (!errors.includes('lanes_invalid') && (totalLanes < 2 || totalLanes > 32)) {
      errors.push('lanes_invalid');
    }

    if (errors.length) {
      const savedCircuits = Circuit.findAll();
      const circuitCategoryTimes = {};
      for (const c of savedCircuits) {
        const times = Circuit.getCategoryTimes(c.id);
        if (times.length) circuitCategoryTimes[c.id] = times;
      }
      return res.render('races/new-step1', { t: req.t, errors, body: req.body, savedCircuits, circuitCategoryTimes });
    }

    // Reglas de turnos por piloto (solo si type === 'championship'; en otros
    // casos se guardan a 0 = sin límite y se ignoran).
    let driverMinMs = 0, driverMaxMs = 0, lockoutMs = 120000, driverMaxRuns = 0;
    if (type === 'championship') {
      const minMin = parseInt(req.body.driver_min_total_min, 10);
      const maxMin = parseInt(req.body.driver_max_total_min, 10);
      const lockS  = parseInt(req.body.driver_change_lockout_s, 10);
      const maxRuns = parseInt(req.body.driver_max_runs, 10);
      if (!isNaN(minMin) && minMin > 0) driverMinMs = minMin * 60 * 1000;
      if (!isNaN(maxMin) && maxMin > 0) driverMaxMs = maxMin * 60 * 1000;
      if (!isNaN(lockS)  && lockS  >= 0) lockoutMs = lockS * 1000;
      if (!isNaN(maxRuns) && maxRuns > 0) driverMaxRuns = maxRuns;
      // Validación coherencia: max debe ser >= min si ambos > 0
      if (driverMinMs > 0 && driverMaxMs > 0 && driverMaxMs < driverMinMs) {
        errors.push('driver_max_below_min');
      }
    }

    // El formato se DERIVA del tipo (ya no es una elección del usuario):
    //   Sprint (club) → individual · Resistencia (championship) → equipos.
    const format = type === 'championship' ? 'team' : 'individual';

    if (errors.length) {
      const savedCircuits = Circuit.findAll();
      const circuitCategoryTimes = {};
      for (const c of savedCircuits) {
        const times = Circuit.getCategoryTimes(c.id);
        if (times.length) circuitCategoryTimes[c.id] = times;
      }
      return res.render('races/new-step1', { t: req.t, errors, body: req.body, savedCircuits, circuitCategoryTimes });
    }

    req.session.wizard = {
      name: trimmedName, type, format,
      lanes_count: totalLanes,
      circuits,
      manga_duration_minutes: duration,
      passes:      Math.max(1, parseInt(req.body.passes, 10)      || 1),
      lane_repeat: Math.max(1, parseInt(req.body.lane_repeat, 10) || 1),
      has_pole: req.body.has_pole === '1' ? 1 : 0,
      circuit_id: circuitId,
      category_id: categoryId,
      min_lap_ms: minLapMs,
      driver_min_total_ms:      driverMinMs,
      driver_max_total_ms:      driverMaxMs,
      driver_change_lockout_ms: lockoutMs,
      driver_max_runs:          driverMaxRuns,
    };
    // El paso 2 (Formato) ya no existe: enrutamos directamente.
    return RaceController._routeAfterFormat(req, res);
  }

  // ─── Step 2 (Formato) — ELIMINADO del flujo. El formato se deriva del tipo en
  //     postStep1; el enrutado lo hace _routeAfterFormat. ──

  // Enrutado tras fijar el formato: con circuito asignado la secuencia la manda
  // el circuito y el paso 3 se salta (no accesible ni con "atrás"); en carrera
  // manual va al editor de secuencia (paso 3).
  static _routeAfterFormat(req, res) {
    const w = req.session.wizard;
    if (w.circuit_id) {
      const Circuit = require('../models/Circuit');
      const c = Circuit.findById(w.circuit_id);
      let seq = c ? Circuit.getLaneSequence(c) : null;
      if (!seq || seq.length === 0) seq = defaultSequence(w.lanes_count);
      w.lane_sequence = seq;
      return res.redirect(w.has_pole ? '/races/new/step4' : '/races/new/confirm');
    }
    if (!w.lane_sequence || !w.lane_sequence.length) w.lane_sequence = defaultSequence(w.lanes_count);
    return res.redirect('/races/new/step3');
  }

  // ─── Step 3: lane rotation sequence (solo carreras manuales sin circuito) ─────

  static newStep3(req, res) {
    if (!req.session.wizard?.format) return res.redirect('/races/new');
    const w = req.session.wizard;
    // Con circuito asignado la secuencia es la del circuito: el paso 3 no se
    // muestra ni es accesible (redirige hacia delante).
    if (w.circuit_id) return res.redirect(w.has_pole ? '/races/new/step4' : '/races/new/confirm');
    const seq = w.lane_sequence || defaultSequence(w.lanes_count);
    const circuits = w.circuits || [w.lanes_count];
    res.render('races/new-step3-sequence', { t: req.t, wizard: w, sequence: seq, circuits, errors: [] });
  }

  static postStep3(req, res) {
    if (!req.session.wizard?.format) return res.redirect('/races/new');
    // Blindaje: una carrera con circuito no edita secuencia aquí.
    if (req.session.wizard.circuit_id) {
      return res.redirect(req.session.wizard.has_pole ? '/races/new/step4' : '/races/new/confirm');
    }
    const raw = req.body.lane_sequence || '';
    // Allow 0 for explicit rest slots
    const seq = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 0);

    const errors = [];
    const lanes = req.session.wizard.lanes_count;
    const nonRest = seq.filter(n => n > 0);
    const unique  = [...new Set(nonRest)];
    if (unique.length !== lanes || unique.some(n => n < 1 || n > lanes)) {
      errors.push('sequence_invalid');
    }
    if (errors.length) {
      const circuits = req.session.wizard.circuits || [req.session.wizard.lanes_count];
      return res.render('races/new-step3-sequence', {
        t: req.t, wizard: req.session.wizard, sequence: seq, circuits, errors
      });
    }

    req.session.wizard.lane_sequence = seq;
    // If pole enabled, collect participants in step 4 before confirm
    if (req.session.wizard.has_pole) return res.redirect('/races/new/step4');
    res.redirect('/races/new/confirm');
  }

  // ─── Step 4: participants (only when has_pole=1) ──────────────────────────

  static newStep4(req, res) {
    const w = req.session.wizard;
    if (!w?.lane_sequence) return res.redirect('/races/new');
    if (!w.has_pole)       return res.redirect('/races/new/confirm');
    const DriverProfile = require('../models/DriverProfile');
    const TeamCatalog   = require('../models/TeamCatalog');
    res.render('races/new-step4', {
      t: req.t, wizard: w, LANE_COLORS, profiles: DriverProfile.findAll(),
      teamsCatalog: TeamCatalog.findAll(), errors: [], body: {}
    });
  }

  static postStep4(req, res) {
    const w = req.session.wizard;
    if (!w?.lane_sequence) return res.redirect('/races/new');

    const DriverProfile = require('../models/DriverProfile');
    const errors = [];
    let participants = [];

    if (w.format === 'individual') {
      const names = Array.isArray(req.body.drivers) ? req.body.drivers : Object.values(req.body.drivers || {});
      const filled = names.filter(n => n?.trim());
      if (filled.length < 2) errors.push('not_enough_drivers');
      filled.forEach(name => participants.push({ name: name.trim(), members: [] }));
    } else {
      const rawTeams = req.body.teams || {};
      const teamsArr = Array.isArray(rawTeams) ? rawTeams : Object.values(rawTeams);
      const filled   = teamsArr.filter(t => t?.name?.trim());
      if (filled.length < 2) errors.push('not_enough_teams');
      filled.forEach(team => {
        const members = Array.isArray(team.members) ? team.members : Object.values(team.members || {});
        participants.push({
          name: team.name.trim(),
          members: members.filter(m => m?.trim()).map(m => m.trim())
        });
      });
    }

    if (errors.length) {
      const TeamCatalog = require('../models/TeamCatalog');
      return res.render('races/new-step4', {
        t: req.t, wizard: w, LANE_COLORS, profiles: DriverProfile.findAll(),
        teamsCatalog: TeamCatalog.findAll(), errors, body: req.body
      });
    }

    req.session.wizard.participants = participants;
    res.redirect('/races/new/confirm');
  }

  // ─── Confirm ──────────────────────────────────────────────────────────────

  static newConfirm(req, res) {
    const w = req.session.wizard;
    if (!w?.lane_sequence) return res.redirect('/races/new');
    if (w.has_pole && !w.participants) return res.redirect('/races/new/step4');
    res.render('races/confirm', { t: req.t, wizard: w, LANE_COLORS });
  }

  // ─── POST /races — persist ────────────────────────────────────────────────

  static create(req, res) {
    const wizard = req.session.wizard;
    if (!wizard?.name) return res.redirect('/races/new');

    const raceId = Race.create({
      name:                   wizard.name,
      type:                   wizard.type,
      format:                 wizard.format,
      lanes_count:            wizard.lanes_count,
      lane_sequence:          wizard.lane_sequence,
      manga_duration_minutes: wizard.manga_duration_minutes,
      circuits:               wizard.circuits || [wizard.lanes_count],
      has_pole:               wizard.has_pole || 0,
      circuit_id:             wizard.circuit_id || null,
      min_lap_ms:             wizard.min_lap_ms || 0,
      // Reglas de turnos por piloto (solo championship; el wizard guarda 0
      // para no-championship).
      driver_min_total_ms:      wizard.driver_min_total_ms      || 0,
      driver_max_total_ms:      wizard.driver_max_total_ms      || 0,
      driver_change_lockout_ms: wizard.driver_change_lockout_ms || 120000,
      driver_max_runs:          wizard.driver_max_runs          || 0,
      passes:                   wizard.passes                   || 1,
      lane_repeat:              wizard.lane_repeat              || 1,
    });

    // If pole enabled, create session + entries from wizard participants
    if (wizard.has_pole && wizard.participants?.length) {
      const sessionId = PoleSession.create(raceId);
      const entityType = wizard.format === 'team' ? 'team' : 'driver';
      wizard.participants.forEach(p => {
        PoleSession.addEntry({
          poleSessionId: sessionId,
          entityType,
          entityName:    p.name,
          membersJson:   p.members?.length ? JSON.stringify(p.members) : null
        });
      });
    }

    req.session.wizard = null;
    res.redirect(`/races/${raceId}`);
  }

  // ─── GET /races/:id ───────────────────────────────────────────────────────

  static show(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    // If a manga is currently active, go straight to live
    const activeManga = Manga.findActive(race.id);
    if (activeManga) return res.redirect(`/races/${race.id}/mangas/${activeManga.id}/live`);

    const laneSequence = Race.getLaneSequence(race);
    const tandas = Tanda.findByRace(race.id);

    // Load mangas + lanes for each tanda
    const tandasWithMangas = tandas.map(tanda => {
      const mangas = Manga.findByTanda(tanda.id);
      const mangasWithLanes = mangas.map(m => ({ ...m, lanes: Manga.getLanes(m.id) }));
      return { ...tanda, mangas: mangasWithLanes };
    });

    // Virtual (projected) standings
    const aggregate  = Lap.aggregateByRace(race.id);
    const scheduled  = Manga.scheduledCountByRace(race.id);
    const schedMap   = {};
    scheduled.forEach(s => { schedMap[`${s.entity_type}:${s.entity_id}`] = s.total_mangas; });

    const virtualStandings = aggregate.map(row => {
      const key           = `${row.entity_type}:${row.entity_id}`;
      const totalScheduled = schedMap[key] ?? row.mangas_raced;
      const avgLaps        = row.mangas_raced > 0 ? row.total_laps / row.mangas_raced : 0;
      const remaining      = Math.max(0, totalScheduled - row.mangas_raced);
      return {
        entity_name:      row.entity_name,
        color:            row.color,
        total_laps:       row.total_laps,
        mangas_raced:     row.mangas_raced,
        total_scheduled:  totalScheduled,
        avg_laps:         Math.round(avgLaps * 10) / 10,
        projected_laps:   Math.round(row.total_laps + avgLaps * remaining),
        exit_count:       row.exit_count || 0,
      };
    }).sort((a, b) => b.projected_laps - a.projected_laps || b.total_laps - a.total_laps);
    virtualStandings.forEach((r, i) => { r.position = i + 1; });

    const poleSession = race.has_pole ? PoleSession.findByRace(race.id) : null;

    // Pre-register the first pending manga so DS-300 GO can start it from this page
    if (!TimingService.isRunning) {
      const firstPending = tandasWithMangas.flatMap(t => t.mangas).find(m => m.status === 'pending');
      if (firstPending) {
        const teams   = Team.findByTanda(firstPending.tanda_id);
        const drivers = Driver.findByTanda(firstPending.tanda_id);
        const lanes   = Manga.getLanes(firstPending.id);
        TimingService.setPendingManga(firstPending, race, lanes, teams, drivers);
      }
    }

    const isSim = require('fs').existsSync(
      require('path').join(require('../lib/simPaths').SIM_DIR, `${race.id}.json`));
    res.render('races/show', {
      t: req.t, race, laneSequence, tandas: tandasWithMangas,
      virtualStandings, LANE_COLORS, poleSession, isSim,
    });
  }

  // ─── GET /races/:id/edit ──────────────────────────────────────────────────
  // Focused edit: race name + (circuit, if one was assigned) OR (manual min
  // lap, for races configured by hand). Manga duration is NOT editable here —
  // it's taken live from the DS-300 GO signal.

  // Nº de descansos (slots de carril 0) que tiene la carrera. Prioriza ceros
  // explícitos en la secuencia; si no, lo deriva de una manga existente o de
  // las inscripciones de pole; si no hay nada, 0.
  static _restSlots(race, activeLanesLen) {
    const db = require('../config/database');
    let seq = []; try { seq = JSON.parse(race.lane_sequence || '[]'); } catch {}
    const explicit = seq.filter(x => x === 0).length;
    if (explicit > 0) return explicit;
    const mg = db.prepare('SELECT id FROM mangas WHERE race_id=? ORDER BY id ASC LIMIT 1').get(race.id);
    if (mg) {
      const slots = db.prepare('SELECT COUNT(*) c FROM manga_lanes WHERE manga_id=?').get(mg.id).c;
      return Math.max(0, slots - activeLanesLen);
    }
    const pe = db.prepare('SELECT COUNT(*) c FROM pole_entries pe JOIN pole_sessions ps ON ps.id=pe.pole_session_id WHERE ps.race_id=?').get(race.id);
    return Math.max(0, (pe.c || 0) - activeLanesLen);
  }

  // Secuencia para el editor: la guardada + tantos descansos (0) como falten
  // para llegar al total de descansos de la carrera (añadidos al final).
  static _editorSequence(race, restCount) {
    let seq = []; try { seq = JSON.parse(race.lane_sequence || '[]'); } catch {}
    const have = seq.filter(x => x === 0).length;
    if (have < restCount) seq = [...seq, ...Array(restCount - have).fill(0)];
    return seq;
  }

  // Regenera el horario de las tandas PENDIENTES (todas sus mangas pending) con
  // la secuencia actual de la carrera, conservando equipos/pilotos y su orden.
  // No toca tandas con mangas ya corridas. `race` debe estar recién leído.
  static _regeneratePendingTandas(race) {
    const db    = require('../config/database');
    const Manga = require('../models/Manga');
    const laneSequence = Race.getLaneSequence(race);
    const tandas = db.prepare('SELECT id FROM tandas WHERE race_id = ?').all(race.id);
    for (const t of tandas) {
      const mangas = db.prepare('SELECT status FROM mangas WHERE tanda_id = ?').all(t.id);
      if (mangas.length && !mangas.every(m => m.status === 'pending')) continue;  // hay mangas corridas → no tocar
      const entities = race.format === 'team'
        ? db.prepare('SELECT id, name FROM teams WHERE tanda_id = ? ORDER BY id ASC').all(t.id).map(x => ({ id: x.id, type: 'team', name: x.name }))
        : db.prepare('SELECT id, name FROM drivers WHERE tanda_id = ? AND team_id IS NULL ORDER BY id ASC').all(t.id).map(x => ({ id: x.id, type: 'driver', name: x.name }));
      if (!entities.length) continue;
      // Borra también las vueltas de esas mangas: la FK es ON DELETE SET NULL,
      // así que sin esto quedarían huérfanas (manga_id NULL) y contaminarían
      // medias/proyección de la carrera.
      db.prepare('DELETE FROM laps WHERE manga_id IN (SELECT id FROM mangas WHERE tanda_id = ?)').run(t.id);
      require('../models/Lap').markExternalMutation();
      db.prepare('DELETE FROM mangas WHERE tanda_id = ?').run(t.id);
      Manga.persistSchedule(t.id, race.id, Manga.buildSchedule(laneSequence, entities, race.passes, race.lane_repeat));
    }
  }

  static editForm(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const savedCircuits = Circuit.findAll();
    const circuitCategoryTimes = {};
    for (const c of savedCircuits) {
      const times = Circuit.getCategoryTimes(c.id);
      if (times.length) circuitCategoryTimes[c.id] = times;
    }
    const activeLen  = Race.getLaneSequence(race).filter(l => l > 0).length;
    const restCount  = RaceController._restSlots(race, activeLen);
    res.render('races/edit', {
      t: req.t, race, savedCircuits, circuitCategoryTimes,
      hasLaps: Race.hasRecordedLaps(race.id), errors: [],
      laneSequence: RaceController._editorSequence(race, restCount),
      restCount, LANE_COLORS,
    });
  }

  // ─── POST /races/:id/edit ─────────────────────────────────────────────────

  static update(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('error', { t: req.t, code: 404, message: 'Race not found' });

    const errors = [];
    const name   = (req.body.name || '').trim();
    if (name.length < 2) errors.push('name_required');

    const hasLaps = Race.hasRecordedLaps(race.id);
    const patch   = { name };

    // Escenario (circuito guardado): se puede ASIGNAR, CAMBIAR o QUITAR en
    // cualquier carrera mientras no tenga vueltas registradas (reajusta
    // carriles y secuencia). La config derivada + vuelta mínima vienen del
    // escenario elegido (y de la categoría, si se elige).
    let circuitAssigned = false;
    if (!hasLaps && req.body.circuit_id !== undefined) {
      const circuitId  = parseInt(req.body.circuit_id, 10) || null;
      const categoryId = parseInt(req.body.category_id, 10) || null;
      const circuit    = circuitId ? Circuit.findById(circuitId) : null;
      if (circuit) {
        const circuits = Circuit.getConfig(circuit);
        patch.circuit_id      = circuitId;
        patch.circuits_config = circuits;
        patch.lanes_count     = circuits.reduce((a, b) => a + b, 0);
        patch.lane_sequence   = Circuit.getLaneSequence(circuit);
        patch.min_lap_ms      = Circuit.getMinLapMsForCategory(circuitId, categoryId);
        circuitAssigned = true;
      } else if (!circuitId && race.circuit_id) {
        // «Sin escenario»: pasa a manual conservando la configuración actual
        // (se materializa la secuencia del escenario en la carrera).
        patch.circuit_id    = null;
        patch.lane_sequence = JSON.stringify(Race.getLaneSequence(race));
      }
      // Escenario inválido → se mantiene el actual sin tocar.
    }

    // Configuración manual (solo si la carrera queda SIN escenario: la vuelta
    // mínima y la secuencia las dicta el escenario cuando lo hay).
    const manualAfter = !circuitAssigned && (patch.circuit_id === null || !race.circuit_id);
    if (manualAfter) {
      // Vuelta mínima…
      if (req.body.min_lap_s !== undefined) {
        const minLapS = parseFloat(req.body.min_lap_s);
        patch.min_lap_ms = (!isNaN(minLapS) && minLapS > 0) ? Math.round(minLapS * 1000) : 0;
      }

      // …y reordenar la SECUENCIA de carriles (circuito manual, sin catálogo).
      // Solo se permite REORDENAR: el nuevo orden debe contener exactamente los
      // mismos carriles que el actual (mismo multiconjunto), no añadir/quitar.
      if (req.body.lane_sequence != null && String(req.body.lane_sequence).trim() !== '') {
        const current   = Race.getLaneSequence(race);
        const activeLen  = current.filter(l => l > 0).length;
        const expectRest = RaceController._restSlots(race, activeLen);
        let seq = [];
        try { seq = JSON.parse(req.body.lane_sequence); } catch {}
        if (!Array.isArray(seq)) seq = String(req.body.lane_sequence).split(',');
        seq = seq.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 0);
        const lanesOf = a => a.filter(x => x > 0);
        const restsOf = a => a.filter(x => x === 0).length;
        const norm    = a => [...a].sort((x, y) => x - y).join(',');
        // Solo reordenar: mismos carriles (>0) y mismo nº de descansos (0).
        if (seq.length && norm(lanesOf(seq)) === norm(lanesOf(current)) && restsOf(seq) === expectRest) {
          patch.lane_sequence = JSON.stringify(seq);
        } else {
          errors.push('sequence_invalid');
        }
      }
    }

    if (errors.length) {
      const savedCircuits = Circuit.findAll();
      const circuitCategoryTimes = {};
      for (const c of savedCircuits) {
        const times = Circuit.getCategoryTimes(c.id);
        if (times.length) circuitCategoryTimes[c.id] = times;
      }
      const activeLen = Race.getLaneSequence(race).filter(l => l > 0).length;
      const restCount = RaceController._restSlots(race, activeLen);
      return res.render('races/edit', {
        t: req.t, race: { ...race, name }, savedCircuits, circuitCategoryTimes, hasLaps, errors,
        laneSequence: RaceController._editorSequence(race, restCount), restCount, LANE_COLORS,
      });
    }

    Race.update(race.id, patch);

    // Si cambió la secuencia de carriles, regenerar las tandas pendientes para
    // que la rotación (y los descansos) reflejen el nuevo orden al instante.
    if (patch.lane_sequence) {
      try { RaceController._regeneratePendingTandas(Race.findById(race.id)); } catch (e) {
        console.warn('[RaceController] regen tandas falló:', e.message);
      }
    }
    res.redirect(`/races/${race.id}`);
  }

  // ─── DELETE /races/:id ────────────────────────────────────────────────────

  static delete(req, res) {
    Race.delete(req.params.id);
    res.redirect('/races');
  }

  // ─── POST /races/:id/complete ─────────────────────────────────────────────

  static complete(req, res) {
    const raceId = req.params.id;
    Race.updateStatus(raceId, 'finished');

    // Push a full stats dossier to all connected mobile clients so they can
    // persist a local copy and view the history offline. Wrapped in try/
    // catch so a snapshot failure can never block the redirect.
    try {
      const MobileController = require('./MobileController');
      const SocketService    = require('../services/SocketService');
      const snapshot = MobileController.buildStatsSnapshot(raceId);
      if (snapshot) SocketService.emit('race:stats-snapshot', snapshot);
    } catch (err) {
      console.error('[RaceController] stats-snapshot emit failed:', err.message);
    }

    res.redirect(`/races/${raceId}`);
  }
}

module.exports = RaceController;
