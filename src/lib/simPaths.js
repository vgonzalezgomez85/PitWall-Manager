// Rutas de datos de la simulación de carrera.
//
// En empaquetado (Electron) el código vive en app.asar / Program Files, que es
// de SOLO LECTURA: escribir ahí (fs.mkdirSync) peta y tumba el arranque del
// server. Por eso los datos van a una carpeta ESCRIBIBLE: `SLOTIME_DATA`
// (= app.getPath('userData'), igual criterio que config/database.js). En dev,
// cuando no está definida, caen en `database/` del repo.
const path = require('path');
const fs   = require('fs');

const BASE = process.env.SLOTIME_DATA || path.join(__dirname, '..', '..', 'database');
const SIM_DIR = path.join(BASE, 'sim');

// Crea (si hace falta) el directorio de sim (o un subdirectorio) y lo devuelve.
// NUNCA lanza: si no se puede crear, no debe impedir que el server arranque.
function ensureSimDir(sub) {
  const dir = sub ? path.join(SIM_DIR, sub) : SIM_DIR;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best-effort */ }
  return dir;
}

module.exports = { SIM_DIR, ensureSimDir };
