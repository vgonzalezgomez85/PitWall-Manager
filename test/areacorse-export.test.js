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
// Export para la plataforma italiana Area Corse (area-corse.it):
//   línea 1 obligatoria `sep=;`, línea 2 la cabecera, y los campos separados
//   por `;`: pilota_id;giri;settori;miglior_tempo;posizione (+ `nome` al final).
// `settori` = la coma de la ÚLTIMA manga en la escala de la pista (100 por
// defecto): su clasificación normaliza con giri + settori/settori_pista.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();
process.env.PITWALL_NO_WORKER = '1';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const Lap = require('../src/models/Lap');
const Team = require('../src/models/Team');
const SessionController = require('../src/controllers/SessionController');

after(() => limpiarBdTemporal());

beforeEach(() => {
  for (const t of ['laps', 'manga_lanes', 'mangas', 'drivers', 'teams', 'tandas', 'races',
                   'teams_catalog_members', 'teams_catalog', 'driver_profiles', 'settings']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
});

/**
 * Carrera por equipos, 2 equipos, una manga cerrada. Cada equipo corre `vueltas`
 * vueltas con su mejor tiempo; A acaba con coma `comaA` y B con `comaB`.
 */
function carrera({ vueltasA = 12, vueltasB = 12, bestA = 9000, bestB = 9500, comaA = 0, comaB = 0, nombreB = 'Equipo B' } = {}) {
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, status, lanes_count, lane_sequence, circuits_config, manga_duration_minutes, min_lap_ms)
    VALUES ('Carrera Ñ', 'championship', 'team', 'finished', 2, '[1,2]', '[2]', 10, 4000)
  `).run().lastInsertRowid;
  const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, 1)').run(raceId).lastInsertRowid;
  const mid = db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, 1)').run(tandaId, raceId).lastInsertRowid;
  db.prepare("UPDATE mangas SET status='finished', started_at='2020-01-01 00:00:00', finished_at='2020-01-01 00:10:00', actual_duration_ms=600000 WHERE id=?").run(mid);

  const teams = [
    { name: 'Equipo A', n: vueltasA, best: bestA, coma: comaA },
    { name: nombreB,    n: vueltasB, best: bestB, coma: comaB },
  ].map((t, i) => {
    const tid = Team.create({ race_id: raceId, tanda_id: tandaId, name: t.name, lane: 0, color: '#fff' });
    db.prepare('INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest, coma) VALUES (?,?,?,0,?)').run(mid, i + 1, tid, t.coma);
    for (let k = 1; k <= t.n; k++) {
      Lap.create({
        race_id: raceId, manga_id: mid, team_id: tid, lane: i + 1,
        lap_number: k, lap_time_ms: k === 2 ? t.best : t.best + 500,
        elapsed_ms: t.best * k,
      });
    }
    return tid;
  });
  return { raceId, mid, teams };
}

function get(raceId, query = {}) {
  const res = {
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
  SessionController.areaCorseCsv({ params: { id: String(raceId) }, query, t: (k) => k }, res);
  const text = res.body ? res.body.replace(/^﻿/, '') : null;
  return { res, text, lines: text ? text.split('\r\n').filter(l => l !== '') : [] };
}

test('formato: sep=;, cabecera y una fila por entidad', () => {
  const { raceId } = carrera({ comaA: 0.38, comaB: 0.12 });
  const { res, lines } = get(raceId);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Disposition'], /attachment; filename="Carrera[^"]*_areacorse\.csv"/);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.equal(lines[0], 'sep=;', 'primera línea obligatoria');
  assert.equal(lines[1], 'pilota_id;giri;settori;miglior_tempo;posizione;nome');
  assert.equal(lines.length, 4, 'cabecera + 2 equipos');
});

test('settori = la coma de la última manga en la escala de la pista (100)', () => {
  const { raceId, teams } = carrera({ comaA: 0.38, comaB: 0.12 });
  const { lines } = get(raceId);
  const [a, b] = lines.slice(2).map(l => l.split(';'));

  assert.equal(a[0], String(teams[0]), 'pilota_id = id interno');
  assert.equal(a[1], '12', 'giri');
  assert.equal(a[2], '38', '0,38 de vuelta = 38 sectores (pista de 100)');
  assert.equal(b[2], '12');
  assert.equal(a[4], '1', 'posición oficial');
  assert.equal(b[4], '2');
  assert.equal(a[5], 'Equipo A');
  assert.equal(b[5], 'Equipo B');
});

test('miglior_tempo en HH:MM:SS.mmm y vacío si no hay vuelta válida', () => {
  const { raceId } = carrera({ bestA: 8590, bestB: 12345 });
  const { lines } = get(raceId);
  const [a, b] = lines.slice(2).map(l => l.split(';'));
  assert.equal(a[3], '00:00:08.590');
  assert.equal(b[3], '00:00:12.345');

  // Sin vueltas válidas (todas warmup) → tiempo vacío.
  const soloWarmup = carrera({ vueltasA: 1, vueltasB: 1, comaA: 0, comaB: 0 });
  db.prepare('UPDATE laps SET is_warmup = 1 WHERE manga_id = ?').run(soloWarmup.mid);
  const { lines: l2 } = get(soloWarmup.raceId);
  assert.equal(l2[2].split(';')[3], '');
});

test('la escala de sectores es configurable (?settori=) y el orden se conserva', () => {
  const { raceId } = carrera({ comaA: 0.38, comaB: 0.12 });
  const { lines } = get(raceId, { settori: '122' });
  const [a, b] = lines.slice(2).map(l => l.split(';'));
  assert.equal(a[2], String(Math.round(0.38 * 122)), '0,38 × 122 sectores');
  assert.ok(Number(a[2]) > Number(b[2]), 'el orden relativo no cambia');
});

test('la coma 0,99 no se sale de la escala (queda en settori-1)', () => {
  const { raceId } = carrera({ comaA: 0.99, comaB: 0 });
  const { lines } = get(raceId);
  assert.equal(lines[2].split(';')[2], '99');
});

test('nombres con punto y coma o comillas se escapan', () => {
  const { raceId } = carrera({ nombreB: 'Escudería "Rápida"; S.L.' });
  const { lines } = get(raceId);
  assert.ok(lines[3].includes('"Escudería ""Rápida""; S.L."'), 'campo entrecomillado y comillas dobladas: ' + lines[3]);
  // Y el número de campos sigue siendo 6 al partir con un parser CSV real.
  const campos = lines[3].match(/("([^"]|"")*"|[^;]*)(;|$)/g).filter((_, i, arr) => i < arr.length - 1);
  assert.equal(campos.length, 6);
});

test('sin carrera → 404', () => {
  const { res } = get(9999);
  assert.equal(res.statusCode, 404);
});
