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
// Decodificador de PRESENTACIÓN para el visor de tramas en vivo (/diagnostico/tramas).
// NO se usa para cronometrar: solo traduce una trama cruda a una etiqueta legible.
// El cronometraje real lo hace SerialService (DS-300) / BartConnection (BART).
//
// Réplica deliberada del orden de ramas de SerialService._processFrame: si aquí
// clasificáramos por `b[8]` a secas, las tramas 0xA2/0xA3 sin GO/resume pendiente
// se etiquetarían como eventos cuando el parser real las ignora. Por eso el
// decodificador lleva su propio latch (`pendingGo` / `pendingResume`).
//
// API:
//   const dec = createDecoder();            // guarda el latch entre tramas
//   dec.ds(bytes, { boxesPerPort, laneOffset })  → Frame
//   dec.reset()
// Frame = { kind, label, badge, fields: [{k, v}], lanes: [n], unknown: [i] }

const DS_FRAME_LEN = 21;
const MIN_CROSSING_MS = 500;
const MAX_LAP_MS = 240000;

// bitmask → carril local. Array de pares: un byte puede llevar VARIOS bits
// activos y entonces la trama reporta varios cruces a la vez.
const LANE_BITS = [[0x80, 1], [0x40, 2], [0x20, 3], [0x10, 4],
                   [0x08, 5], [0x04, 6], [0x02, 7], [0x01, 8]];

// Decimal-en-hex (BCD): 0x57 → 57. null si algún nibble > 9.
const bcd = b => (((b >> 4) <= 9 && (b & 0xF) <= 9) ? parseInt(b.toString(16), 10) : null);

const hex = b => b.toString(16).padStart(2, '0');

// Bytes que el parser real llega a leer en una trama de cruce. Todo lo demás se
// muestra como "sin interpretar" — son 10 de 21, casi media trama.
const DS_READ_BYTES = new Set([0, 4, 7, 8, 10, 12, 14, 15, 16, 17, 20]);

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(3)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

// Tiempo de vuelta: bytes 14-17 en decimal-en-hex.
//   14 = minutos · 15 = segundos · 16 = centésimas · 17 = diezmilésimas
// Si cualquiera trae un nibble A-F → null = primer cruce de la manga.
function readLapTimeMs(b) {
  if (b.length < 18) return null;
  const m = bcd(b[14]), s = bcd(b[15]), c = bcd(b[16]), d = bcd(b[17]);
  if (m == null || s == null || c == null || d == null) return null;
  return m * 60000 + s * 1000 + c * 10 + d * 0.1;
}

function unknownBytes(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) if (!DS_READ_BYTES.has(i)) out.push(i);
  return out;
}

function createDecoder() {
  let pendingGo = false;
  let pendingResume = false;

  // Decodifica UNA trama DS-300 ya ensamblada.
  // opts.boxesPerPort > 1 ⇒ modo agrupador: b[4] es el id de caja (1..4).
  function ds(bytes, opts = {}) {
    const b = Array.from(bytes);
    const boxes = opts.boxesPerPort || 1;
    const laneOffset = opts.laneOffset || 0;
    const base = { hex: b.map(hex).join(' '), len: b.length, lanes: [], fields: [], unknown: [] };

    if (b.length < 2) {
      return { ...base, kind: 'short', badge: '?', label: 'Trama corta (descartada)' };
    }

    // Ráfaga de retransmisión del PL2303: N sub-tramas de 21 bytes pegadas.
    if (b.length > DS_FRAME_LEN && b.length % DS_FRAME_LEN === 0) {
      const n = b.length / DS_FRAME_LEN;
      let wellFormed = true;
      for (let i = 0; i < n; i++) {
        if (b[i * DS_FRAME_LEN] !== 0xe0 || b[i * DS_FRAME_LEN + 20] !== 0xeb) { wellFormed = false; break; }
      }
      if (wellFormed) {
        const subs = [];
        let collapsed = 0;
        for (let i = 0; i < n; i++) {
          const sub = b.slice(i * DS_FRAME_LEN, (i + 1) * DS_FRAME_LEN);
          const prev = i > 0 ? b.slice((i - 1) * DS_FRAME_LEN, i * DS_FRAME_LEN) : null;
          if (prev && sub.every((x, j) => x === prev[j])) { collapsed++; continue; }
          subs.push(ds(sub, opts));
        }
        return {
          ...base,
          kind: 'burst',
          badge: '⊘',
          label: `Ráfaga ×${n} — ${collapsed} duplicada${collapsed === 1 ? '' : 's'} descartada${collapsed === 1 ? '' : 's'}`,
          fields: [{ k: 'sub-tramas', v: String(n) }, { k: 'descartadas', v: String(collapsed) }],
          subs,
        };
      }
    }

    const b7 = b[7], b8 = b[8];
    const laneByte = b.length >= 11 ? b[10] : 0;
    const unknown = unknownBytes(b);

    // — Heartbeat: b[7]=0x00 b[8]=0xC0. El minuto es el byte CRUDO, no BCD.
    if (b.length >= 15 && b7 === 0x00 && b8 === 0xC0) {
      return { ...base, unknown, kind: 'heartbeat', badge: '♥',
               label: 'Latido', fields: [{ k: 'minuto', v: String(b[14]) }] };
    }

    // — GO (trama 1): b[7]=0x3E b[8]=0xA1. b[10] = minutos de manga en BCD.
    if (b.length >= 11 && b7 === 0x3E && b8 === 0xA1) {
      pendingGo = true;
      pendingResume = false;
      const mins = bcd(b[10]);
      return { ...base, unknown, kind: 'go', badge: '▶',
               label: 'GO — arranque de manga',
               fields: [{ k: 'duración', v: mins == null ? '—' : `${mins} min` }] };
    }

    // — Verde (trama 3): b[8]=0xA3. Solo significa algo si hay latch pendiente.
    if (b.length >= 9 && b7 === 0x00 && b8 === 0xA3) {
      if (pendingGo)     { pendingGo = false;     return { ...base, unknown, kind: 'started', badge: '🟢', label: 'Verde — carrera en marcha' }; }
      if (pendingResume) { pendingResume = false; return { ...base, unknown, kind: 'resumed', badge: '🟢', label: 'Verde — carrera reanudada' }; }
      return { ...base, unknown, kind: 'ignored', badge: '·', label: 'Verde sin GO pendiente (el parser la ignora)' };
    }

    // — Paso intermedio del semáforo: b[8]=0xA2, solo con latch pendiente.
    if (b.length >= 9 && b7 === 0x00 && b8 === 0xA2 && (pendingGo || pendingResume)) {
      return { ...base, unknown, kind: 'semaphore', badge: '🟡', label: 'Semáforo — paso intermedio' };
    }

    // — Tramas de control (sin carril).
    if (laneByte === 0) {
      switch (b8) {
        case 0xA7: return { ...base, unknown, kind: 'stopped',  badge: '⏹', label: 'Stop forzado' };
        case 0xA4: return { ...base, unknown, kind: 'finished', badge: '🏁', label: 'Fin de manga' };
        case 0xA5: return { ...base, unknown, kind: 'paused',   badge: '⏸', label: 'Pausa' };
        case 0xA6:
          pendingResume = true;
          return { ...base, unknown, kind: 'resume_signal', badge: '⏵', label: 'Señal de reanudación' };
        default:
          return { ...base, unknown, kind: 'ignored', badge: '·',
                   label: `Control desconocido (b8=0x${hex(b8 ?? 0)})` };
      }
    }

    // — Cruce truncado.
    if (b.length < 18) {
      return { ...base, unknown, kind: 'truncated', badge: '✂', label: 'Cruce truncado (descartado)' };
    }

    // — Cruce de carril. Se identifica por b[10]!=0 y len>=18, NO por b[7].
    const lapMs = readLapTimeMs(b);
    const boxOffset = boxes > 1 ? Math.min(Math.max((b[4] || 1) - 1, 0), boxes - 1) * 8 : 0;
    const lanes = [];
    for (const [bit, local] of LANE_BITS) {
      if (laneByte & bit) lanes.push({ local, global: boxOffset + local + laneOffset });
    }

    const fields = [];
    if (boxes > 1) fields.push({ k: 'caja', v: String(b[4]) });
    fields.push({ k: 'carril', v: lanes.map(l => l.global === l.local ? `${l.local}` : `${l.local}→${l.global}`).join(', ') });
    fields.push({ k: 'tiempo', v: lapMs == null ? 'primera vuelta' : fmtMs(lapMs) });
    const counter = bcd(b[12]);
    if (counter != null) fields.push({ k: 'contador', v: String(counter) });

    // El parser descarta en silencio los tiempos fuera de rango: hay que
    // marcarlo o en pantalla queda un hueco inexplicable entre trama y evento.
    const filtered = lapMs != null && (lapMs < MIN_CROSSING_MS || lapMs > MAX_LAP_MS);

    return {
      ...base,
      unknown,
      kind: filtered ? 'crossing_filtered' : 'crossing',
      badge: filtered ? '⊗' : '⏱',
      label: filtered
        ? `Cruce filtrado — fuera de rango (${fmtMs(lapMs)})`
        : `Cruce — carril ${lanes.map(l => l.global).join(', ')}`,
      lanes: lanes.map(l => l.global),
      fields,
    };
  }

  // Decodifica UNA trama BART (A5 …) ya validada por CRC en FrameParser.
  // A diferencia del DS-300 aquí no hay latch: el tipo va explícito en b[1].
  function bart(bytes, opts = {}) {
    const b = Array.from(bytes);
    const laneOffset = opts.laneOffset || 0;
    const base = { hex: b.map(hex).join(' '), len: b.length, lanes: [], fields: [], unknown: [] };
    const u16 = i => b[i] | (b[i + 1] << 8);

    if (b.length < 3) return { ...base, kind: 'short', badge: '?', label: 'Trama corta' };

    switch (b[1]) {
      // — LAP (cruce), 14 bytes.
      case 0x01: {
        // El carril viene empaquetado: nibble alto = dispositivo, bajo = carril.
        const raw = b[3];
        const local = (raw >> 4) * 4 + (raw & 0x0F);
        const global = local + laneOffset;
        const laps = u16(4);
        const rawMs = u16(6);
        const lapMs = rawMs === 0xFFFF ? null : rawMs;   // 0xFFFF = desborde
        const fields = [
          { k: 'carril',  v: local === global ? `${local}` : `${local}→${global}` },
          { k: 'tiempo',  v: lapMs == null ? 'sin tiempo (desborde)' : fmtMs(lapMs) },
          { k: 'vueltas', v: String(laps) },
          { k: 'seq',     v: String(b[12]) },
        ];
        const filtered = lapMs != null && (lapMs < MIN_CROSSING_MS || lapMs > MAX_LAP_MS);
        return {
          ...base,
          unknown: [8, 9, 10, 11],                       // ts_d10 y reservados: PitWall los ignora
          kind: filtered ? 'crossing_filtered' : 'crossing',
          badge: filtered ? '⊗' : '⏱',
          label: filtered
            ? `Cruce filtrado — ${lapMs < MIN_CROSSING_MS ? 'rebote' : 'coche parado'} (${fmtMs(lapMs)})`
            : `Cruce — carril ${global}`,
          lanes: [global],
          fields,
        };
      }

      // — STATUS, 12 bytes. PitWall solo usa b[3]; el resto se muestra igual.
      case 0x20: {
        const names = { 0: 'libre', 1: 'en marcha', 2: 'pausa', 3: 'parado' };
        const state = names[b[3]] || `desconocido (${b[3]})`;
        return {
          ...base,
          unknown: [9, 10],
          kind: b[3] === 1 ? 'started' : b[3] === 2 ? 'paused' : b[3] === 3 ? 'stopped' : 'status',
          badge: '≡',
          label: `Estado — ${state}`,
          fields: [
            { k: 'min-lap',  v: `${u16(4)} ms` },
            { k: 'uptime',   v: `${(u16(6) / 10).toFixed(1)} s` },
            { k: 'carriles', v: String(b[8]) },
          ],
        };
      }

      // — ACK, 5 bytes.
      case 0x7F: {
        const ops = { 0x01: 'START', 0x02: 'STOP', 0x03: 'PAUSA', 0x04: 'CLEAR',
                      0x10: 'SET_MINLAP', 0x20: 'READ_STAT', 0x30: 'NOTIFY',
                      0x40: 'SET_MODE', 0x41: 'SET_ID', 0x42: 'SET_LABEL',
                      0x43: 'SET_MASTER', 0x50: 'READ_CONFIG' };
        const res = { 0: 'OK', 1: 'CRC', 2: 'longitud', 3: 'op desconocido', 4: 'ocupado', 5: 'denegado' };
        return {
          ...base, kind: b[3] === 0 ? 'ack' : 'ack_error',
          badge: b[3] === 0 ? '✓' : '✗',
          label: `ACK ${ops[b[2]] || `0x${hex(b[2])}`} → ${res[b[3]] ?? b[3]}`,
        };
      }

      // — CMD: son los comandos que PitWall ENVÍA. Solo aparecen si algo los
      //   refleja en el bus; el parser de entrada ni siquiera sabe encuadrarlos.
      case 0x90: {
        const ops = { 0x01: 'GO / START', 0x02: 'STOP', 0x03: 'PAUSA', 0x04: 'CLEAR' };
        let label = ops[b[2]];
        if (b[2] === 0x10) label = `MIN-LAP = ${u16(3)} ms`;
        if (b[2] === 0x30) label = `NOTIFICACIONES ${b[3] ? 'ON' : 'OFF'}`;
        return { ...base, kind: 'cmd', badge: '↑',
                 label: `Comando — ${label || `0x${hex(b[2])}`}` };
      }

      case 0x30:
        return { ...base, kind: 'ignored', badge: '·',
                 label: 'Fanout Master→Slaves (el cliente no la encuadra)' };

      default:
        return { ...base, kind: 'ignored', badge: '·',
                 label: `Tipo desconocido 0x${hex(b[1])} — resincroniza` };
    }
  }

  return {
    ds,
    bart,
    reset() { pendingGo = false; pendingResume = false; },
  };
}

module.exports = { createDecoder, readLapTimeMs, bcd, fmtMs, LANE_BITS, DS_FRAME_LEN };
