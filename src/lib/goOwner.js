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
// Dueño del próximo GO de la caja: carrera, pole o entreno. PURO.
//
// Antes había dos reglas que no coincidían (la carrera exigía un directo abierto;
// el entreno se apartaba con cualquier manga preparada o con el límite de tanda)
// y el GO se perdía: al acabar una tanda no arrancaba nadie. Ahora la carrera,
// el entreno, su aviso y la app de escritorio preguntan aquí, y si la carrera no
// puede arrancar el GO es del entreno.
//
// La carrera solo es dueña si alguien la ha pedido (`claimRaceId`: abrir el
// directo de una manga pendiente, «▶ Tanda N», «Repetir», «Recuperar el GO») o
// si tiene una tanda a medias (reinicio a mitad de una resistencia). Al acabar
// una tanda la petición se suelta sola.

/**
 * @param {object} s
 * @param {number|null} s.mangaRaceId    carrera con una manga en marcha o en pausa
 * @param {number|null} s.poleRaceId     carrera con una pole preparada o corriendo
 * @param {{raceId:number, tandaNumber:number}|null} s.halfTanda  tanda a medias
 * @param {number|null} s.claimRaceId    carrera que alguien ha pedido
 * @param {boolean} s.tandaBoundary      acaba de terminar una tanda y la siguiente no está preparada
 * @param {boolean} s.liveViewer         hay un directo abierto en el ordenador de la pista
 * @param {boolean} s.simReplay          el GO lo da el reproductor de carrera simulada
 * @returns {{owner:'race'|'pole'|'training', reason:string|null, raceId:number|null, claimed:boolean}}
 *   `claimed`: la carrera o la pole tienen el GO pedido aunque ahora no lo
 *   cojan (sin directo abierto); lo usa la app de escritorio al arrancar.
 */
function decideGoOwner(s) {
  if (s.mangaRaceId != null) return { owner: 'race', reason: 'manga_running', raceId: s.mangaRaceId, claimed: true };
  if (s.poleRaceId  != null) return { owner: 'pole', reason: 'pole',          raceId: s.poleRaceId,  claimed: true };
  if (s.simReplay)           return { owner: 'race', reason: 'sim_replay',    raceId: null,          claimed: true };

  const raceId = s.halfTanda ? s.halfTanda.raceId : s.claimRaceId;
  if (raceId == null) return { owner: 'training', reason: null, raceId: null, claimed: false };
  // Acaba de terminar una tanda y nadie ha pulsado «▶ Tanda N»: la carrera no
  // arrancaría (app.js), así que el GO es del entreno.
  if (s.tandaBoundary) return { owner: 'training', reason: 'tanda_boundary', raceId, claimed: false };

  const reason = s.halfTanda ? 'tanda_half' : 'claimed';
  if (!s.liveViewer) return { owner: 'training', reason: 'no_live_viewer', raceId, claimed: true };
  return { owner: 'race', reason, raceId, claimed: true };
}

// El entreno solo puede quitarle el GO a una carrera pedida pero sin empezar:
// nunca a una manga en marcha, a una tanda a medias ni a la pole.
function canCede(decision) {
  return decision.owner === 'race' && decision.reason === 'claimed';
}

module.exports = { decideGoOwner, canCede };
