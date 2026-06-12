const path = require('path');
const fs   = require('fs');
const os   = require('os');
const db   = require('../config/database');

// Gestión de la base de datos: copia de seguridad (descarga un snapshot del
// .db) e —en el futuro— importación. La importación se hará por "staging +
// aplicar al reiniciar", porque no se puede sustituir en caliente el fichero
// SQLite que la app tiene abierto en WAL.
class DatabaseController {

  // GET /database — página de gestión.
  static index(req, res) {
    let sizeBytes = null;
    let dbPath    = null;
    try {
      dbPath    = db.name;                    // better-sqlite3: ruta del fichero abierto
      sizeBytes = fs.statSync(dbPath).size;
    } catch { /* si falla, la vista muestra "—" */ }
    res.render('database/index', { t: req.t, sizeBytes, dbPath });
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
}

module.exports = DatabaseController;
