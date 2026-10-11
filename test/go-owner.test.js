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
// Dueño del próximo GO (carrera / pole / entreno). El caso del club: carrera
// preparada con días de antelación, tandas 1-2 el jueves y 3-4 el viernes, y
// entrenos antes, entre medias y después, con el directo olvidado abierto.
const { usarBdTemporal, limpiarBdTemporal } = require('./helpers/db');
usarBdTemporal();

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
const { decideGoOwner, canCede } = require('../src/lib/goOwner');
const GoOwner       = require('../src/services/GoOwnerService');
const SocketService = require('../src/services/SocketService');
const TimingService = require('../src/services/TimingService');

after(() => limpiarBdTemporal());

const BASE = {
  mangaRaceId: null, poleRaceId: null, halfTanda: null, claimRaceId: null,
  tandaBoundary: false, liveViewer: false, simReplay: false,
};
const decide = (s) => decideGoOwner({ ...BASE, ...s });

// ── Regla pura ───────────────────────────────────────────────────────────────

test('sin nada pedido el GO es del entreno, aunque haya un directo abierto', () => {
  assert.equal(decide({ liveViewer: true }).owner, 'training');
});

test('carrera pedida y directo abierto: el GO es de la carrera y el entreno se lo puede quitar', () => {
  const d = decide({ claimRaceId: 7, liveViewer: true });
  assert.deepEqual([d.owner, d.reason, d.raceId], ['race', 'claimed', 7]);
  assert.equal(canCede(d), true);
});

test('carrera pedida sin directo abierto: el GO no se pierde, es del entreno', () => {
  const d = decide({ claimRaceId: 7 });
  assert.deepEqual([d.owner, d.reason, d.claimed], ['training', 'no_live_viewer', true]);
});

test('fin de tanda: el GO vuelve al entreno con el directo abierto', () => {
  const d = decide({ claimRaceId: 7, liveViewer: true, tandaBoundary: true });
  assert.deepEqual([d.owner, d.reason], ['training', 'tanda_boundary']);
});

test('tanda a medias: la carrera manda y el entreno no se la puede quitar', () => {
  const d = decide({ halfTanda: { raceId: 7, tandaNumber: 2 }, liveViewer: true });
  assert.deepEqual([d.owner, d.reason], ['race', 'tanda_half']);
  assert.equal(canCede(d), false);
});

test('manga en marcha y pole mandan sobre todo lo demás', () => {
  assert.equal(decide({ mangaRaceId: 3, claimRaceId: 7 }).reason, 'manga_running');
  const p = decide({ poleRaceId: 4, claimRaceId: 7, liveViewer: true });
  assert.deepEqual([p.owner, p.raceId], ['pole', 4]);
  assert.equal(canCede(p), false);
});

test('el reproductor de carrera simulada siempre da el GO a la carrera', () => {
  assert.deepEqual([decide({ simReplay: true }).owner, decide({ simReplay: true }).reason], ['race', 'sim_replay']);
});

// ── Servicio sobre la BD: el jueves y el viernes del club ────────────────────

let raceId, mangas;
function crearCarrera4x2() {
  raceId = db.prepare(`INSERT INTO races (name, type, format, status) VALUES ('Club 4 tandas', 'club', 'individual', 'active')`)
    .run().lastInsertRowid;
  mangas = [];
  for (let t = 1; t <= 4; t++) {
    const tandaId = db.prepare('INSERT INTO tandas (race_id, number) VALUES (?, ?)').run(raceId, t).lastInsertRowid;
    for (let m = 1; m <= 2; m++) {
      mangas.push({ tanda: t, tandaId, id: db.prepare('INSERT INTO mangas (tanda_id, race_id, number) VALUES (?, ?, ?)')
        .run(tandaId, raceId, m).lastInsertRowid });
    }
  }
}
let segundo = 0;
function correr(tanda, num) {
  const m = mangas.filter(x => x.tanda === tanda)[num - 1];
  segundo++;
  db.prepare(`UPDATE mangas SET status = 'finished', finished_at = datetime('2026-10-15 20:00:00', '+${segundo} seconds') WHERE id = ?`).run(m.id);
  const quedan = db.prepare(`SELECT COUNT(*) n FROM mangas WHERE tanda_id = ? AND status = 'pending'`).get(m.tandaId).n;
  db.prepare('UPDATE tandas SET status = ? WHERE id = ?').run(quedan ? 'active' : 'finished', m.tandaId);
}

const hasLive = SocketService.hasLocalLiveViewer;
beforeEach(() => {
  db.prepare('DELETE FROM races').run();
  GoOwner._claimRaceId = null;
  TimingService._tandaBoundary = false;
  TimingService._pendingSetup = null;
  SocketService.hasLocalLiveViewer = () => true;   // directo abierto (por despiste)
  crearCarrera4x2();
});
after(() => { SocketService.hasLocalLiveViewer = hasLive; });

test('carrera preparada sin empezar: con el directo abierto el GO sigue siendo del entreno', () => {
  assert.equal(GoOwner.decide().owner, 'training');
});

test('abrir el directo de la manga 1 pide el GO; entrar al entreno lo devuelve', () => {
  GoOwner.claimRace(raceId, 'test');
  assert.equal(GoOwner.decide().owner, 'race');
  assert.equal(GoOwner.cedeToTraining('test'), true);
  assert.equal(GoOwner.decide().owner, 'training');
});

test('jueves: a mitad de la tanda 2 la carrera manda y el entreno no se la quita', () => {
  correr(1, 1); correr(1, 2); correr(2, 1);
  const d = GoOwner.decide();
  assert.deepEqual([d.owner, d.reason], ['race', 'tanda_half']);
  assert.equal(GoOwner.cedeToTraining('test'), false);
});

test('jueves: acaba la tanda 2 con el directo abierto → el GO es del entreno', () => {
  GoOwner.claimRace(raceId, 'test');
  correr(1, 1); correr(1, 2); correr(2, 1); correr(2, 2);
  TimingService._tandaBoundary = true;
  GoOwner.release('fin de la tanda');
  assert.equal(GoOwner.decide().owner, 'training');
});

test('viernes tras reiniciar: «Recuperar el GO» sin pulsar «▶ Tanda 3» no se lleva el GO', () => {
  correr(1, 1); correr(1, 2); correr(2, 1); correr(2, 2);
  GoOwner.claimRace(raceId, 'test');           // en memoria no hay límite: solo la BD lo sabe
  const d = GoOwner.decide();
  assert.deepEqual([d.owner, d.reason], ['training', 'tanda_boundary']);
});

test('viernes: «▶ Tanda 3» prepara la manga y la carrera vuelve a mandar', () => {
  correr(1, 1); correr(1, 2); correr(2, 1); correr(2, 2);
  const m31 = mangas.find(x => x.tanda === 3);
  TimingService._pendingSetup = { manga: { id: m31.id, tanda_id: m31.tandaId }, race: { id: raceId } };
  GoOwner.claimRace(raceId, 'tanda 3');
  assert.equal(GoOwner.decide().owner, 'race');
});

test('una carrera pedida que ya no tiene nada que correr no se queda el GO', () => {
  GoOwner.claimRace(raceId, 'test');
  db.prepare(`UPDATE races SET status = 'finished' WHERE id = ?`).run(raceId);
  assert.equal(GoOwner.decide().owner, 'training');
});

test('una pole ya cerrada en la BD no se queda el GO aunque el servicio siga armado', () => {
  const Pole = require('../src/services/PoleTimingService');
  const sid = db.prepare(`INSERT INTO pole_sessions (race_id, status) VALUES (?, 'in_progress')`).run(raceId).lastInsertRowid;
  const prev = { session: Pole.session, standby: Pole._standby };
  Pole.session = { poleSessionId: sid }; Pole._standby = true;
  try {
    assert.equal(GoOwner.decide().owner, 'pole');
    db.prepare(`UPDATE pole_sessions SET status = 'done' WHERE id = ?`).run(sid);
    assert.equal(GoOwner.decide().owner, 'training');
  } finally {
    Pole.session = prev.session; Pole._standby = prev.standby;
  }
});
