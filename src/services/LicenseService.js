const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Secret used to sign/verify license files.
// Change this before shipping — keep it private.
const SIGN_SECRET = 'slt-2026-xK9mP3qR7vN2wL5j';

// Modules included in each tier (cumulative upward)
const TIER_MODULES = {
  basic: ['simulation', 'ds300_single', 'training', 'races_basic'],
  pro:   ['races_unlimited', 'export', 'mobile', 'pole',
          'driver_profiles', 'teams_catalog', 'team_races', 'best_laps',
          'multi_circuit', 'tv', 'qr_checkin', 'lemans'],
};

const TIER_RANK = { basic: 0, pro: 1 };

function hardwareId() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac.toLowerCase();
      }
    }
  }
  return 'unknown';
}

function sign(payload) {
  // Deterministic serialisation: sort keys
  const sorted = Object.keys(payload).sort().reduce((o, k) => { o[k] = payload[k]; return o; }, {});
  return crypto.createHmac('sha256', SIGN_SECRET).update(JSON.stringify(sorted)).digest('hex');
}

// ── Licensing disabled ────────────────────────────────────────────────────────
// All devices run as PRO. No license file, signature or hardware check.
// Kept the API surface intact so callers don't break.
class LicenseServiceClass {
  constructor() {
    this._license = null;
    this._error   = null;
  }

  load(/* dataDir */) {
    console.log('[License] PRO — licenciamiento desactivado (todos los módulos activos)');
  }

  get tier()      { return 'pro'; }
  get tierRank()  { return TIER_RANK.pro; }
  has(/* module */) { return true; }

  get info() {
    return {
      tier:       'pro',
      licensee:   'Voltrace Manager',
      expiresAt:  null,
      error:      null,
      hardwareId: hardwareId(),
    };
  }

  get maxTandasPerRace() { return Infinity; }
  get maxMangasPerRace() { return Infinity; }
}

module.exports = new LicenseServiceClass();
