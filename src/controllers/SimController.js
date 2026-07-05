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
// Asistente de "Carrera simulada": crea una carrera a partir de un fichero de
// tramas DS-300 (txt o csv) + el orden de carril de los equipos. Fase 1: crear
// la carrera lista para simular (la simulación en vivo es la fase 2).

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const dsFrames = require('../lib/dsFrames');
const SimPlayer = require('../services/SimPlayerService');
const db = require('../config/database');
const Race = require('../models/Race');
const Tanda = require('../models/Tanda');
const Team = require('../models/Team');
const Manga = require('../models/Manga');
const { SIM_DIR, ensureSimDir } = require('../lib/simPaths');

// Carpeta escribible (userData en empaquetado, database/ en dev). ensureSimDir
// NUNCA lanza, así que requerir este módulo no puede tumbar el arranque.
const TMP_DIR = ensureSimDir('_tmp');

// Multer: a disco, hasta 60 MB (los registros de 24h pesan ~15 MB).
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 60 * 1024 * 1024 } });

const COLORS = n => Array.from({ length: n }, (_, i) => `hsl(${Math.round(i * 360 / n)}, 70%, 50%)`);
const splitTeams = raw => (raw || '').replace(/\r/g, '').split('\n').map(l => l.split(',')[0].trim()).filter(Boolean);

const SimController = {
  upload,

  // GET /races/sim/new — subir el fichero de tramas
  newForm(req, res) {
    res.render('races/sim-new', { t: req.t, error: req.query.error || null });
  },

  // POST /races/sim/analyze — parsea las tramas y muestra el formulario de confirmación
  analyze(req, res) {
    if (!req.file) return res.redirect('/races/sim/new?error=' + encodeURIComponent('Sube un fichero de tramas.'));
    let content;
    try { content = fs.readFileSync(req.file.path, 'utf8'); }
    catch { return res.redirect('/races/sim/new?error=' + encodeURIComponent('No se pudo leer el fichero.')); }

    const fmt = /\.csv$/i.test(req.file.originalname) ? 'csv' : (/\.txt$/i.test(req.file.originalname) ? 'txt' : undefined);
    let parsed;
    try { parsed = dsFrames.parse(content, fmt); }
    catch (e) { return res.redirect('/races/sim/new?error=' + encodeURIComponent('Tramas no válidas: ' + e.message)); }

    if (!parsed.frames.length) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.redirect('/races/sim/new?error=' + encodeURIComponent('No se reconoció ninguna trama en el fichero.'));
    }

    // El fichero subido (req.file.filename) queda en _tmp; lo referenciamos por token.
    const token = req.file.filename;
    res.render('races/sim-confirm', {
      t: req.t,
      token,
      source: parsed.analysis.source,
      a: parsed.analysis,
      raceName: req.body.name || '',
    });
  },

  // POST /races/sim/create — crea la carrera con la config confirmada
  create(req, res) {
    const token = (req.body.token || '').replace(/[^a-f0-9]/gi, '');
    const tmpPath = path.join(TMP_DIR, token);
    if (!token || !fs.existsSync(tmpPath)) {
      return res.redirect('/races/sim/new?error=' + encodeURIComponent('La sesión de subida caducó, vuelve a subir el fichero.'));
    }
    const content = fs.readFileSync(tmpPath, 'utf8');
    const fmt = req.body.source === 'csv' ? 'csv' : 'txt';
    const parsed = dsFrames.parse(content, fmt);

    // Orden de carril: csv subido (req.file) o textarea manual.
    let teamNames = [];
    if (req.file) { try { teamNames = splitTeams(fs.readFileSync(req.file.path, 'utf8')); } catch {} }
    if (!teamNames.length) teamNames = splitTeams(req.body.lane_order);
    if (!teamNames.length) {
      return res.redirect('/races/sim/new?error=' + encodeURIComponent('Indica el orden de carril de los equipos.'));
    }

    const name = (req.body.name || 'Carrera simulada').trim();
    const lanes = Math.max(1, parseInt(req.body.lanes, 10) || parsed.analysis.lanes || teamNames.length);
    const rests = Math.max(0, parseInt(req.body.rests, 10) || 0);
    const mangaMin = Math.max(1, parseInt(req.body.manga_minutes, 10) || parsed.analysis.durationMin || 5);
    const minLapMs = Math.max(0, parseInt(req.body.min_lap_ms, 10) || 8500);

    // circuitos: los detectados (8/8/6…) o, si no, todo en uno.
    const circuits = (parsed.analysis.circuits && parsed.analysis.circuits.length)
      ? parsed.analysis.circuits.map(c => c.lanes)
      : [lanes];

    // lane_sequence = carriles activos (1..lanes) + descansos (0).
    const laneSeq = [...Array.from({ length: lanes }, (_, i) => i + 1), ...Array(rests).fill(0)];

    // Crear carrera + tanda + equipos + mangas (rotación de PitWall).
    const raceId = Race.create({
      name, type: 'club', format: 'team', lanes_count: lanes,
      lane_sequence: laneSeq, manga_duration_minutes: mangaMin, circuits, has_pole: 0, min_lap_ms: minLapMs,
    });
    const tandaId = Tanda.create(raceId);
    const colors = COLORS(teamNames.length);
    const entities = teamNames.map((tn, i) => ({
      id: Team.create({ race_id: raceId, tanda_id: tandaId, name: tn, lane: 0, color: colors[i] }),
      type: 'team', name: tn,
    }));
    const schedule = Manga.buildSchedule(laneSeq, entities);
    Manga.persistSchedule(tandaId, raceId, schedule);
    db.prepare("UPDATE mangas SET status='pending' WHERE race_id=?").run(raceId);
    Race.updateStatus(raceId, 'active');

    // Guardar las tramas + meta para la simulación (fase 2).
    try {
      const framePath = path.join(SIM_DIR, `${raceId}.frames`);
      fs.renameSync(tmpPath, framePath);
      fs.writeFileSync(path.join(SIM_DIR, `${raceId}.json`), JSON.stringify({
        raceId, source: fmt, framePath: `${raceId}.frames`,
        durationMin: mangaMin, lanes, rests, circuits,
        mangas: parsed.analysis.mangas, crossings: parsed.analysis.crossings,
        createdAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) { console.error('[sim] no se pudo guardar tramas:', e.message); }

    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }

    // A la página de la carrera. Desde ahí (o en /races/:id/sim) se reproduce.
    res.redirect(`/races/${raceId}/sim`);
  },

  // ── Fase 2: panel de simulación + controles ────────────────────────────────
  hasSim(raceId) {
    return fs.existsSync(path.join(SIM_DIR, `${raceId}.json`)) && fs.existsSync(path.join(SIM_DIR, `${raceId}.frames`));
  },

  // GET /races/:id/sim — panel de control de la simulación
  panel(req, res) {
    const race = Race.findById(req.params.id);
    if (!race) return res.status(404).render('lap/error', { message: 'Carrera no encontrada.', layout: false });
    if (!SimController.hasSim(race.id)) {
      return res.status(400).render('lap/error', { message: 'Esta carrera no es simulada (no tiene tramas).', layout: false });
    }
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(SIM_DIR, `${race.id}.json`), 'utf8')); } catch {}
    res.render('races/sim-panel', {
      t: req.t,
      race: { id: race.id, name: race.name },
      meta,
      status: SimPlayer.status,
    });
  },

  // Controles (JSON). Devuelven el estado del reproductor.
  async simStart(req, res) {
    try {
      const speed = parseFloat(req.body.speed) || 1;
      const st = await SimPlayer.start(Number(req.params.id), speed);
      res.json(st);
    } catch (e) { res.status(400).json({ error: e.message }); }
  },
  simSpeed(req, res) { res.json(SimPlayer.setSpeed(parseFloat(req.body.speed) || 1)); },
  simPause(req, res) { res.json(SimPlayer.pause()); },
  simResume(req, res) { res.json(SimPlayer.resume()); },
  simSkip(req, res) { res.json(SimPlayer.skipMangaEnd()); },
  async simStop(req, res) { res.json(await SimPlayer.stop()); },
  simStatus(req, res) { res.json(SimPlayer.status); },
};

module.exports = SimController;
