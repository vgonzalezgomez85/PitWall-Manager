// One-off: simulate complete race 6 with realistic laps and finish all mangas.
// Usage: node scripts/simulate-race-6.js

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'database', 'slotime.db'));

const RACE_ID = 6;
const MANGA_DURATION_MS = 5 * 60 * 1000; // 5 min per manga
const MIN_LAP_MS = 8500;
const BASE_LAP_MS = 10500;   // average
const LAP_JITTER = 1500;     // ±1.5s
const EXIT_CHANCE = 0.04;    // 4% chance of an exit lap
const EXIT_EXTRA_MS = 4000;  // exits take ~4s longer

const race = db.prepare('SELECT * FROM races WHERE id=?').get(RACE_ID);
if (!race) { console.error('Race not found'); process.exit(1); }

const mangas = db.prepare('SELECT * FROM mangas WHERE race_id=? ORDER BY number').all(RACE_ID);

// Wipe any prior laps for race 6 so re-runs are idempotent
db.prepare('DELETE FROM laps WHERE race_id=?').run(RACE_ID);

const insertLap = db.prepare(`
  INSERT INTO laps (race_id, manga_id, driver_id, team_id, lane, lap_number, lap_time_ms, elapsed_ms, is_exit, is_ghost, timestamp)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)
`);
const updateManga = db.prepare(`UPDATE mangas SET status='finished', started_at=?, finished_at=? WHERE id=?`);

let raceStart = new Date('2026-05-15T08:00:00Z').getTime();
const GAP_BETWEEN_MANGAS_MS = 90 * 1000; // 90s setup gap

const tx = db.transaction(() => {
  for (const manga of mangas) {
    const slots = db.prepare(
      `SELECT * FROM manga_lanes WHERE manga_id=? AND is_rest=0 AND driver_id IS NOT NULL`
    ).all(manga.id);

    const mangaStart = raceStart;
    const mangaEnd   = mangaStart + MANGA_DURATION_MS;

    for (const slot of slots) {
      // First crossing: small offset 800-2500ms from start (warm-up out lap)
      let elapsed = 800 + Math.floor(Math.random() * 1700);
      let lapNum = 1;
      insertLap.run(
        RACE_ID, manga.id, slot.driver_id, slot.lane,
        lapNum, elapsed, elapsed, 0,
        new Date(mangaStart + elapsed).toISOString()
      );

      while (true) {
        let lapMs = BASE_LAP_MS + Math.floor((Math.random() - 0.5) * 2 * LAP_JITTER);
        if (lapMs < MIN_LAP_MS + 100) lapMs = MIN_LAP_MS + 100;
        let isExit = 0;
        if (Math.random() < EXIT_CHANCE) {
          lapMs += EXIT_EXTRA_MS + Math.floor(Math.random() * 3000);
          isExit = 1;
        }
        const nextElapsed = elapsed + lapMs;
        if (nextElapsed > MANGA_DURATION_MS) break;
        elapsed = nextElapsed;
        lapNum++;
        insertLap.run(
          RACE_ID, manga.id, slot.driver_id, slot.lane,
          lapNum, lapMs, elapsed, isExit,
          new Date(mangaStart + elapsed).toISOString()
        );
      }
    }

    updateManga.run(
      new Date(mangaStart).toISOString(),
      new Date(mangaEnd).toISOString(),
      manga.id
    );

    raceStart = mangaEnd + GAP_BETWEEN_MANGAS_MS;
  }

  // Finish tandas + race
  db.prepare(`UPDATE tandas SET status='finished' WHERE race_id=?`).run(RACE_ID);
  db.prepare(`UPDATE races SET status='finished', finished_at=? WHERE id=?`)
    .run(new Date(raceStart).toISOString(), RACE_ID);
});

tx();

const counts = db.prepare(`
  SELECT m.number AS manga, COUNT(l.id) AS laps, COUNT(DISTINCT l.driver_id) AS drivers
  FROM mangas m LEFT JOIN laps l ON l.manga_id=m.id
  WHERE m.race_id=? GROUP BY m.id ORDER BY m.number
`).all(RACE_ID);
console.log('Race 6 simulated:');
counts.forEach(r => console.log(`  Manga ${r.manga}: ${r.laps} laps across ${r.drivers} drivers`));
console.log('Race status:', db.prepare('SELECT status FROM races WHERE id=?').get(RACE_ID).status);
