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
// ════════════════════════════════════════════════════════════════════════════
//  MOTOR DE PROYECCIÓN DE CARRERA — cálculo PURO, sin estado.
//
//  Es la ÚNICA fuente de verdad de la proyección para TODAS las vistas
//  (Le Mans, panel/directo, live-stats, Lap, resultados). Vivía como método de
//  `TimingService` (`buildRaceProjection`); se ha extraído aquí SIN cambiar la
//  lógica para poder ejecutarlo:
//    · desde el hilo principal (TimingService delega y le pasa sus cachés), y
//    · desde un worker_thread con su propia conexión `readonly` a la BD, sin
//      arrastrar el estado en memoria de TimingService (`this.session`).
//
//  100% BASADO EN BD — NO usa ninguna sesión viva. Todas las dependencias
//  externas entran por `deps`, con defaults al singleton para el uso normal:
//    deps.db            conexión better-sqlite3            (def: config/database)
//    deps.Lap           modelo Lap                          (def: models/Lap)
//    deps.now           reloj, () => epoch ms               (def: Date.now)
//    deps.activeMangaOf (raceId) => fila de la manga activa (def: local)
//    deps.raceAggregate (raceId) => agregado por entidad    (def: local)
//
//  Fórmula (FIJA):
//    proyección = vueltas_totales + coma_fraccionaria + (tiempo_restante ÷ media)
//      · media              = AVG(lap_time_ms) sin warmup/ghost (= TicTac).
//      · vueltas_totales     = COUNT vueltas válidas (is_ghost=0, lap_number>0).
//      · tiempo_restante_ms  = mangas_pendientes × duración_manga
//                              + (si en pista ahora → restante de la manga actual).
//  Orden: proyección DESC; desempates vueltas DESC, coma última manga DESC,
//  tiempo total ASC, mejor vuelta ASC. Entidad sin proyección → al final.
// ════════════════════════════════════════════════════════════════════════════

/**
 * La manga EN CURSO de una carrera (started_at fijado y aún no 'finished'), o
 * null. Desde BD: vale para una carrera que no es la que este proceso corre, y
 * sobrevive a un reinicio.
 */
function activeMangaOf(db, raceId) {
  return db.prepare(`
    SELECT id, number, started_at, actual_duration_ms
    FROM mangas
    WHERE race_id = ? AND status != 'finished' AND started_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(raceId) || null;
}

/**
 * Agregado por entidad de TODA la carrera, por la vía barata siempre que se
 * pueda: con una manga en curso, las mangas ya cerradas se reutilizan de
 * `opts.priorRaw` (que el llamador cachea) y solo se agrega la manga viva.
 * Da EXACTAMENTE el mismo resultado que `Lap.aggregateByRace`.
 *
 *   opts.activeManga  fila de la manga activa ya resuelta (o null). Si se omite
 *                     (undefined) se calcula aquí.
 *   opts.priorRaw     Lap._aggRaw(raceId, { excludeManga: activeManga.id }) ya
 *                     calculado. Si se omite se calcula aquí (escaneo caro).
 */
function raceAggregate(db, Lap, raceId, opts = {}) {
  const activa = opts.activeManga !== undefined ? opts.activeManga : activeMangaOf(db, raceId);
  if (!activa) return Lap.aggregateByRace(raceId);
  const priorRaw = opts.priorRaw != null
    ? opts.priorRaw
    : Lap._aggRaw(raceId, { excludeManga: activa.id });
  return Lap.aggregateByRaceSplit(raceId, activa.id, priorRaw);
}

/**
 * Proyección de carrera por entidad. Ver cabecera del módulo para la fórmula.
 * Devuelve array ordenado de:
 *   { position, entityId, entityType, name, categoria, totalLaps, total,
 *     avgLapMs, bestLapMs, comaTotal, lastMangaComa, mangasRaced, totalTimeMs,
 *     remainingMs, futureRemMs, onTrack, provisional, projectedRaw,
 *     projectedTotal, gapV, gapVLeader, gapSec, gapSecLeader, avgToCatch }
 */
function buildRaceProjection(raceId, deps = {}) {
  const db  = deps.db  || require('../config/database');
  const Lap = deps.Lap || require('../models/Lap');
  const now = deps.now || Date.now;
  const activeMangaOfFn = deps.activeMangaOf || ((rid) => activeMangaOf(db, rid));
  const raceAggregateFn = deps.raceAggregate || ((rid) => raceAggregate(db, Lap, rid));

  const race = db.prepare('SELECT id, format, manga_duration_minutes FROM races WHERE id = ?').get(raceId);
  if (!race) return [];
  const isTeam = race.format === 'team';
  const idCol  = isTeam ? 'ml.team_id' : 'ml.driver_id';

  // ── Categoría por equipo (catálogo del club, empareja por NOMBRE — igual
  // que Le Mans/live-stats). Solo aplica a carreras por equipos; un piloto
  // suelto no tiene categoría de equipo.
  const categoriaById = {};
  if (isTeam) {
    db.prepare(`
      SELECT t.id AS eid, tc.categoria AS categoria
      FROM teams t
      LEFT JOIN teams_catalog tc ON tc.name = t.name
      WHERE t.race_id = ? AND tc.categoria IS NOT NULL
    `).all(raceId).forEach(r => { categoriaById[r.eid] = r.categoria; });
  }

  const durDefaultMs = (race.manga_duration_minutes || 0) * 60000;

  // ── Manga ACTIVA (en curso): started_at fijado y aún no 'finished'.
  // Su duración real (actual_duration_ms) y su transcurrido/restante se
  // derivan del reloj, NO de la sesión en memoria.
  const activeManga = activeMangaOfFn(raceId);

  let activeMangaId = null, activeRemMs = 0, activeDurMs = 0, activeElapsedMs = 0;
  if (activeManga) {
    activeMangaId = activeManga.id;
    const durMs = activeManga.actual_duration_ms > 0 ? activeManga.actual_duration_ms : durDefaultMs;
    const startedMs = activeManga.started_at
      ? (Date.parse(activeManga.started_at + 'Z') || Date.parse(activeManga.started_at))
      : null;
    const elapsed = startedMs != null ? (now() - startedMs) : 0;
    activeRemMs     = Math.max(0, durMs - elapsed);
    activeDurMs     = durMs;
    activeElapsedMs = Math.max(0, elapsed);
  }

  // ── Mangas PENDIENTES (aún por correr) por entidad. Excluye la activa: su
  // tiempo restante ya lo aporta activeRemMs para los que están en pista.
  const pendRows = db.prepare(`
    SELECT ${idCol} AS eid, COUNT(*) AS pending
    FROM manga_lanes ml JOIN mangas m ON m.id = ml.manga_id
    WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
      AND m.status = 'pending' AND m.started_at IS NULL
    GROUP BY eid
  `).all(raceId);
  const pendingById = {};
  pendRows.forEach(r => { pendingById[r.eid] = r.pending || 0; });

  // ── Entidades EN PISTA ahora (asignadas a la manga activa, no descanso).
  const onTrackSet = new Set();
  if (activeMangaId) {
    db.prepare(`
      SELECT ${idCol} AS eid FROM manga_lanes ml
      WHERE ml.manga_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
    `).all(activeMangaId).forEach(r => onTrackSet.add(r.eid));
  }

  // ── Duración de manga para las PENDIENTES futuras: la real de cada manga
  // futura si estuviera guardada; como aún no han corrido, usamos el default
  // de la carrera (mismo criterio que el resto de vistas).
  const futureMangaDurMs = durDefaultMs;

  // ── Último cruce (elapsed_ms) de cada entidad en la manga ACTIVA, para la
  // posición fraccionaria VIVA dentro de la vuelta en curso (liveFrac). 100 % BD.
  const lastElapsedById = {};
  if (activeMangaId) {
    const lapIdCol = isTeam ? 'team_id' : 'driver_id';
    db.prepare(`
      SELECT ${lapIdCol} AS eid, MAX(elapsed_ms) AS last_el
      FROM laps
      WHERE manga_id = ? AND is_ghost = 0 AND ${lapIdCol} IS NOT NULL
      GROUP BY eid
    `).all(activeMangaId).forEach(r => { lastElapsedById[r.eid] = r.last_el || 0; });
  }

  // ── 1ª manga por entidad (para marcar la estimada PROVISIONAL mientras esa
  // manga aún no ha cruzado el 60 % → settledAvg no bloqueado).
  const settled = Lap.startSettledByEntity(raceId);
  const entKey  = (p) => `${p.entity_type}:${p.entity_id}`;

  // ── Agregado por entidad (media simple, total, coma, best) desde BD.
  const agg = raceAggregateFn(raceId).filter(p => p.entity_id != null);

  // Incluir TAMBIÉN las entidades asignadas a la carrera que aún no tienen
  // vueltas (tandas/mangas por empezar): deben salir en la clasificación con
  // proyección null (al final), igual que en el panel y en Le Mans.
  const nameJoin = isTeam ? 'teams e ON e.id = ml.team_id' : 'drivers e ON e.id = ml.driver_id';
  const assigned = db.prepare(`
    SELECT ${idCol} AS eid, e.name AS name
    FROM manga_lanes ml JOIN mangas m ON m.id = ml.manga_id
    JOIN ${nameJoin}
    WHERE m.race_id = ? AND ml.is_rest = 0 AND ${idCol} IS NOT NULL
    GROUP BY eid
  `).all(raceId);
  const haveAgg = new Set(agg.map(p => p.entity_id));
  assigned.forEach(a => {
    if (haveAgg.has(a.eid)) return;
    agg.push({
      entity_id: a.eid, entity_name: a.name,
      entity_type: isTeam ? 'team' : 'driver',
      total_laps: 0, avg_lap_ms: null, best_lap_ms: null,
      coma_total: 0, last_manga_coma: 0, mangas_raced: 0, total_time_ms: 0,
    });
  });

  const proj = agg.map(p => {
    const onTrack = onTrackSet.has(p.entity_id);
    const futureRemMs = (pendingById[p.entity_id] || 0) * futureMangaDurMs;
    const remMs = (onTrack ? activeRemMs : 0) + futureRemMs;
    const avg   = p.avg_lap_ms;
    // Posición FRACCIONARIA dentro de la vuelta en curso, para que la distancia
    // no colapse a vueltas enteras al terminar (bug del gap 3,0 vs 2,8 real):
    //   · en pista → coma VIVA (now − último cruce) / media, acotada a 0,99.
    //   · si no (manga finalizada / descansa) → coma de la ÚLTIMA manga (la que
    //     ya desempata en resultados). Sin esto, al caer la bandera se perdía la
    //     posición en pista y el gap se redondeaba a entero.
    let frac = 0;
    if (avg != null && avg > 0) {
      if (onTrack && lastElapsedById[p.entity_id] != null) {
        frac = Math.min(0.99, Math.max(0, (activeElapsedMs - lastElapsedById[p.entity_id]) / avg));
      } else {
        frac = p.last_manga_coma || 0;
      }
    }
    // Proyección MEDIA-BASED: total + posición fraccionaria + tiempo_restante / media.
    // No hay doble conteo: el tiempo ya gastado en la vuelta en curso va en
    // `elapsed` (no en remMs), así que `frac` (lo ya rodado sin contar como
    // vuelta entera) es aditivo con remMs/avg (lo que queda por rodar).
    const projRaw = (avg != null && avg > 0)
      ? p.total_laps + frac + remMs / avg
      : null;
    // Estimada PROVISIONAL: la 1ª manga de la entidad es la activa y aún no ha
    // cruzado el 60 % de su duración → settledAvg (tiempo total) no bloqueado.
    const first = settled.get(entKey(p));
    const provisional = !!(first && activeMangaId != null
      && first.firstMangaId === activeMangaId
      && activeElapsedMs < 0.6 * activeDurMs);
    return {
      entityId:    p.entity_id,
      entityType:  p.entity_type,
      name:        p.entity_name,
      categoria:   categoriaById[p.entity_id] || null,
      totalLaps:   p.total_laps,
      avgLapMs:    avg != null ? Math.round(avg) : null,
      bestLapMs:   p.best_lap_ms,
      comaTotal:   p.coma_total || 0,
      lastMangaComa: p.last_manga_coma || 0,
      mangasRaced: p.mangas_raced || 0,
      totalTimeMs: p.total_time_ms ?? null,
      remainingMs: remMs,
      futureRemMs,
      onTrack,
      provisional,
      projectedRaw: projRaw,
    };
  });

  // Orden: proyección DESC; a igualdad, vueltas DESC y luego por la coma de la
  // ÚLTIMA manga DESC (quién iba más adelantado en pista al final). El tiempo
  // total y la mejor vuelta quedan como criterios posteriores. Entidades sin
  // proyección (null) al final.
  // DEBE coincidir con el desempate de Lap.aggregateByRace: si no, dos entidades
  // empatadas a vueltas saldrían en orden OPUESTO según se mire el panel/Le Mans
  // o la pantalla de resultados (bug histórico de la coma).
  proj.sort((a, b) => {
    if (a.projectedRaw == null && b.projectedRaw == null) return (a.name || '').localeCompare(b.name || '');
    if (a.projectedRaw == null) return 1;
    if (b.projectedRaw == null) return -1;
    return (b.projectedRaw - a.projectedRaw)
        || (b.totalLaps - a.totalLaps)
        || ((b.lastMangaComa || 0) - (a.lastMangaComa || 0))
        || ((a.totalTimeMs ?? Infinity) - (b.totalTimeMs ?? Infinity))
        || ((a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity));
  });

  const leaderRaw = proj.length ? proj[0].projectedRaw : null;
  return proj.map((r, i) => {
    const ahead    = proj[i - 1];
    const aheadRaw = ahead ? ahead.projectedRaw : null;
    const gapV     = (i === 0 || aheadRaw == null || r.projectedRaw == null) ? null : (aheadRaw - r.projectedRaw);
    const gapVLead = (i === 0 || leaderRaw == null || r.projectedRaw == null) ? null : (leaderRaw - r.projectedRaw);
    // "P/Subir": media ms/vuelta que necesita en lo que le queda para alcanzar
    // la proyección del de delante. null = líder / sin tiempo / inalcanzable.
    let avgToCatch = null;
    // Solo tiene sentido para quien YA está corriendo (tiene vueltas): a un
    // piloto con 0 vueltas (aún no ha corrido / corre en otra tanda) no se le
    // da un "ritmo para subir".
    if (r.totalLaps > 0 && !(i === 0 || aheadRaw == null || !(r.remainingMs > 0))) {
      const lapsNeeded = aheadRaw - r.totalLaps;
      const req = lapsNeeded > 0 ? r.remainingMs / lapsNeeded : null;
      if (req != null && req > 0 && (!r.bestLapMs || req >= r.bestLapMs)) avgToCatch = Math.round(req);
    }
    // Gap en SEGUNDOS = vueltas_gap × media del PERSEGUIDOR (esta fila). Es lo
    // que tardaría este coche en recuperar esa distancia a su ritmo (cuadra con
    // el "a XX,X\"" de TicTac: 2,8 v × 12,67 s ≈ 35,5").
    const gapSec     = (gapV     != null && r.avgLapMs) ? Math.round(gapV     * r.avgLapMs) : null;
    const gapSecLead = (gapVLead != null && r.avgLapMs) ? Math.round(gapVLead * r.avgLapMs) : null;
    return {
      position:       i + 1,
      entityId:       r.entityId,
      entityType:     r.entityType,
      name:           r.name,
      categoria:      r.categoria,
      totalLaps:      r.totalLaps,
      total:          r.totalLaps,   // alias legacy (live.js, Lap, live-stats)
      avgLapMs:       r.avgLapMs,
      bestLapMs:      r.bestLapMs,
      comaTotal:      +r.comaTotal.toFixed ? +r.comaTotal.toFixed(3) : r.comaTotal,
      lastMangaComa:  +(r.lastMangaComa || 0).toFixed(3),
      mangasRaced:    r.mangasRaced,
      totalTimeMs:    r.totalTimeMs,   // total corregido (settledAvg) — unifica directo/tabla
      remainingMs:    r.remainingMs,
      futureRemMs:    r.futureRemMs,
      onTrack:        r.onTrack,
      provisional:    r.provisional,
      projectedRaw:   r.projectedRaw,
      projectedTotal: r.projectedRaw != null ? +r.projectedRaw.toFixed(1) : null,
      gapV:           gapV     != null ? +gapV.toFixed(2)     : null,
      gapVLeader:     gapVLead != null ? +gapVLead.toFixed(2) : null,
      gapSec:         gapSec,
      gapSecLeader:   gapSecLead,
      avgToCatch,
    };
  });
}

module.exports = { activeMangaOf, raceAggregate, buildRaceProjection };
