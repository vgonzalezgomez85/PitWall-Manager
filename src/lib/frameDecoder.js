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
//   dec.ds(bytes, { boxesPerPort, laneOffset, model })  → Frame
//   dec.reset()
// Frame = { kind, label, badge, fields: [{k, v}], lanes: [n], unknown: [i] }

const { checksumOk, LANE_BITS } = require('./dsModels');
const { decodeFrame, bcd, lapTimeMs: readLapTimeMs, DS_FRAME_LEN } = require('./dsProtocol');
const tictac = require('./tictacProtocol');

const MIN_CROSSING_MS = 500;
const MAX_LAP_MS = 240000;

// Decimal-en-hex (BCD): 0x57 → 57. null si algún nibble > 9.

const hex = b => b.toString(16).padStart(2, '0');

// Bytes que el parser real llega a leer en una trama de cruce. Todo lo demás se
// muestra como "sin interpretar" — son 9 de 21.
const DS_READ_BYTES = new Set([0, 4, 7, 8, 10, 12, 14, 15, 16, 17, 18, 20]);

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(3)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h} h ` : '') + `${m} min` + (r ? ` ${r} s` : '');
}

function unknownBytes(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) if (!DS_READ_BYTES.has(i)) out.push(i);
  return out;
}

// ── Traducción en el navegador ─────────────────────────────────────────────
// Las etiquetas se escriben en español (los tests las comprueban así), pero el
// visor lo puede mirar alguien con la app en inglés o italiano, y el decodificador
// corre en el servidor para todos a la vez. Se adjunta a cada etiqueta y campo su
// clave del diccionario (`client.tramas.*`) y sus variables; diagnostico-tramas.js
// la traduce con I18N.t y, si no hay clave, muestra el español.
const ETIQUETAS = [
  [/^Trama corta \(descartada\)$/, 'trama_corta_descartada'],
  [/^Trama corta$/, 'trama_corta'],
  [/^Bytes sin trama \((\d+), descartados\)$/, 'sin_trama', m => ({ n: m[1] })],
  [/^Retransmisión \(descartada\)$/, 'retransmision'],
  [/^Latido$/, 'latido'],
  [/^GO — arranque de manga$/, 'go'],
  [/^Verde — carrera en marcha$/, 'verde_marcha'],
  [/^Verde — carrera reanudada$/, 'verde_reanudada'],
  [/^Verde sin aviso previo — arranca o reanuda$/, 'verde_sin_aviso'],
  [/^Checksum incorrecto \(descartada\)$/, 'checksum_mal'],
  [/^Semáforo — paso intermedio$/, 'semaforo'],
  [/^Stop forzado$/, 'stop'],
  [/^Fin de manga$/, 'fin'],
  [/^Pausa$/, 'pausa'],
  [/^Señal de reanudación$/, 'senal_reanudacion'],
  [/^Control desconocido \((.+)\)$/, 'control_desconocido', m => ({ x: m[1] })],
  [/^Cruce filtrado — fuera de rango \((.+)\)$/, 'cruce_fuera_rango', m => ({ t: m[1] })],
  [/^Cruce filtrado — rebote \((.+)\)$/, 'cruce_rebote', m => ({ t: m[1] })],
  [/^Cruce filtrado — coche parado \((.+)\)$/, 'cruce_parado', m => ({ t: m[1] })],
  [/^Cruce — carril (.+)$/, 'cruce', m => ({ l: m[1] })],
  [/^Estado — (libre|en marcha|pausa|parado)$/, 'estado', m => ({ s: m[1] })],
  [/^Comando — (.+)$/, 'comando', m => ({ c: m[1] })],
  [/^Fanout Master→Slaves \(el cliente no la encuadra\)$/, 'fanout'],
  [/^Tipo desconocido (0x\w+) — resincroniza$/, 'tipo_desconocido_resinc', m => ({ x: m[1] })],
  [/^Trama sin sincronismo o incompleta$/, 'sin_sincronismo'],
  [/^Evento (\S+) \((0x\w+)\) — PitWall lo ignora: el interface no manda la carrera$/, 'evento_tictac', m => ({ n: m[1], x: m[2] })],
  [/^Tipo desconocido (0x\w+)$/, 'tipo_desconocido', m => ({ x: m[1] })],
  [/^Carril (\d+) fuera de rango \(descartada\)$/, 'carril_fuera', m => ({ l: m[1] })],
];
const ESTADOS = { 'libre': 'estado_libre', 'en marcha': 'estado_en_marcha', 'pausa': 'estado_pausa', 'parado': 'estado_parado' };
const CAMPOS = { 'minuto': 'f_minuto', 'duración': 'f_duracion', 'caja': 'f_caja', 'carril': 'f_carril', 'tiempo': 'f_tiempo', 'contador': 'f_contador', 'vueltas': 'f_vueltas',
  'carriles': 'f_carriles', 'vuelta': 'f_vuelta', 'reloj': 'f_reloj' };
const VALORES = { 'primera vuelta': 'v_primera_vuelta', 'sin tiempo (desborde)': 'v_sin_tiempo' };

function traducible(f) {
  if (!f || typeof f !== 'object') return f;
  if (typeof f.label === 'string') {
    for (const [re, clave, vars] of ETIQUETAS) {
      const m = f.label.match(re);
      if (!m) continue;
      f.labelKey = 'client.tramas.' + clave;
      f.labelVars = vars ? vars(m) : {};
      if (clave === 'estado') f.labelVars.sKey = 'client.tramas.' + ESTADOS[m[1]];
      break;
    }
  }
  if (Array.isArray(f.fields)) {
    for (const fld of f.fields) {
      if (CAMPOS[fld.k]) fld.kKey = 'client.tramas.' + CAMPOS[fld.k];
      if (VALORES[fld.v]) fld.vKey = 'client.tramas.' + VALORES[fld.v];
    }
  }
  return f;
}

function createDecoder() {
  let pendingGo = false;
  let pendingResume = false;
  // Interface TicTac: el tiempo de vuelta sale del reloj del cruce anterior del
  // mismo carril, así que el decodificador lleva la última lectura por carril.
  const tictacClock = new Map();

  // Decodifica lo que le pasa SerialService: una trama completa (21 bytes, con el
  // checksum bien) o los bytes que el lector común descartó. Qué significa cada
  // trama lo dice dsProtocol.decodeFrame, el mismo que usa el cronometraje; aquí
  // solo se le pone nombre. El latch del GO solo distingue etiquetas.
  //   opts.boxesPerPort > 1 ⇒ modo agrupador: b[4] es el id de caja (1..4).
  //   opts.retransmission   ⇒ copia de la trama anterior, descartada.
  function ds(bytes, opts = {}) {
    const b = Array.from(bytes);
    const boxes = opts.boxesPerPort || 1;
    const laneOffset = opts.laneOffset || 0;
    const base = { hex: b.map(hex).join(' '), len: b.length, lanes: [], fields: [], unknown: [] };

    if (b.length < 2) {
      return { ...base, kind: 'short', badge: '?', label: 'Trama corta (descartada)' };
    }
    const completa = b.length === DS_FRAME_LEN && b[0] === 0xe0 && b[20] === 0xeb;
    if (completa && !checksumOk(b)) {
      return { ...base, unknown: unknownBytes(b), kind: 'bad_checksum', badge: '✗', label: 'Checksum incorrecto (descartada)' };
    }
    if (!completa) {
      return { ...base, kind: 'resync', badge: '⊘', label: `Bytes sin trama (${b.length}, descartados)` };
    }
    if (opts.retransmission) {
      return { ...base, unknown: unknownBytes(b), kind: 'duplicate', badge: '⊘', label: 'Retransmisión (descartada)' };
    }

    const unknown = unknownBytes(b);
    const d = decodeFrame(opts.model, b);

    switch (d.type) {
      case 'heartbeat':
        return { ...base, unknown, kind: 'heartbeat', badge: '♥',
                 label: 'Latido', fields: [{ k: 'minuto', v: String(d.minute) }] };
      case 'go':
        pendingGo = true;
        pendingResume = false;
        return { ...base, unknown, kind: 'go', badge: '▶',
                 label: 'GO — arranque de manga',
                 fields: [{ k: 'duración', v: d.durationMs == null ? '—' : fmtDur(d.durationMs) }] };
      case 'green':
        if (pendingGo)     { pendingGo = false;     return { ...base, unknown, kind: 'started', badge: '🟢', label: 'Verde — carrera en marcha' }; }
        if (pendingResume) { pendingResume = false; return { ...base, unknown, kind: 'resumed', badge: '🟢', label: 'Verde — carrera reanudada' }; }
        return { ...base, unknown, kind: 'started', badge: '🟢', label: 'Verde sin aviso previo — arranca o reanuda' };
      case 'semaphore':
        if (pendingGo || pendingResume) return { ...base, unknown, kind: 'semaphore', badge: '🟡', label: 'Semáforo — paso intermedio' };
        return { ...base, unknown, kind: 'ignored', badge: '·', label: `Control desconocido (b8=0x${hex(b[8])})` };
      case 'stop':   return { ...base, unknown, kind: 'stopped',  badge: '⏹', label: 'Stop forzado' };
      case 'finish': return { ...base, unknown, kind: 'finished', badge: '🏁', label: 'Fin de manga' };
      case 'pause':  return { ...base, unknown, kind: 'paused',   badge: '⏸', label: 'Pausa' };
      case 'resume_signal':
        pendingResume = true;
        return { ...base, unknown, kind: 'resume_signal', badge: '⏵', label: 'Señal de reanudación' };
      case 'event':
        return { ...base, unknown, kind: 'ignored', badge: '·', label: `Control desconocido (b8=0x${hex(b[8])})` };
    }

    // — Cruce de carril (b[7] = 0x1B).
    const lapMs = d.lapMs;
    const boxOffset = boxes > 1 ? Math.min(Math.max((b[4] || 1) - 1, 0), boxes - 1) * 8 : 0;
    const lanes = d.lanes.map(local => ({ local, global: boxOffset + local + laneOffset }));

    const fields = [];
    if (boxes > 1) fields.push({ k: 'caja', v: String(b[4]) });
    fields.push({ k: 'carril', v: lanes.map(l => l.global === l.local ? `${l.local}` : `${l.local}→${l.global}`).join(', ') });
    fields.push({ k: 'tiempo', v: lapMs == null ? 'primera vuelta' : fmtMs(lapMs) });
    if (d.counter != null) fields.push({ k: 'contador', v: String(d.counter) });

    // El parser descarta en silencio los rebotes: hay que marcarlo o en pantalla
    // queda un hueco inexplicable entre trama y evento.
    const filtered = lapMs != null && lapMs < MIN_CROSSING_MS;

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

  // Decodifica UNA trama del interface TicTac (16 bytes, 0xC0 …). Replica el
  // criterio de TicTacConnection: primer cruce / manga nueva sin tiempo, y un
  // rebote no mueve la referencia.
  function tictacFrame(bytes, opts = {}) {
    const b = Buffer.from(bytes);
    const laneOffset = opts.laneOffset || 0;
    const base = { hex: Array.from(b).map(hex).join(' '), len: b.length, lanes: [], fields: [], unknown: [] };
    const d = tictac.decodificar(b);
    if (!d) return { ...base, kind: 'ignored', badge: '·', label: 'Trama sin sincronismo o incompleta' };

    if (d.tipo === 'evento') {
      return { ...base, unknown: [1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], kind: 'ignored', badge: '·',
               label: `Evento ${d.nombre} (0x${hex(d.codigo)}) — PitWall lo ignora: el interface no manda la carrera` };
    }
    if (d.tipo !== 'cruce') {
      return { ...base, kind: 'ignored', badge: '·', label: `Tipo desconocido 0x${hex(b[2])}` };
    }

    const unknown = [1, 3, 12, 13, 14, 15];
    if (d.lane < 1 || d.lane > 8) {
      return { ...base, unknown, kind: 'ignored', badge: '·', label: `Carril ${d.lane} fuera de rango (descartada)` };
    }
    const global = d.lane + laneOffset;
    const prev = tictacClock.get(d.lane);
    let lapMs = null;
    if (prev != null) {
      const dt = tictac.deltaReloj(prev, d.clockMs);
      if (dt <= MAX_LAP_MS) lapMs = dt;
    }
    const rebote = lapMs != null && lapMs < MIN_CROSSING_MS;
    if (!rebote) tictacClock.set(d.lane, d.clockMs);

    return {
      ...base,
      unknown,
      kind: rebote ? 'crossing_filtered' : 'crossing',
      badge: rebote ? '⊗' : '⏱',
      label: rebote ? `Cruce filtrado — rebote (${fmtMs(lapMs)})` : `Cruce — carril ${global}`,
      lanes: [global],
      fields: [
        { k: 'carril',  v: d.lane === global ? `${d.lane}` : `${d.lane}→${global}` },
        { k: 'tiempo',  v: lapMs == null ? 'primera vuelta' : fmtMs(lapMs) },
        { k: 'vuelta',  v: String(d.lap) },
        { k: 'reloj',   v: fmtMs(d.clockMs) },
      ],
    };
  }

  return {
    ds:     (bytes, opts) => traducible(ds(bytes, opts)),
    bart:   (bytes, opts) => traducible(bart(bytes, opts)),
    tictac: (bytes, opts) => traducible(tictacFrame(bytes, opts)),
    reset() { pendingGo = false; pendingResume = false; tictacClock.clear(); },
  };
}

module.exports = { createDecoder, readLapTimeMs, bcd, fmtMs, LANE_BITS, DS_FRAME_LEN };
