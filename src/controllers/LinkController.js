const http  = require('http');
const https = require('https');
const { URL } = require('url');

const Race = require('../models/Race');
const RaceTransfer = require('../services/RaceTransfer');

// ── LinkController ──────────────────────────────────────────────────────────
// Endpoints del enlace MAESTRO↔ESCLAVO (Fase 1: provisión de la carrera).
//   MAESTRO expone:  GET /link/races             (lista para que el esclavo elija)
//                    GET /link/races/:id/export.json  (payload completo)
//   ESCLAVO usa:     POST /link/provision        (descarga del maestro + crea)
//                    POST /link/import            (crea desde un payload/fichero — plan B)
// Todo es aditivo: rutas nuevas bajo /link, no altera nada existente.

// Descarga JSON por HTTP/HTTPS sin dependencias externas.
function fetchJson(rawUrl, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch { return reject(new Error('URL inválida')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`El maestro respondió ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Respuesta del maestro no es JSON válido')); }
      });
    });
    req.on('error', e => reject(new Error(`No se pudo conectar con el maestro: ${e.message}`)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout conectando con el maestro')); });
  });
}

// Normaliza un host/URL de maestro a base http:// sin barra final.
function normalizeMasterBase(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Falta la dirección del maestro');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;   // el usuario pega "192.168.1.50:3000"
  return s.replace(/\/+$/, '');
}

class LinkController {
  // GET /link — pantalla de operador del ESCLAVO para provisionar una carrera
  // desde el maestro por LAN. Solo renderiza; los datos los pide el cliente por
  // fetch a los endpoints existentes (/link/master/races, /link/provision, …).
  static page(req, res) {
    res.render('link/index', {});   // lang/t/flash/tier/serialStatus vienen de res.locals
  }

  // GET /link/races — lista de carreras para que un esclavo elija (JSON).
  static listRaces(req, res) {
    try {
      const races = Race.findAll().map(r => ({
        id: r.id,
        name: r.name,
        raceKey: r.race_key || null,
        type: r.type,
        format: r.format,
        tandaCount: r.tanda_count,
        driverCount: r.driver_count,
        createdAt: r.created_at,
      }));
      res.json({ races });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  // GET /link/races/:id/export.json — payload completo de una carrera.
  static exportRace(req, res) {
    try {
      const payload = RaceTransfer.exportRace(parseInt(req.params.id, 10));
      res.json(payload);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  }

  // POST /link/import — crea la carrera desde un payload en el body (plan B / fichero).
  //   body: el payload directamente, o { payload }.
  static importPayload(req, res) {
    try {
      const payload = req.body && req.body.payload ? req.body.payload : req.body;
      const raceId = RaceTransfer.importRace(payload);
      res.json({ ok: true, raceId });
    } catch (e) {
      if (e instanceof RaceTransfer.RaceExistsError) {
        return res.status(409).json({ error: e.message, existingId: e.existingId, raceKey: e.raceKey });
      }
      res.status(400).json({ error: e.message });
    }
  }

  // POST /link/provision — el ESCLAVO descarga la carrera del MAESTRO y la crea.
  //   body: { masterUrl, raceId }  (masterUrl = "192.168.1.50:3000" o URL completa)
  static async provision(req, res) {
    try {
      const { masterUrl, raceId } = req.body || {};
      if (raceId == null) return res.status(400).json({ error: 'Falta raceId' });
      const base = normalizeMasterBase(masterUrl);
      const payload = await fetchJson(`${base}/link/races/${parseInt(raceId, 10)}/export.json`);
      const newId = RaceTransfer.importRace(payload);
      res.json({ ok: true, raceId: newId, raceKey: payload.raceKey, name: payload.race && payload.race.name });
    } catch (e) {
      if (e instanceof RaceTransfer.RaceExistsError) {
        return res.status(409).json({ error: e.message, existingId: e.existingId, raceKey: e.raceKey });
      }
      res.status(400).json({ error: e.message });
    }
  }

  // GET /link/master/races?url=... — proxy: el ESCLAVO pide al MAESTRO su lista
  // (evita CORS en el navegador del esclavo; la petición sale del servidor).
  static async remoteRaces(req, res) {
    try {
      const base = normalizeMasterBase(req.query.url);
      const data = await fetchJson(`${base}/link/races`);
      res.json(data);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
}

module.exports = LinkController;
