// Seed de prueba para el lector de pilotos por webcam.
// Crea una carrera championship/team (status=active) con una manga pending
// (modo pre-arme) + 4 equipos en 4 carriles, cada uno con 2 pilotos que tienen
// su qr_code DRV:<id>. Todo consistente con el JOIN de DriverShift.findAssignmentsByProfile.
//
// Uso:  node scripts/seed-webcam-test.js
// Limpia un seed previo (mismo nombre de carrera y catálogo marcado).

const db = require('../src/config/database');

const RACE_NAME   = 'PRUEBA WEBCAM QR';
const SEED_MARK   = 'SEED_WEBCAM';

const TEAMS = [
  { name: 'Equipo Rojo',  color: '#e63946', drivers: ['Ana Roja',    'Luis Rojo'] },
  { name: 'Equipo Azul',  color: '#3a86ff', drivers: ['Marta Azul',  'Pau Azul'] },
  { name: 'Equipo Verde', color: '#2ecc71', drivers: ['Eva Verde',   'Iker Verde'] },
  { name: 'Equipo Ámbar', color: '#f4a261', drivers: ['Noa Ámbar',   'Hugo Ámbar'] },
];

const run = db.transaction(() => {
  // ── Limpieza de seed previo ──────────────────────────────────────────────
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
  // Catálogo marcado + sus pilotos
  const prevCats = db.prepare('SELECT id FROM teams_catalog WHERE notes = ?').all(SEED_MARK);
  for (const c of prevCats) {
    const members = db.prepare('SELECT driver_id FROM teams_catalog_members WHERE team_id = ?').all(c.id);
    db.prepare('DELETE FROM teams_catalog_members WHERE team_id = ?').run(c.id);
    for (const m of members) {
      if (m.driver_id) db.prepare('DELETE FROM driver_profiles WHERE id = ?').run(m.driver_id);
    }
    db.prepare('DELETE FROM teams_catalog WHERE id = ?').run(c.id);
  }

  // ── Carrera ──────────────────────────────────────────────────────────────
  const laneSeq = JSON.stringify(TEAMS.map((_, i) => i + 1));
  const raceId = db.prepare(`
    INSERT INTO races (name, type, format, lanes_count, lane_sequence,
                       manga_duration_minutes, status,
                       driver_min_total_ms, driver_max_total_ms, driver_change_lockout_ms)
    VALUES (?, 'championship', 'team', ?, ?, 10, 'active', 60000, 600000, 120000)
  `).run(RACE_NAME, TEAMS.length, laneSeq).lastInsertRowid;

  const tandaId = db.prepare(`INSERT INTO tandas (race_id, number, status) VALUES (?, 1, 'active')`)
    .run(raceId).lastInsertRowid;

  const mangaId = db.prepare(`INSERT INTO mangas (tanda_id, race_id, number, status) VALUES (?, ?, 1, 'pending')`)
    .run(tandaId, raceId).lastInsertRowid;

  const profileInsert = db.prepare(`INSERT INTO driver_profiles (name, category) VALUES (?, ?)`);
  const setQr        = db.prepare(`UPDATE driver_profiles SET qr_code = ? WHERE id = ?`);
  const catInsert    = db.prepare(`INSERT INTO teams_catalog (name, color, notes) VALUES (?, ?, ?)`);
  const memberInsert = db.prepare(`INSERT INTO teams_catalog_members (team_id, driver_id, name, position) VALUES (?, ?, ?, ?)`);
  const teamInsert   = db.prepare(`INSERT INTO teams (race_id, tanda_id, name, lane, color) VALUES (?, ?, ?, ?, ?)`);
  const driverInsert = db.prepare(`INSERT INTO drivers (race_id, tanda_id, team_id, name) VALUES (?, ?, ?, ?)`);
  const laneInsert   = db.prepare(`INSERT INTO manga_lanes (manga_id, lane, team_id, is_rest) VALUES (?, ?, ?, 0)`);

  const cats = ['platino', 'oro', 'plata', 'bronce'];
  const created = [];

  TEAMS.forEach((team, ti) => {
    const lane  = ti + 1;
    const catId = catInsert.run(team.name, team.color, SEED_MARK).lastInsertRowid;
    const teamId = teamInsert.run(raceId, tandaId, team.name, lane, team.color).lastInsertRowid;
    laneInsert.run(mangaId, lane, teamId);

    team.drivers.forEach((dname, di) => {
      const cat = cats[(ti + di) % cats.length];
      const profId = profileInsert.run(dname, cat).lastInsertRowid;
      const qr = `DRV:${profId}`;
      setQr.run(qr, profId);
      memberInsert.run(catId, profId, dname, di);
      driverInsert.run(raceId, tandaId, teamId, dname);
      created.push({ team: team.name, lane, driver: dname, category: cat, qr });
    });
  });

  return { raceId, mangaId, created };
});

const out = run();
console.log(`\n✅ Carrera "${RACE_NAME}" creada (race_id=${out.raceId}, manga_id=${out.mangaId}, status manga=pending → pre-arme)\n`);
console.log('Pilotos y sus QR (escanéalos con la webcam):');
console.log('────────────────────────────────────────────────────────');
out.created.forEach(p => {
  console.log(`  L${p.lane}  ${p.qr.padEnd(8)}  ${p.driver.padEnd(14)} ${p.team}  [${p.category}]`);
});
console.log('────────────────────────────────────────────────────────');
console.log('\nHoja imprimible de QR:  http://localhost:3000/drivers/qr-all');
console.log('Panel de control:       http://localhost:3000/control/shifts\n');
