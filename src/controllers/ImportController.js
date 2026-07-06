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
// Importar una tanda de PitWall Control y autocrear la carrera. Dos vías, un
// solo endpoint:
//   - Subida de fichero: el navegador del operador lee el .json y lo POSTea.
//   - LAN: PitWall Control descubre a Manager (Bonjour) y POSTea el mismo JSON.
// El POST no está en isPublicPath → queda LAN-only (bloqueado por el tunnel
// público). La aceptación la gatea importAuthorized(): localhost/allowlist entra
// libre; una IP de la LAN no allowlisted necesita el PIN (x-import-pin).

const Settings = require('../models/Settings');
const accessControl = require('../middleware/accessControl');
const TandaImport = require('../services/TandaImport');

// Devuelve el PIN de import, generándolo (4 dígitos) la primera vez.
function ensureImportPin() {
  let pin = String(Settings.get('import_pin', '') || '');
  if (!/^\d{4}$/.test(pin)) {
    pin = String(Math.floor(1000 + Math.random() * 9000));
    Settings.set('import_pin', pin);
  }
  return pin;
}

// ¿Autorizada la importación? localhost/allowlist siempre; en otro caso, el PIN
// correcto en la cabecera x-import-pin (mismo patrón que linkControlAuthorized).
function importAuthorized(req) {
  const ip = accessControl.normIp(req.ip || req.socket?.remoteAddress || '');
  if (accessControl.ipAllowed(ip)) return true;
  const expected = String(Settings.get('import_pin', '') || '');
  if (!/^\d{4}$/.test(expected)) return false;
  return String(req.headers['x-import-pin'] || '') === expected;
}

const ImportController = {
  // GET /import/tanda — pantalla de subida de fichero + PIN de emparejamiento.
  page(req, res) {
    res.render('import/tanda', { t: req.t, pin: ensureImportPin() });
  },

  // POST /import/tanda — crea la carrera desde el payload del body (fichero o LAN).
  create(req, res) {
    if (!importAuthorized(req)) {
      return res.status(403).json({ ok: false, error: 'PIN de importación incorrecto o dispositivo no autorizado.' });
    }
    try {
      const payload = req.body && req.body.payload ? req.body.payload : req.body;
      const result = TandaImport.createFromPayload(payload);
      res.json({ ok: true, ...result });
    } catch (e) {
      const code = e instanceof TandaImport.TandaImportError ? 400 : 500;
      res.status(code).json({ ok: false, error: e.message });
    }
  },
};

module.exports = ImportController;
