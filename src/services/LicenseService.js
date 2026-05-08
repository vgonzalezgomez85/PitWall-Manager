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
  club:  ['races_unlimited', 'export', 'mobile', 'pole'],
  pro:   ['multi_circuit', 'tv'],
};

const TIER_RANK = { basic: 0, club: 1, pro: 2 };

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

class LicenseServiceClass {
  constructor() {
    this._license = null;  // null = basic (no file)
    this._error   = null;
  }

  // Call once at startup with the data directory path
  load(dataDir) {
    const filePath = path.join(dataDir, 'slotime.license');
    if (!fs.existsSync(filePath)) {
      this._license = null;
      return;
    }
    try {
      const raw     = fs.readFileSync(filePath, 'utf8');
      const license = JSON.parse(raw);
      const { signature, ...payload } = license;

      // Verify signature
      if (sign(payload) !== signature) {
        this._error = 'Licencia inválida (firma incorrecta)';
        this._license = null;
        return;
      }

      // Check hardware ID (wildcard '*' skips check)
      if (payload.hardwareId !== '*' && payload.hardwareId !== hardwareId()) {
        this._error = 'Licencia no válida para este equipo';
        this._license = null;
        return;
      }

      // Check expiry
      if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) {
        this._error = `Licencia expirada el ${payload.expiresAt}`;
        this._license = null;
        return;
      }

      this._license = license;
      this._error   = null;
      console.log(`[License] ${payload.tier.toUpperCase()} — ${payload.licensee} — válida hasta ${payload.expiresAt}`);
    } catch (e) {
      this._error   = 'Fichero de licencia corrupto';
      this._license = null;
    }
  }

  // Active tier: 'basic' | 'club' | 'pro'
  get tier() {
    return this._license?.tier ?? 'basic';
  }

  get tierRank() {
    return TIER_RANK[this.tier] ?? 0;
  }

  // Check if a specific module is enabled
  has(module) {
    const rank = this.tierRank;
    for (const [tier, modules] of Object.entries(TIER_MODULES)) {
      if (modules.includes(module) && TIER_RANK[tier] <= rank) return true;
    }
    return false;
  }

  get info() {
    return {
      tier:      this.tier,
      licensee:  this._license?.licensee ?? 'Sin licencia',
      expiresAt: this._license?.expiresAt ?? null,
      error:     this._error,
      hardwareId: hardwareId(),
    };
  }

  // Basic tier limits
  get maxTandasPerRace() { return this.has('races_unlimited') ? Infinity : 1; }
  get maxMangasPerRace() { return this.has('races_unlimited') ? Infinity : 1; }
}

module.exports = new LicenseServiceClass();
