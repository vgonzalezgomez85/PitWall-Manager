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
// Persistencia de los entrenos competitivos. La sesión vivía solo en memoria y al
// parar se perdían los heats: aquí se clava que la bandera guarda, que el stop
// forzado NO guarda (el heat se repite entero) y que la clasificación suma bien
// las vueltas de un participante que ha rodado en varios carriles.

const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();                       // ← antes de cualquier require de la BD

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const SerialService = require('../src/services/SerialService');
const CompetitionService = require('../src/services/CompetitionTrainingService');
const CompetitionTrainingResult = require('../src/models/CompetitionTrainingResult');

after(limpiarBdTemporal);

beforeEach(() => {
  db.prepare('DELETE FROM competition_training_results').run();
  CompetitionService.stop();
});

const PARTICIPANTES = [
  { name: 'Ana',  color: '#e63946' },
  { name: 'Bru',  color: '#2196f3' },
  { name: 'Cesc', color: '#4caf50' },
];

// Arranca un heat y mete `laps` en cada carril indicado.
function correrHeat(cruces) {
  SerialService.emit('race_go', { durationMs: 60_000 });
  SerialService.emit('race_started');
  for (const { lane, lapTimeMs } of cruces) {
    SerialService.emit('lane_crossing', { lane, lapTimeMs, circuit: 0 });
  }
}

test('la bandera guarda el heat, con una fila por carril que ha rodado', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  const sessionId = CompetitionService.sessionId;
  assert.ok(sessionId, 'setup debe abrir una sesión');

  correrHeat([
    { lane: 1, lapTimeMs: 10_000 },
    { lane: 1, lapTimeMs: 12_000 },
    { lane: 2, lapTimeMs: 11_000 },
  ]);
  SerialService.emit('race_finished');   // bandera → guarda y rota

  const filas = CompetitionTrainingResult.getHeats(sessionId);
  assert.equal(filas.length, 2, 'un carril con cruces = una fila');

  const c1 = filas.find(f => f.lane === 1);
  assert.equal(c1.heat_number, 1);
  assert.equal(c1.lap_count, 2);
  assert.equal(c1.best_lap_ms, 10_000);
  assert.equal(c1.avg_lap_ms, 11_000);
  assert.ok(PARTICIPANTES.some(p => p.name === c1.participant_name));

  // El tercer participante descansaba: no deja fila.
  assert.equal(new Set(filas.map(f => f.participant_name)).size, 2);
});

test('un carril sin cruces no deja fila', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  const sessionId = CompetitionService.sessionId;

  correrHeat([{ lane: 1, lapTimeMs: 10_000 }]);   // el carril 2 no cruza
  SerialService.emit('race_finished');

  const filas = CompetitionTrainingResult.getHeats(sessionId);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].lane, 1);
});

test('el stop forzado NO guarda: el heat se repite entero', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  const sessionId = CompetitionService.sessionId;

  correrHeat([{ lane: 1, lapTimeMs: 10_000 }]);
  SerialService.emit('race_stopped');             // stop forzado → descarta

  assert.equal(CompetitionTrainingResult.getHeats(sessionId).length, 0);
  assert.equal(CompetitionService.heatNumber, 1, 'sigue en el mismo heat');
});

test('la clasificación suma las vueltas de todos los heats del participante', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  const sessionId = CompetitionService.sessionId;

  // Heat 1: quien esté en el carril 1 hace 2 vueltas.
  const heat1 = CompetitionService.getLanes();
  const enCarril1 = heat1.find(l => l.lane === 1).participantName;
  correrHeat([{ lane: 1, lapTimeMs: 10_000 }, { lane: 1, lapTimeMs: 20_000 }]);
  SerialService.emit('race_finished');            // rota: pasa al carril 2

  // Heat 2: el mismo participante, ahora en otro carril, hace 1 vuelta.
  const heat2 = CompetitionService.getLanes();
  const suCarril = heat2.find(l => l.participantName === enCarril1).lane;
  assert.notEqual(suCarril, 1, 'la rotación debe haberlo movido de carril');
  correrHeat([{ lane: suCarril, lapTimeMs: 30_000 }]);
  SerialService.emit('race_finished');

  const clasif = CompetitionTrainingResult.getStandings(sessionId);
  const suyo = clasif.find(c => c.participant_name === enCarril1);
  assert.equal(suyo.heats, 2);
  assert.equal(suyo.laps, 3, '2 vueltas del heat 1 + 1 del heat 2');
  assert.equal(suyo.best_lap_ms, 10_000, 'la mejor de toda la sesión');
  // Media ponderada por vueltas: (15.000×2 + 30.000×1) / 3 = 20.000.
  // La media de las medias daría 22.500, que es justo el error a evitar.
  assert.equal(suyo.avg_lap_ms, 20_000);
});

// El banco real de 3 DS guardó "mejores vueltas" de 962 ms y 1.779 ms: cruces
// que no son vueltas (adaptador que repite la trama, doble disparo del puente).
// Sin filtro contaminaban la media Y ganaban el desempate por mejor vuelta.
test('la vuelta por debajo del Pt se descarta entera', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2], 5_000);   // Pt = 5 s
  const sessionId = CompetitionService.sessionId;

  correrHeat([
    { lane: 1, lapTimeMs: 10_000 },
    { lane: 1, lapTimeMs: 962 },      // fantasma
    { lane: 1, lapTimeMs: 12_000 },
  ]);
  SerialService.emit('race_finished');

  const c1 = CompetitionTrainingResult.getHeats(sessionId).find(f => f.lane === 1);
  assert.equal(c1.lap_count, 2, 'el fantasma no cuenta vuelta');
  assert.equal(c1.best_lap_ms, 10_000, 'el fantasma no puede ser la mejor vuelta');
  assert.equal(c1.avg_lap_ms, 11_000, 'el fantasma no entra en la media');
});

test('sin Pt (0) no se filtra nada — el comportamiento de siempre', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2], 0);
  const sessionId = CompetitionService.sessionId;

  correrHeat([{ lane: 1, lapTimeMs: 10_000 }, { lane: 1, lapTimeMs: 962 }]);
  SerialService.emit('race_finished');

  const c1 = CompetitionTrainingResult.getHeats(sessionId).find(f => f.lane === 1);
  assert.equal(c1.lap_count, 2);
  assert.equal(c1.best_lap_ms, 962);
});

test('un carril cuyos cruces son TODOS fantasmas no deja fila', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2], 5_000);
  const sessionId = CompetitionService.sessionId;

  correrHeat([{ lane: 1, lapTimeMs: 10_000 }, { lane: 2, lapTimeMs: 900 }]);
  SerialService.emit('race_finished');

  const filas = CompetitionTrainingResult.getHeats(sessionId);
  assert.equal(filas.length, 1, 'solo el carril con una vuelta real');
  assert.equal(filas[0].lane, 1);
});

test('el Pt exacto NO es fantasma: se descarta lo que está por DEBAJO', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2], 5_000);
  const sessionId = CompetitionService.sessionId;

  correrHeat([{ lane: 1, lapTimeMs: 5_000 }, { lane: 1, lapTimeMs: 4_999 }]);
  SerialService.emit('race_finished');

  const c1 = CompetitionTrainingResult.getHeats(sessionId).find(f => f.lane === 1);
  assert.equal(c1.lap_count, 1);
  assert.equal(c1.best_lap_ms, 5_000);
});

test('cada sesión se lista por separado y se puede borrar', () => {
  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);
  const s1 = CompetitionService.sessionId;
  correrHeat([{ lane: 1, lapTimeMs: 10_000 }]);
  SerialService.emit('race_finished');

  CompetitionService.setup(PARTICIPANTES, 2, [1, 2]);   // sesión nueva
  const s2 = CompetitionService.sessionId;
  assert.notEqual(s1, s2);
  correrHeat([{ lane: 1, lapTimeMs: 9_000 }]);
  SerialService.emit('race_finished');

  assert.equal(CompetitionTrainingResult.listSessions().length, 2);

  CompetitionTrainingResult.deleteSession(s1);
  const quedan = CompetitionTrainingResult.listSessions();
  assert.equal(quedan.length, 1);
  assert.equal(quedan[0].session_id, s2);
});
