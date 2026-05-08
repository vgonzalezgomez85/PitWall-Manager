#!/usr/bin/env node
/**
 * SloTime license generator — internal tool for issuing license files.
 *
 * Usage:
 *   node tools/generate-license.js --tier club --licensee "Mi Club" --hardware "aa:bb:cc:dd:ee:ff" --expires 2027-12-31
 *   node tools/generate-license.js --tier pro   --licensee "Pro Team" --hardware "*" --expires 2027-06-30
 *
 * Options:
 *   --tier       basic | club | pro  (required)
 *   --licensee   Name of the licensee  (required)
 *   --hardware   MAC address or '*' for any hardware  (required)
 *   --expires    ISO date YYYY-MM-DD  (required)
 *   --out        Output file path (default: stdout)
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SIGN_SECRET = 'slt-2026-xK9mP3qR7vN2wL5j';

function sign(payload) {
  const sorted = Object.keys(payload).sort().reduce((o, k) => { o[k] = payload[k]; return o; }, {});
  return crypto.createHmac('sha256', SIGN_SECRET).update(JSON.stringify(sorted)).digest('hex');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);

const required = ['tier', 'licensee', 'hardware', 'expires'];
for (const key of required) {
  if (!args[key]) {
    console.error(`Missing required argument: --${key}`);
    process.exit(1);
  }
}

if (!['basic', 'club', 'pro'].includes(args.tier)) {
  console.error('Invalid tier. Use: basic | club | pro');
  process.exit(1);
}

// Validate date
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expires)) {
  console.error('Invalid date format. Use YYYY-MM-DD');
  process.exit(1);
}

const payload = {
  tier:       args.tier,
  licensee:   args.licensee,
  hardwareId: args.hardware,
  expiresAt:  args.expires,
  issuedAt:   new Date().toISOString().split('T')[0],
};

const license = { ...payload, signature: sign(payload) };
const json = JSON.stringify(license, null, 2);

if (args.out) {
  fs.writeFileSync(args.out, json, 'utf8');
  console.log(`License written to ${args.out}`);
} else {
  console.log(json);
}
