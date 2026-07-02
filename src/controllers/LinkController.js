const Race = require('../models/Race');
const RaceTransfer = require('../services/RaceTransfer');
const Settings = require('../models/Settings');
const { getJson } = require('../utils/linkHttp');

// ── LinkController ──────────────────────────────────────────────────────────
// Endpoints del enlace MAESTRO↔ESCLAVO (Fase 1: provisión de la carrera).
//   MAESTRO expone:  GET /link/races             (lista para que el esclavo elija)
//                    GET /link/races/:id/export.json  (payload completo)
//   ESCLAVO usa:     POST /link/provision        (descarga del maestro + crea)
//                    POST /link/import            (crea desde un payload/fichero — plan B)
// Todo es aditivo: rutas nuevas bajo /link, no altera nada existente.

// Descarga JSON por HTTP/HTTPS (factorizado en utils/linkHttp).
const fetchJson = getJson;

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
    // Config actual del enlace para pintar la sección de ajustes.
    const linkCfg = {
      role:     Settings.get('link_role', 'off'),
      slaveUrl: Settings.get('link_slave_url', ''),
      token:    Settings.get('link_token', ''),
    };
    // Estado en vivo del cronómetro local (para mostrarlo en la pantalla).
    const TimingService = require('../services/TimingService');
    const linkState = {
      activeMangaId: TimingService.activeMangaId,
      isRunning:     TimingService.isRunning,
      isPaused:      TimingService.isPaused,
    };
    res.render('link/index', { linkCfg, linkState });   // lang/t/flash/tier/serialStatus vienen de res.locals
  }

  // POST /link/config — guarda rol/URL/token del enlace (operador local).
  //   body: { role, slaveUrl, token }. Aplica al RaceLinkService en caliente.
  static saveConfig(req, res) {
    try {
      const role  = ['off', 'master', 'slave'].includes(req.body.role) ? req.body.role : 'off';
      const slaveUrl = String(req.body.slaveUrl || '').trim();
      const token    = String(req.body.token || '').trim();
      Settings.setMany({ link_role: role, link_slave_url: slaveUrl, link_token: token });
      // Reconfigura el maestro en caliente (arranca/para el empuje de estado).
      try { require('../services/RaceLinkService').reconfigure(); } catch (e) { /* best-effort */ }
      if (req.xhr || (req.get('accept') || '').includes('application/json')) {
        return res.json({ ok: true, role, slaveUrl, token });
      }
      req.session.flash = { type: 'success', text: (req.session?.lang === 'en') ? 'Link settings saved.' : 'Ajustes del enlace guardados.' };
      res.redirect('/link');
    } catch (e) {
      if (req.xhr || (req.get('accept') || '').includes('application/json')) {
        return res.status(400).json({ ok: false, error: e.message });
      }
      req.session.flash = { type: 'error', text: e.message };
      res.redirect('/link');
    }
  }

  // POST /link/state — el MAESTRO empuja el estado deseado; el ESCLAVO reconcilia.
  // La exención de IP la hace accessControl; la AUTORIZACIÓN (role=slave + token)
  // la comprueba linkControlAuthorized. Delega en LinkReconciler.apply().
  static state(req, res) {
    const accessControl = require('../middleware/accessControl');
    if (!accessControl.linkControlAuthorized(req)) {
      return res.status(403).json({ ok: false, error: 'link_forbidden' });
    }
    try {
      const LinkReconciler = require('../services/LinkReconciler');
      const result = LinkReconciler.apply(req.body || {});
      const TimingService = require('../services/TimingService');
      res.json({
        ok: result.ok,
        applied: result.applied,
        reason: result.reason || null,
        slaveState: {
          activeMangaId: TimingService.activeMangaId,
          isRunning:     TimingService.isRunning,
          isPaused:      TimingService.isPaused,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }

  // POST /link/event — alias fino de /link/state (por si más adelante se quieren
  // eventos discretos; hoy entra por el MISMO apply()).
  static event(req, res) {
    return LinkController.state(req, res);
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
