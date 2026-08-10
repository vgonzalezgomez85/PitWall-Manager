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
//
// Formateador humano (es/en) de sucesos de carrera. Compartido por el panel
// en vivo (live.js) y la página de histórico (events.ejs) para no duplicar
// la redacción de cada tipo dos veces. La BD solo guarda hechos estructurados
// (type + payload) — el texto se construye siempre aquí, en cliente.
(function (global) {
  function fmtS(ms) { return (Number(ms) / 1000).toFixed(3); }
  function fmtSecShort(ms) { return Math.round(Number(ms) / 1000); }

  const ICON = {
    go: '🚦', pause: '⏸', resume: '▶', stop: '🏁', cancel: '✕',
    recovered: '🔌', ghost_lap: '👻', lap_reassigned: '🔁', retro_exit: '↩️',
    driver_checkin: '🪪', lap_assigned: '✅',
  };
  const COLOR = {
    go: '#3fb950', pause: '#e6a817', resume: '#3fb950', stop: '#8b949e',
    cancel: '#e63946', recovered: '#a855f7', ghost_lap: '#8b949e',
    lap_reassigned: '#3fb950', retro_exit: '#e6a817', driver_checkin: '#a855f7',
    lap_assigned: '#58a6ff',
  };

  const MODE_TEXT = {
    pre_arm:            { es: 'fichaje', en: 'checked in' },
    swap_running:       { es: 'cambio en caliente', en: 'hot swap' },
    swap_paused:        { es: 'cambio (en pausa)', en: 'swap (paused)' },
    manual_correction:  { es: 'corrección manual', en: 'manual correction' },
  };

  function who(d, es) {
    if (!d.lane) return '';
    return `${es ? 'Carril' : 'Lane'} ${d.lane}` + (d.entityName ? ` (${d.entityName})` : '');
  }
  function circuitSuffix(d, es, mc) {
    return (mc && d.circuit != null) ? ` — ${es ? 'Circuito' : 'Circuit'} ${d.circuit + 1}` : '';
  }

  const TEXT = {
    go:     (d, es, mc) => 'GO' + circuitSuffix(d, es, mc),
    pause:  (d, es, mc) => (es ? 'Pausa' : 'Paused') + circuitSuffix(d, es, mc),
    resume: (d, es, mc) => {
      const base = (es ? 'Reanudado' : 'Resumed') + circuitSuffix(d, es, mc);
      const pausedMs = (d.payload || {}).pausedMs;
      if (!pausedMs) return base;
      return base + (es ? ` (tras ${fmtSecShort(pausedMs)}s de pausa)` : ` (after ${fmtSecShort(pausedMs)}s paused)`);
    },
    stop:   (d, es) => (es ? 'Fin de manga' : 'Heat finished') + (d.mangaNumber ? ' ' + d.mangaNumber : ''),
    cancel: (d, es) => (es ? 'Manga cancelada' : 'Heat cancelled') + (d.mangaNumber ? ' ' + d.mangaNumber : ''),
    recovered: (d, es) => {
      const outageMs = (d.payload || {}).outageMs || 0;
      return (es ? 'Manga recuperada tras corte de ' : 'Heat recovered after a ') + fmtSecShort(outageMs) + 's';
    },
    ghost_lap: (d, es) => {
      const p = d.payload || {};
      const w = who(d, es);
      return `${w}${w ? ' — ' : ''}${es ? 'vuelta ignorada' : 'lap ignored'}: ${fmtS(p.lapTimeMs)}s < ${es ? 'mínimo' : 'min'} ${fmtS(p.ptMs)}s`;
    },
    lap_reassigned: (d, es) => {
      const p = d.payload || {};
      const base = es
        ? `Vuelta fantasma del carril ${p.fromLane} reasignada al carril ${p.toLane}`
        : `Ghost lap from lane ${p.fromLane} reassigned to lane ${p.toLane}`;
      return base + (d.entityName ? ` (${d.entityName})` : '') + ` — ${fmtS(p.lapTimeMs)}s`;
    },
    retro_exit: (d, es) => {
      const p = d.payload || {};
      const kind = p.isPitStop ? 'pit-stop' : (es ? 'salida' : 'off-track');
      return `${who(d, es)} — ${es ? '1ª vuelta reclasificada como' : '1st lap reclassified as'} ${kind} (${fmtS(p.lapTimeMs)}s)`;
    },
    driver_checkin: (d, es) => {
      const p = d.payload || {};
      const modeTxt = (MODE_TEXT[p.mode] && MODE_TEXT[p.mode][es ? 'es' : 'en']) || p.mode || '';
      return `${es ? 'Carril' : 'Lane'} ${d.lane} — ${d.entityName || ''} (${modeTxt})`;
    },
    lap_assigned: (d, es) => {
      return `${who(d, es)} — ${es ? 'vuelta' : 'lap'} ${d.lapNumber || ''}: ${fmtS(d.lapTimeMs)}s`;
    },
  };

  // `evt`: { type, circuit, lane, entityName, mangaNumber, payload, ... }
  // `opts`: { lang: 'es'|'en', multiCircuit: bool }
  function formatRaceEvent(evt, opts) {
    opts = opts || {};
    const es = opts.lang !== 'en';
    const mc = !!opts.multiCircuit;
    const fn = TEXT[evt.type];
    return {
      icon:  ICON[evt.type] || '•',
      color: COLOR[evt.type] || '#8b949e',
      text:  fn ? fn(evt, es, mc) : evt.type,
    };
  }

  global.formatRaceEvent = formatRaceEvent;
})(window);
