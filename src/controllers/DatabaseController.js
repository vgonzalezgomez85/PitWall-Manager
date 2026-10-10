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
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const multer = require('multer');
const db     = require('../config/database');
const RaceArchive = require('../services/RaceArchive');
const ExportGuard = require('../services/ExportGuard');

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Nombre fijo: una nueva subida siempre reemplaza a la pendiente anterior, sin
// dejar restos sueltos en la carpeta de datos.
const RESTORE_FILENAME = 'pitwall-restore-pending.db';

const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.dirname(db.name)),
    filename:    (req, file, cb) => cb(null, RESTORE_FILENAME),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB — de sobra para años de carreras
});

const raceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Gestión de la base de datos: copia de seguridad (descarga un snapshot del
// .db) e importación (sube un .db a "staging"; se aplica en el próximo
// arranque — ver src/config/database.js — porque no se puede sustituir en
// caliente el fichero SQLite que la app tiene abierto en WAL).
class DatabaseController {

  // GET /database — página de gestión.
  static index(req, res) {
    let sizeBytes = null;
    let dbPath    = null;
    try {
      dbPath    = db.name;                    // better-sqlite3: ruta del fichero abierto
      sizeBytes = fs.statSync(dbPath).size;
    } catch { /* si falla, la vista muestra "—" */ }

    let pendingRestore = null;
    try {
      const pendingPath = path.join(path.dirname(dbPath), RESTORE_FILENAME);
      const stat = fs.statSync(pendingPath);
      pendingRestore = { sizeBytes: stat.size, uploadedAt: stat.mtime };
    } catch { /* no hay ninguna copia pendiente */ }

    const races = db.prepare(`
      SELECT r.id, r.name, r.status, COALESCE(r.finished_at, r.started_at, r.created_at) AS at,
             (SELECT COUNT(*) FROM mangas m WHERE m.race_id = r.id AND m.status = 'active') AS open_mangas
      FROM races r ORDER BY COALESCE(r.finished_at, r.started_at, r.created_at) DESC, r.id DESC
    `).all();

    const counts = {};
    for (const table of ['races', 'teams', 'drivers', 'circuits', 'laps']) {
      try { counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
      catch { counts[table] = null; }
    }

    res.render('database/index', { t: req.t, sizeBytes, dbPath, pendingRestore, counts, races });
  }

  // GET /database/backup — descarga un snapshot consistente de la BD.
  // Usa el backup online de better-sqlite3 (seguro aunque haya escrituras en
  // curso, p.ej. durante una carrera) en vez de copiar el fichero a mano.
  static async backup(req, res) {
    const pad   = n => String(n).padStart(2, '0');
    const d     = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const fileName = `pitwall-backup-${stamp}.db`;
    const tmpPath  = path.join(os.tmpdir(), `vt-backup-${Date.now()}.db`);

    try {
      await db.backup(tmpPath);
      res.download(tmpPath, fileName, () => {
        // Borra el temporal una vez enviado (o si falló el envío).
        fs.unlink(tmpPath, () => {});
      });
    } catch (err) {
      console.error('[DatabaseController] backup failed:', err.message);
      try { fs.unlinkSync(tmpPath); } catch {}
      if (!res.headersSent) {
        res.status(500).render('error', { t: req.t, code: 500, message: 'No se pudo generar la copia de seguridad' });
      }
    }
  }

  // POST /database/restore — sube un .db a "staging". No toca la BD en uso:
  // solo se aplica en el próximo arranque de PitWall (ver src/config/database.js).
  static restore(req, res) {
    restoreUpload.single('backup_file')(req, res, (err) => {
      const lang = req.session?.lang || 'es';
      if (err) {
        req.session.flash = { type: 'error', text: (req.t('database.no_se_pudo_subir_el_archivo')) + err.message };
        return res.redirect('/database');
      }
      if (!req.file) {
        req.session.flash = { type: 'error', text: req.t('database.selecciona_un_archivo_db') };
        return res.redirect('/database');
      }

      // Valida que sea realmente una BD SQLite antes de aceptarla como pendiente
      // (si no, un fichero cualquiera se aplicaría sobre pitwall.db al reiniciar).
      try {
        const header = Buffer.alloc(16);
        const fd = fs.openSync(req.file.path, 'r');
        fs.readSync(fd, header, 0, 16, 0);
        fs.closeSync(fd);
        if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
          fs.unlinkSync(req.file.path);
          req.session.flash = { type: 'error', text: req.t('database.el_archivo_no_es_una_base_de_datos_sqlite_valida') };
          return res.redirect('/database');
        }
      } catch {
        req.session.flash = { type: 'error', text: req.t('database.no_se_pudo_validar_el_archivo') };
        return res.redirect('/database');
      }

      req.session.flash = {
        type: 'success',
        text: req.t('database.copia_cargada_cierra_pitwall_por_completo_y'),
      };
      res.redirect('/database');
    });
  }

  // GET /database/race-export?race=ID — descarga UNA carrera completa (.pwrace).
  static raceExport(req, res) {
    const es = (req.session?.lang || 'es') === 'es';
    const fail = text => { req.session.flash = { type: 'error', text }; res.redirect('/database'); };
    if (ExportGuard.isMangaLive()) {
      return fail(req.t('database.hay_una_manga_en_marcha_exporta_la_carrera'));
    }
    try {
      const { archive, buffer } = RaceArchive.exportRaceFile(parseInt(req.query.race, 10));
      const slug = String(archive.race.name || 'carrera')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'carrera';
      const day = String(archive.race.finished_at || archive.race.started_at || archive.race.created_at || '').slice(0, 10);
      res.attachment(`${slug}${day ? '-' + day : ''}.pwrace`);
      res.type('application/gzip');
      res.send(buffer);
    } catch (e) {
      if (e.code === 'not_found') return fail(req.t('database.esa_carrera_no_existe'));
      if (e.code === 'open_manga') {
        return fail(req.t('database.la_carrera_tiene_una_manga_sin_cerrar_cierrala'));
      }
      console.error('[DatabaseController] race export failed:', e.message);
      fail(req.t('database.no_se_pudo_exportar_la_carrera'));
    }
  }

  // POST /database/race-import — crea la carrera del archivo como carrera NUEVA.
  static raceImport(req, res) {
    raceUpload.single('race_file')(req, res, (err) => {
      const es = (req.session?.lang || 'es') === 'es';
      const fail = text => { req.session.flash = { type: 'error', text }; res.redirect('/database'); };
      if (err) return fail((req.t('database.no_se_pudo_subir_el_archivo')) + err.message);
      if (!req.file) return fail(req.t('database.selecciona_un_archivo_pwrace'));
      // Miles de inserciones en una transacción: con una manga viva bloquearía
      // el hilo lo bastante como para partir una trama del DS-300.
      if (ExportGuard.isMangaLive()) {
        return fail(req.t('database.hay_una_manga_en_marcha_importa_la_carrera'));
      }
      try {
        const result = RaceArchive.importRace(RaceArchive.parseFile(req.file.buffer));
        const name = escapeHtml(result.name);
        const circuitNote = result.circuitCreated
          ? (es ? ` Se ha creado el circuito «${escapeHtml(result.circuitName)}».` : ` Circuit "${escapeHtml(result.circuitName)}" was created.`)
          : '';
        req.session.flash = {
          type: 'success',
          text: (es
            ? `Carrera «<a href="/races/${result.raceId}">${name}</a>» importada (${result.laps.toLocaleString('es-ES')} vueltas).`
            : `Race "<a href="/races/${result.raceId}">${name}</a>" imported (${result.laps.toLocaleString('en-US')} laps).`) + circuitNote,
        };
        res.redirect('/database');
      } catch (e) {
        if (e.code === 'exists') {
          req.session.flash = {
            type: 'error',
            text: es
              ? `Esta carrera ya está en este PC: <a href="/races/${e.existingId}">${escapeHtml(e.existingName)}</a>.`
              : `This race is already on this PC: <a href="/races/${e.existingId}">${escapeHtml(e.existingName)}</a>.`,
          };
          return res.redirect('/database');
        }
        if (e.code === 'bad_file') return fail(req.t('database.el_archivo_no_es_una_carrera_exportada_de'));
        if (e.code === 'newer_version') return fail(req.t('database.el_archivo_viene_de_una_version_mas_nueva_de'));
        console.error('[DatabaseController] race import failed:', e);
        fail(es ? 'No se pudo importar la carrera: ' + escapeHtml(e.message) : 'Could not import the race: ' + escapeHtml(e.message));
      }
    });
  }

  // POST /database/restore/cancel — descarta la copia pendiente sin aplicarla.
  static cancelRestore(req, res) {
    const lang = req.session?.lang || 'es';
    try {
      const pendingPath = path.join(path.dirname(db.name), RESTORE_FILENAME);
      fs.unlinkSync(pendingPath);
      req.session.flash = { type: 'success', text: req.t('database.importacion_pendiente_cancelada') };
    } catch {
      req.session.flash = { type: 'error', text: req.t('database.no_habia_ninguna_importacion_pendiente') };
    }
    res.redirect('/database');
  }
}

module.exports = DatabaseController;
