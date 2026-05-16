#!/usr/bin/env node
// Analiza captura DS-300 contra el protocolo documentado en DS300-protocolo.md
// Valida checksum (B18) y verifica si el 86% de "first crossings" son tramas corruptas.

const fs = require('fs');
const FILE = process.argv[2] || '/Users/victor/SloTime/src/data/RegistroCarrera.txt';

const FRAME_GAP_MS = 75;
const MIN_CROSSING_MS = 500;
const MAX_LAP_MS = 240000;

function ds300Byte(b) {
  return ((b >> 4) <= 9 && (b & 0xF) <= 9) ? parseInt(b.toString(16), 10) : null;
}
function readLapTimeMs(f) {
  if (f.length < 18) return null;
  const m=ds300Byte(f[14]), s=ds300Byte(f[15]), c=ds300Byte(f[16]), d=ds300Byte(f[17]);
  if (m===null||s===null||c===null||d===null) return null;
  return m*60000 + s*1000 + c*10 + d*0.1;
}
function computeChecksum(f) {
  // B18 = (B1 + B2 + ... + B17) mod 256
  let s = 0;
  for (let i = 1; i <= 17; i++) s += f[i];
  return s & 0xFF;
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(l => l.trim());
const frames = [];
for (const line of lines) {
  const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(.+)$/);
  if (!m) continue;
  const bytes = m[5].trim().split(/\s+/).map(b => parseInt(b, 16));
  if (bytes.length !== 21) continue;
  frames.push({ line, bytes });
}

let checksumOk = 0, checksumBad = 0;
let badAndFirstCross = 0, okAndFirstCross = 0;
let badAndValidTime = 0, okAndValidTime = 0;

for (const fr of frames) {
  const f = fr.bytes;
  const cs = computeChecksum(f);
  const stored = f[18];
  const ok = (cs === stored);
  if (ok) checksumOk++; else checksumBad++;

  // Sólo analizar cruces (B7=0x1B, lane mask != 0)
  if (f[7] !== 0x1B || f[10] === 0) continue;
  const lap = readLapTimeMs(f);
  if (lap === null) { ok ? okAndFirstCross++ : badAndFirstCross++; }
  else if (lap >= MIN_CROSSING_MS && lap <= MAX_LAP_MS) { ok ? okAndValidTime++ : badAndValidTime++; }
}

console.log(`Total tramas: ${frames.length}`);
console.log(`Checksum OK:  ${checksumOk}`);
console.log(`Checksum BAD: ${checksumBad}\n`);

console.log('=== Cruces (B7=0x1B, B10!=0) ===');
console.log(`  Checksum OK  + tiempo válido:     ${okAndValidTime}`);
console.log(`  Checksum OK  + "first crossing":  ${okAndFirstCross}`);
console.log(`  Checksum BAD + tiempo válido:     ${badAndValidTime}`);
console.log(`  Checksum BAD + "first crossing":  ${badAndFirstCross}`);

// Mostrar 5 ejemplos de cada categoría
function dumpExamples(label, predicate) {
  const ex = frames.filter(predicate).slice(0, 3);
  if (ex.length === 0) return;
  console.log(`\n--- ${label} (${ex.length} ejemplos) ---`);
  for (const e of ex) console.log(`  ${e.line}`);
}
dumpExamples('CS OK + first crossing',  fr => fr.bytes[7]===0x1B && fr.bytes[10]!==0 && computeChecksum(fr.bytes)===fr.bytes[18] && readLapTimeMs(fr.bytes)===null);
dumpExamples('CS BAD + first crossing', fr => fr.bytes[7]===0x1B && fr.bytes[10]!==0 && computeChecksum(fr.bytes)!==fr.bytes[18] && readLapTimeMs(fr.bytes)===null);
dumpExamples('CS BAD + valid time',     fr => fr.bytes[7]===0x1B && fr.bytes[10]!==0 && computeChecksum(fr.bytes)!==fr.bytes[18] && readLapTimeMs(fr.bytes)!==null);
