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

    res.render('database/index', { t: req.t, sizeBytes, dbPath, pendingRestore });
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
        req.session.flash = { type: 'error', text: (lang === 'es' ? 'No se pudo subir el archivo: ' : 'Could not upload the file: ') + err.message };
        return res.redirect('/database');
      }
      if (!req.file) {
        req.session.flash = { type: 'error', text: lang === 'es' ? 'Selecciona un archivo .db.' : 'Select a .db file.' };
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
          req.session.flash = { type: 'error', text: lang === 'es' ? 'El archivo no es una base de datos SQLite válida.' : 'The file is not a valid SQLite database.' };
          return res.redirect('/database');
        }
      } catch {
        req.session.flash = { type: 'error', text: lang === 'es' ? 'No se pudo validar el archivo.' : 'Could not validate the file.' };
        return res.redirect('/database');
      }

      req.session.flash = {
        type: 'success',
        text: lang === 'es'
          ? 'Copia cargada. Cierra PitWall por completo y vuelve a abrirlo para aplicarla — hasta entonces sigues viendo los datos actuales. Se guarda automáticamente una copia de seguridad de los datos actuales antes de aplicarla.'
          : 'Backup uploaded. Fully close PitWall and reopen it to apply it — until then you still see the current data. The current data is backed up automatically before applying it.',
      };
      res.redirect('/database');
    });
  }

  // POST /database/restore/cancel — descarta la copia pendiente sin aplicarla.
  static cancelRestore(req, res) {
    const lang = req.session?.lang || 'es';
    try {
      const pendingPath = path.join(path.dirname(db.name), RESTORE_FILENAME);
      fs.unlinkSync(pendingPath);
      req.session.flash = { type: 'success', text: lang === 'es' ? 'Importación pendiente cancelada.' : 'Pending import cancelled.' };
    } catch {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'No había ninguna importación pendiente.' : 'There was no pending import.' };
    }
    res.redirect('/database');
  }
}

module.exports = DatabaseController;
