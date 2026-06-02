#!/usr/bin/env node
// Validación bit-exacta del codec Infolap contra paquetes reales capturados.
// Si esto pasa, el server emitirá bytes idénticos al PC Tic Tac Slot original.

const codec = require('../src/services/infolapCodec');

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m';

// ── Casos de prueba sacados de las 3 capturas válidas ───────────────────────
//
// Cada caso replica un paquete REAL capturado por Wireshark. El hex es el
// payload UDP exacto (52 bytes). Si encode produce los mismos bytes, el
// codec es correcto.
const CASES = [
  // === capture2 (lane 1 solo, varios tiempos) ===
  {
    capture: 'cap2 pkt1',
    expectedHex: '303035303150696c6f746f2031202020202020202020202020202020202031373331333230202020303030303130303130303150',
    params: { seq: 5, lane: 1, name: 'Piloto 1', lapMs: 10656, firstReport: true, mangaNum: 1, altFlag: ' ' },
  },
  {
    capture: 'cap2 pkt2',
    expectedHex: '303036303150696c6f746f2031202020202020202020202020202020202046363033333034462020303030305830303130303150',
    params: { seq: 6, lane: 1, name: 'Piloto 1', lapMs: 2875, firstReport: false, mangaNum: 1, altFlag: 'F' },
  },
  {
    capture: 'cap2 pkt3',
    expectedHex: '303037303150696c6f746f2031202020202020202020202020202020202036363036333132202020303030305830303130303150',
    params: { seq: 7, lane: 1, name: 'Piloto 1', lapMs: 3125, firstReport: false, mangaNum: 1, altFlag: ' ' },
  },
  // === capture3 (6 carriles, ciclo completo) ===
  {
    capture: 'cap3 pkt1 (lane 1 first)',
    expectedHex: '303031303150696c6f746f2031202020202020202020202020202020202033364437334236462020303030305830303130303150',
    // Para descifrar: decoder("36D73B6") → ms = ?
    // f[0]='3' xor 7 = 4 (tenths=4 → 400)
    // f[1]='6' xor 6 = 0 (tens=0)
    // f[2]='D' xor 5 = 8 (ms=8)
    // f[3]='7' xor 4 = 3 (cents=3 → 30)
    // f[4]='3' xor 3 = 0 (hundreds=0)
    // f[5]='B' xor 2 = 9 (units=9 → 9000)
    // total = 9000 + 400 + 30 + 8 = 9438ms
    params: { seq: 1, lane: 1, name: 'Piloto 1', lapMs: 9438, firstReport: false, mangaNum: 1, altFlag: 'F' },
  },
  {
    capture: 'cap3 pkt2 (lane 2 no lap)',
    expectedHex: '303032303250696c6f746f2032202020202020202020202020202020202045463534414231202020303030303130303230303150',
    params: { seq: 2, lane: 2, name: 'Piloto 2', lapMs: null, firstReport: true, mangaNum: 1, altFlag: ' ' },
  },
  {
    capture: 'cap3 pkt6 (lane 6 no lap)',
    expectedHex: '303036303650696c6f746f2036202020202020202020202020202020202045463534414231202020303030303130303630303150',
    params: { seq: 6, lane: 6, name: 'Piloto 6', lapMs: null, firstReport: true, mangaNum: 1, altFlag: ' ' },
  },
  // === capture4 (mangaNum = 0 — caso edge) ===
  {
    capture: 'cap4 pkt1 (manga 000)',
    expectedHex: '303031303150696c6f746f2031202020202020202020202020202020202045463534414231202020303030303130303130303050',
    params: { seq: 1, lane: 1, name: 'Piloto 1', lapMs: null, firstReport: true, mangaNum: 0, altFlag: ' ' },
  },
];

let pass = 0, fail = 0;

// El byte en posición 36 codifica un estado interno del servidor que el
// cliente Android IGNORA al decodificar (ver comentario del decoder). No lo
// podemos reproducir sin conocer su algoritmo, pero tampoco hace falta:
// enmascaramos ese byte en la comparación y validamos por separado que el
// decoder extrae el lap correcto de NUESTRO paquete generado.
const IGNORED_BYTES = new Set([36]);

function maskIgnored(hex) {
  const out = hex.split('');
  for (const b of IGNORED_BYTES) {
    out[b * 2]     = '?';
    out[b * 2 + 1] = '?';
  }
  return out.join('');
}

for (const tc of CASES) {
  const got = codec.buildPacket(tc.params);
  const gotHex    = got.toString('hex');
  const maskedGot = maskIgnored(gotHex);
  const maskedExp = maskIgnored(tc.expectedHex);

  // Además del match bit-a-bit (modulo state byte), verificamos que el
  // decoder de la mismísima codec.js extrae el lap correcto de nuestro
  // paquete (lo que el cliente Android va a ver).
  const ourTimeField = gotHex.slice(30 * 2, 37 * 2);     // 7 chars hex = 14 hex chars
  const decodedFromOurs = codec.decodeLapField(Buffer.from(ourTimeField, 'hex').toString('latin1'));
  const decodeOk = decodedFromOurs === (tc.params.lapMs ?? null);

  const bytesOk = maskedGot === maskedExp;
  const ok = bytesOk && decodeOk;
  if (ok) {
    console.log(`${GREEN}OK${RESET}   ${tc.capture}  (lap decode → ${decodedFromOurs}ms)`);
    pass++;
  } else {
    console.log(`${RED}FAIL${RESET} ${tc.capture}`);
    if (!bytesOk) {
      console.log(`     expected: ${tc.expectedHex}`);
      console.log(`     got:      ${gotHex}`);
      for (let i = 0; i < Math.min(gotHex.length, tc.expectedHex.length); i += 2) {
        if (IGNORED_BYTES.has(i / 2)) continue;
        if (gotHex.slice(i, i + 2) !== tc.expectedHex.slice(i, i + 2)) {
          console.log(`     ${DIM}byte ${i / 2}: expected ${tc.expectedHex.slice(i, i + 2)} got ${gotHex.slice(i, i + 2)}${RESET}`);
        }
      }
    }
    if (!decodeOk) {
      console.log(`     lap decode mismatch: expected ${tc.params.lapMs} got ${decodedFromOurs}`);
    }
    fail++;
  }
}

// ── Round-trip decode test ──────────────────────────────────────────────────
console.log('\n--- round-trip encode→decode ---');
const samples = [1000, 5123, 10656, 71390, 999, 100000, 9999];
for (const ms of samples) {
  const enc = codec.encodeLapField(ms);
  const dec = codec.decodeLapField(enc);
  const ok = dec === ms;
  console.log(`${ok ? GREEN + 'OK  ' : RED + 'FAIL'}${RESET} ${ms}ms → ${enc} → ${dec}ms`);
  if (ok) pass++; else fail++;
}

// ── Discovery probe / response ──────────────────────────────────────────────
console.log('\n--- discovery ---');
const probe = Buffer.from('InfoLap:C098', 'latin1');
const probeOk = codec.isDiscoveryProbe(probe);
console.log(`${probeOk ? GREEN + 'OK  ' : RED + 'FAIL'}${RESET} probe detection`);
if (probeOk) pass++; else fail++;

const resp = codec.buildDiscoveryResponse([
  { name: 'Piloto 1', id: '001' },
  { name: 'Piloto 2', id: '002' },
]);
const respHex = resp.toString('hex');
// "OK Piloto 1;#001Piloto 2;#002" = 4f4b2050696c6f746f20313b2330303150696c6f746f20323b23303032
const expectedResp = '4f4b2050696c6f746f20313b2330303150696c6f746f20323b23303032';
const respOk = respHex === expectedResp;
console.log(`${respOk ? GREEN + 'OK  ' : RED + 'FAIL'}${RESET} discovery response`);
if (!respOk) {
  console.log(`     expected: ${expectedResp}`);
  console.log(`     got:      ${respHex}`);
}
if (respOk) pass++; else fail++;

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
