#!/usr/bin/env node
/*
 * Generador de tramas DS-300 SINTÉTICAS para un banco de pruebas de estrés:
 * 24 carriles (3 cajas DS1/DS2/DS3 de 8 carriles cada una), 3 mangas de ~5
 * minutos. Produce un fichero .txt con el mismo formato que
 * `database/sim/42.frames` (dataset real de las 24h de Modena):
 *
 *   HH:MM:SS.mmm<TAB>DSn<TAB><21 bytes hex separados por espacio>
 *
 * La construcción de cada trama (checksum, BCD, secuencia de GO/verde/fin)
 * REUTILIZA tal cual la lógica verificada en el emulador hermano
 * (~/ds300-emulator/emulator.js: buildFrame/computeChecksum/encodeLapTime/
 * goFrame1-3/firstCrossingFrame/lapCrossingFrame/finishFrame), solo
 * parametrizada por "caja" (DS1/DS2/DS3) para tener 3 contadores de trama
 * independientes, como 3 unidades DS-300 físicas reales.
 *
 * Uso: node scripts/gen-frames-24lanes.js [salida.txt]
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── Parámetros del dataset ───────────────────────────────────────────────────
const BOXES               = ['DS1', 'DS2', 'DS3'];
const NUM_LANES_PER_BOX   = 8;                 // 3×8 = 24 carriles global
// NUM_MANGAS configurable por env var para generar datasets largos de
// resistencia (p.ej. NUM_MANGAS=60 ≈ 5h a 5 min/manga) sin tocar el uso por
// defecto (3 mangas) de los tests de estrés ya existentes.
const NUM_MANGAS          = parseInt(process.env.NUM_MANGAS, 10) || 3;
// Configurable por env var para simular la duración real de manga del evento
// (por defecto 5 min, el usado en los tests de estrés de pico de carga).
const MANGA_DURATION_MIN  = parseInt(process.env.MANGA_DURATION_MIN, 10) || 5;
const MANGA_DURATION_MS   = MANGA_DURATION_MIN * 60000;
const MANGA_GAP_MS        = 15000;             // pausa entre mangas (cambio de manga)
const START_OFFSET_MS     = 5000;              // primer GO no arranca en t=0

// Real DS-300 GO sub-frame timing (idéntico al emulador: trama1→+2500→+2953).
const GO_T2_DELAY_MS = 2500;
const GO_T3_DELAY_MS = 2953;

// Cada caja emite su PROPIA trama GO (a1). SimPlayerService (PitWall) exige
// que las de DS2/DS3 lleguen ANTES que la de DS1 (referencia de "gos"), con
// margen de recorte de ventana de 1500ms — ver GO_LOOKBACK_MS en
// src/services/SimPlayerService.js. Dejamos holgado (300/150ms) muy por
// debajo de ese margen.
const BOX_GO_OFFSET_MS = { DS1: 0, DS2: -300, DS3: -150 };

// Cadencia mínima real entre tramas de una MISMA caja (ver DS300-emulator,
// FRAME_GAP_MS): nunca <160ms.
const FRAME_GAP_MS = 160;

const AVG_LAP_MIN_MS = 9000;
const AVG_LAP_MAX_MS = 12000;
const LAP_JITTER_PCT = 0.15; // ±15%, igual que randomLapMs() del emulador

// ── Construcción de tramas (idéntica al emulador hermano) ───────────────────
const LANE_MASK = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];
const BOX_ID = 0x00; // cada caja es una unidad DS-300 suelta, no un agrupador

// BCD encode: 12 → 0x12, 59 → 0x59
function bcd(n) {
  n = Math.min(99, Math.max(0, Math.round(n)));
  return ((Math.floor(n / 10)) << 4) | (n % 10);
}

// ms → 4 bytes BCD (min, seg, centésimas, diezmilésimas)
function encodeLapTime(ms) {
  const t     = Math.round(ms);
  const mins  = Math.floor(t / 60000);
  const secs  = Math.floor((t % 60000) / 1000);
  const cents = Math.floor((t % 1000) / 10);
  const dmils = (t % 10) * 10;
  return [bcd(mins), bcd(secs), bcd(cents), bcd(dmils)];
}

// Checksum B18 = (B1..B17) mod 256 (B0=0xE0 y B20=0xEB excluidos).
function computeChecksum(b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17) {
  return (b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9 + b10 + b11 + b12 + b13 + b14 + b15 + b16 + b17) & 0xFF;
}

// Contador de trama INDEPENDIENTE por caja (como 3 DS-300 físicos reales).
const boxCounter = { DS1: 0xD0, DS2: 0x10, DS3: 0x50 };
function nextCounter(box) {
  boxCounter[box] = (boxCounter[box] + 1) & 0xFF;
  return boxCounter[box];
}

function buildFrame(box, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17, _b18Ignored, b19, overrideCounter) {
  const cnt = overrideCounter !== undefined ? overrideCounter : nextCounter(box);
  const b18 = computeChecksum(cnt, 0x15, 0x03, BOX_ID, 0x04, 0x4C, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17);
  return [
    0xE0, cnt, 0x15, 0x03, BOX_ID, 0x04, 0x4C,
    b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17, b18, b19,
    0xEB,
  ];
}

function goFrame1(box, durationMins) {
  const hundreds = Math.floor(durationMins / 100);
  const units    = durationMins % 100;
  return buildFrame(box, 0x3E, 0xA1, bcd(hundreds), bcd(units), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function goFrame2(box) {
  return buildFrame(box, 0x00, 0xA2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function goFrame3(box) {
  return buildFrame(box, 0x00, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function firstCrossingFrame(box, lane) {
  const lb = LANE_MASK[lane - 1];
  return buildFrame(box, 0x1B, 0xA9, 0x00, lb, 0x00, 0x01, 0x00, 0xAA, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function lapCrossingFrame(box, lane, lapTimeMs, lapNum) {
  const lb = LANE_MASK[lane - 1];
  const [m, s, c, d] = encodeLapTime(lapTimeMs);
  return buildFrame(box, 0x1B, 0x00, 0x00, lb, 0x00, bcd(lapNum % 100), 0x00, m, s, c, d, 0x00, 0x00, 0x00);
}
function finishFrame(box) {
  return buildFrame(box, 0x00, 0xA4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// ── Simulación temporal ───────────────────────────────────────────────────────
// events[box] = [{ ts (lógico, ms desde epoch del fichero), bytes:[21] }]
const events = { DS1: [], DS2: [], DS3: [] };
const lapCountByGlobalLane = {}; // solo para el resumen final
const OFFSET = { DS1: 0, DS2: 8, DS3: 16 };

let t = START_OFFSET_MS;
const goTimesDs1 = [];

for (let m = 0; m < NUM_MANGAS; m++) {
  const T = t; // referencia: instante del GO (trama1) de DS1 para esta manga
  goTimesDs1.push(T);
  let maxFinish = -Infinity;

  for (const box of BOXES) {
    const goT      = T + BOX_GO_OFFSET_MS[box];
    const a2T      = goT + GO_T2_DELAY_MS;
    const a3T      = goT + GO_T3_DELAY_MS;
    const finishT  = a3T + MANGA_DURATION_MS;

    events[box].push({ ts: goT, bytes: goFrame1(box, MANGA_DURATION_MIN) });
    events[box].push({ ts: a2T, bytes: goFrame2(box) });
    events[box].push({ ts: a3T, bytes: goFrame3(box) });

    for (let lane = 1; lane <= NUM_LANES_PER_BOX; lane++) {
      const globalLane = lane + OFFSET[box];
      const avgMs = AVG_LAP_MIN_MS + Math.random() * (AVG_LAP_MAX_MS - AVG_LAP_MIN_MS);

      // Arranque real: todos los coches salen a la vez y cruzan la línea casi
      // juntos (ventana ~0-300ms), igual que el emulador.
      let lastTs = a3T + 30 + Math.round(Math.random() * 270);
      events[box].push({ ts: lastTs, bytes: firstCrossingFrame(box, lane) });
      let lapNum = 1;

      for (;;) {
        const variation = avgMs * LAP_JITTER_PCT;
        const lapMs = Math.round(avgMs + (Math.random() * 2 - 1) * variation);
        const nextTs = lastTs + lapMs;
        if (nextTs > finishT - 200) break; // no crucemos justo encima de la bandera
        lapNum++;
        events[box].push({ ts: nextTs, bytes: lapCrossingFrame(box, lane, lapMs, lapNum) });
        lastTs = nextTs;
      }

      lapCountByGlobalLane[globalLane] = lapNum; // vueltas totales (incl. 1er cruce) en la ÚLTIMA manga procesada; se acumula abajo
      lapCountByGlobalLane[`m${m}_${globalLane}`] = lapNum;
    }

    events[box].push({ ts: finishT, bytes: finishFrame(box) });
    if (finishT > maxFinish) maxFinish = finishT;
  }

  t = maxFinish + MANGA_GAP_MS;
}

const fileDurationMs = t - MANGA_GAP_MS; // última bandera; no contamos el hueco final sin usar

// ── Cadencia mínima real (~160ms) entre tramas de la MISMA caja ─────────────
// Igual que el emulador (drainQueue a FRAME_GAP_MS): si dos tramas lógicas de
// la misma caja caen a <160ms, la segunda se retrasa hasta cumplir el hueco.
// El tiempo de vuelta codificado en BCD (bytes 14-17) usa el instante LÓGICO
// del cruce (real, sin el retraso de serialización) — así el tiempo de vuelta
// es exacto y el fichero de salida solo refleja cuándo salió la trama por el
// cable, que es lo que trae un registro real.
const lines = [];
for (const box of BOXES) {
  events[box].sort((a, b) => a.ts - b.ts);
  let prevActual = -Infinity;
  for (const ev of events[box]) {
    const actual = Math.max(ev.ts, prevActual + FRAME_GAP_MS);
    prevActual = actual;
    lines.push({ ts: actual, box, bytes: ev.bytes });
  }
}
lines.sort((a, b) => a.ts - b.ts);

function fmtTs(ms) {
  const totalMs = Math.round(ms) % 86400000;
  const hh = Math.floor(totalMs / 3600000);
  const mm = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const mmm = totalMs % 1000;
  const p2 = n => String(n).padStart(2, '0');
  const p3 = n => String(n).padStart(3, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}.${p3(mmm)}`;
}

const out = lines.map(l =>
  `${fmtTs(l.ts)}\t${l.box}\t${l.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`
).join('\n') + '\n';

const outPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'database', 'sim', 'stress-24lanes.txt'));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out, 'utf8');

// ── Resumen ──────────────────────────────────────────────────────────────────
const totalLapsPerLane = {};
for (let box of BOXES) {
  for (let lane = 1; lane <= NUM_LANES_PER_BOX; lane++) {
    const globalLane = lane + OFFSET[box];
    let sum = 0;
    for (let m = 0; m < NUM_MANGAS; m++) sum += (lapCountByGlobalLane[`m${m}_${globalLane}`] || 0);
    totalLapsPerLane[globalLane] = sum;
  }
}
const laneNums = Object.keys(totalLapsPerLane).map(Number).sort((a, b) => a - b);
const minLaps = Math.min(...laneNums.map(l => totalLapsPerLane[l]));
const maxLaps = Math.max(...laneNums.map(l => totalLapsPerLane[l]));

console.log(`Fichero generado: ${outPath}`);
console.log(`Tramas totales: ${lines.length}`);
console.log(`Mangas: ${NUM_MANGAS} × ${MANGA_DURATION_MIN} min`);
console.log(`Carriles: ${laneNums.length} (${BOXES.map(b => `${b}=1..${NUM_LANES_PER_BOX}`).join(', ')})`);
console.log(`Vueltas por carril (${NUM_MANGAS} mangas, incl. 1er cruce): min=${minLaps} max=${maxLaps}`);
console.log(`Duración real del fichero (última bandera, ×1): ${(fileDurationMs / 60000).toFixed(2)} min (${fileDurationMs} ms)`);
console.log(`Instante del último byte escrito: ${fmtTs(lines[lines.length - 1].ts)}`);
