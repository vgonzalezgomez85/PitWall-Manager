// Seed de PREVIEW para ver el control de pilotos con muchos equipos.
// Crea una carrera championship/team (status=active) con una manga ACTIVE
// (para que ControlController la detecte por delante de otras) con N equipos
// en N carriles, 2 pilotos por equipo, y siembra turnos (driver_shifts) con
// variedad de tiempos y nº de turnos para que se vean barras y badges.
//
// Uso:  node scripts/seed-preview-teams.js [N]      (N = nº de equipos, def. 27)
// Borra cualquier preview anterior (mismo nombre de carrera + catálogo marcado).

const db = require('../src/config/database');

const TEAM_COUNT = Math.max(1, Math.min(64, parseInt(process.argv[2], 10) || 27));
// Carriles disponibles. Si hay más equipos que carriles, los sobrantes DESCANSAN.
const LANES      = Math.max(1, Math.min(TEAM_COUNT, parseInt(process.argv[3], 10) || Math.min(TEAM_COUNT, 24)));
const RACE_NAME  = 'PREVIEW EQUIPOS';
const SEED_MARK  = 'SEED_PREVIEW';
const NOW        = Date.now();

// Paleta por tono HSL → color distinto por equipo.
function color(i, n) {
  const h = Math.round((360 * i) / n);
  return `hsl(${h}, 70%, 52%)`;
}

const run = db.transaction(() => {
  // ── Limpieza de preview previo ───────────────────────────────────────────
  const prev = db.prepare('SELECT id FROM races WHERE name = ?').all(RACE_NAME);
  for (const r of prev) {
    db.prepare('DELETE FROM manga_lanes WHERE manga_id IN (SELECT id FROM mangas WHERE race_id = ?)').run(r.id);
    db.prepare('DELETE FROM driver_shifts WHERE race_id = ?').run(r.id);
    db.prepare('DELETE FROM mangas WHERE race_id = ?').run(r.id);
    db.prepare('DELETE FROM drivers WHERE race_id = ?').run(r.id);
    db.prepare('DELETE FROM teams WHERE race_id = ?').run(r.id);
    db.prepare('DELETE FROM tandas WHERE race_id = ?').run(r.id);
    db.prepare('DELETE FROM races WHERE id = ?').run(r.id);
  }
  const prevCats = db.prepare('SELECT id FROM teams_catalog WHERE notes = ?').all(SEED_MARK);
  for (const c of prevCats) {
    const members = db.prepare('SELECT driver_id FROM teams_catalog_members WHERE team_id = ?').all(c.id);
    db.prepare('DELETE FROM teams_catalog_members WHERE team_id = ?').run(c.id);
    for (const m of members) if (m.driver_id) db.prepare('DELETE FROM driver_profiles WHERE id = ?').run(m.driver_id);
    db.prepare('DELETE FROM teams_catalog WHERE id = ?').run(c.id);
  }

  // ── Carrera (manga ACTIVE para que el panel la detecte) ──────────────────
  const laneSeq = JSON.stringify(Array.from({ length: LANES }, (_, i) => i + 1));
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, lanes_count, lane_sequence,
                       manga_duration_minutes, status,
                       driver_min_total_ms, driver_max_total_ms,
                       driver_change_lockout_ms, driver_max_runs)
    VALUES (?, 'championship', 'team', ?, ?, 10, 'active', 60000, 600000, 120000, 4)
  `).run(RACE_NAME, LANES, laneSeq).lastInsertRowid;

  const tandaId = db.prepare(`INSERT INTO tandas (race_id, number, status) VALUES (?, 1, 'active')`).run(raceId).lastInsertRowid;
  const mangaId = db.prepare(`INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, 1, 'active')`).run(tandaId, raceId).lastInsertRowid;

  const profileInsert = db.prepare(`INSERT INTO driver_profiles (name, category) VALUES (?, ?)`);
  const setQr        = db.prepare(`UPDATE driver_profiles SET qr_code = ? WHERE id = ?`);
  const catInsert    = db.prepare(`INSERT INTO teams_catalog (name, color, notes) VALUES (?, ?, ?)`);
  const memberInsert = db.prepare(`INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES (?, ?, ?, ?)`);
  const teamInsert   = db.prepare(`INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, ?, ?)`);
  const driverInsert = db.prepare(`INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, ?)`);
  const laneInsert   = db.prepare(`INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, ?, ?, ?)`);
  const shiftInsert  = db.prepare(`
    INSERT INTO driver_shifts (manga_id, race_id, lane, team_id, driver_id, driver_name, started_at_ms, ended_at_ms, pre_armed, driving_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);

  const cats = ['platino', 'oro', 'plata', 'bronce'];
  // Tiempo TOTAL por piloto (s) → barrido para ver badges sobre min=1min/max=10min:
  // 40s (bajo mín) · 2:30 (ok) · 5:00 (ok) · 9:05 (90%+) · 10:20 (pasado).
  const TIME_SPREAD = [40, 150, 300, 545, 620];
  let pilotSeq = 0;
  let totalPilots = 0;

  let restCount = 0;
  for (let ti = 0; ti < TEAM_COUNT; ti++) {
    const isRest   = ti >= LANES;                      // equipos sobrantes → descansan
    const lane     = isRest ? 0 : ti + 1;              // descanso = lane 0
    if (isRest) restCount++;
    const teamName = `Equipo ${String(ti + 1).padStart(2, '0')}`;
    const col      = color(ti, TEAM_COUNT);
    const catId    = catInsert.run(teamName, col, SEED_MARK).lastInsertRowid;
    const teamId   = teamInsert.run(raceId, tandaId, teamName, lane, col).lastInsertRowid;
    laneInsert.run(mangaId, lane, teamId, isRest ? 1 : 0);

    // 4-5 pilotos por equipo (media 4,5), nombres únicos (el resumen une por nombre).
    const nP = 4 + (ti % 2);                            // 4 ó 5
    const drivers = Array.from({ length: nP }, (_, p) => `Piloto ${ti + 1}-${p + 1}`);
    const driverIds = drivers.map((dname, p) => {
      const cat    = cats[(ti + p) % cats.length];
      const profId = profileInsert.run(dname, cat).lastInsertRowid;
      setQr.run(`DRV:${profId}`, profId);
      memberInsert.run(catId, profId, dname, p);
      return driverInsert.run(raceId, tandaId, teamId, dname).lastInsertRowid;
    });
    totalPilots += nP;

    // Los equipos que descansan no corren esta manga → sin turnos (su roster
    // sale a 0). Sirve para probar el bloqueo de fichaje por descanso.
    if (isRest) continue;

    // Cada piloto da 1-3 turnos (varía runs_count); todos corren al menos una
    // vez (salen en el resumen). Construimos la lista de turnos en orden
    // cronológico y dejamos el ÚLTIMO abierto = piloto actual en pista.
    const stints = [];
    drivers.forEach((_, p) => {
      const totalMs  = TIME_SPREAD[pilotSeq % TIME_SPREAD.length] * 1000;
      const nStints  = 1 + (pilotSeq % 3);              // 1,2,3
      pilotSeq++;
      const perMs = Math.round(totalMs / nStints);
      for (let k = 0; k < nStints; k++) stints.push({ p, ms: perMs });
    });
    const totalTeamMs = stints.reduce((a, s) => a + s.ms, 0);
    let cursor = NOW - totalTeamMs;
    stints.forEach((s, idx) => {
      const isLast = idx === stints.length - 1;
      const start  = cursor;
      const end    = isLast ? null : cursor + s.ms;
      shiftInsert.run(mangaId, raceId, lane, teamId, driverIds[s.p], drivers[s.p],
                      start, end, isLast ? Math.max(0, NOW - start) : s.ms);
      cursor += s.ms;
    });
  }
  return { raceId, mangaId, totalPilots, restCount };
});

const out = run();
console.log(`\n✅ Preview "${RACE_NAME}": ${TEAM_COUNT} equipos · ${LANES} carriles · ${out.restCount} descansan · ${out.totalPilots} pilotos (media ${(out.totalPilots / TEAM_COUNT).toFixed(1)}/equipo). race_id=${out.raceId}, manga_id=${out.mangaId}, manga=active.`);
console.log('   Panel de control:  http://localhost:3000/control/shifts\n');
