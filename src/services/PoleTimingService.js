const SerialService = require('./SerialService');
const SocketService = require('./SocketService');
const PoleSession   = require('../models/PoleSession');

const DEBOUNCE_MS = 2000; // ignore crossings closer than 2s (false triggers)

class PoleTimingServiceClass {
  constructor() {
    this.session     = null;   // active participant session
    this._lapHandler = null;
    this._tickInt    = null;
    this._stopTimer  = null;
  }

  // Start timing for the current participant
  start({ poleSessionId, entryId, entryName, poleLane, durationMs }) {
    if (this.session) this.stop(false);

    const startTime = Date.now();
    this.session = {
      poleSessionId, entryId, entryName, poleLane,
      startTime, durationMs,
      lapCount:     0,
      bestLapMs:    null,
      lastCrossing: startTime,
    };

    // Listen to SerialService but filter to the pole lane only
    this._lapHandler = ({ lane, timestamp, lapTimeMs }) => {
      if (lane !== poleLane) return;
      this._onCrossing(timestamp, lapTimeMs);
    };
    SerialService.on('lane_crossing', this._lapHandler);

    // Tick every 500ms for a smooth countdown
    this._tickInt = setInterval(() => {
      const elapsedMs   = Date.now() - startTime;
      const remainingMs = Math.max(0, durationMs - elapsedMs);
      SocketService.emit('pole:tick', { elapsedMs, remainingMs });
      if (remainingMs <= 0) {
        clearInterval(this._tickInt);
        this._tickInt = null;
        this.stop(true); // auto-stop
      }
    }, 500);

    SocketService.emit('pole:started', { entryName, durationMs, poleLane });
    console.log(`[PoleTimingService] Started for "${entryName}" on lane ${poleLane} — ${durationMs / 60000}min`);
  }

  _onCrossing(timestamp, lapTimeMs) {
    if (!this.session) return;
    if (lapTimeMs === null) {
      // First crossing marker from DS-300 — no valid time yet, just update ref
      this.session.lastCrossing = timestamp;
      return;
    }

    const s = this.session;
    const elapsed = timestamp - s.lastCrossing;

    // Debounce: ignore if the gap since last crossing is too short
    if (elapsed < DEBOUNCE_MS && s.lapCount > 0) return;

    s.lapCount++;
    s.lastCrossing = timestamp;
    const improved = !s.bestLapMs || lapTimeMs < s.bestLapMs;
    if (improved) s.bestLapMs = lapTimeMs;

    const elapsedMs = timestamp - s.startTime;
    SocketService.emit('pole:lap', {
      lapNumber: s.lapCount,
      lapTimeMs,
      bestLapMs: s.bestLapMs,
      elapsedMs,
      improved,
    });

    console.log(`[PoleTimingService] Lap ${s.lapCount} — ${lapTimeMs}ms${improved ? ' ★ best' : ''}`);
  }

  // Stop timing (auto=true when timer expired, false when user stopped manually)
  stop(auto = false) {
    if (!this.session) return null;

    clearInterval(this._tickInt);
    this._tickInt = null;

    if (this._lapHandler) {
      SerialService.off('lane_crossing', this._lapHandler);
      this._lapHandler = null;
    }

    const { poleSessionId, entryId, entryName, bestLapMs, lapCount } = this.session;

    // Persist best lap to DB
    PoleSession.updateEntryTime(entryId, bestLapMs ?? null);

    SocketService.emit('pole:finished', { entryName, bestLapMs, lapCount, auto });
    console.log(`[PoleTimingService] Finished "${entryName}" — best: ${bestLapMs ?? 'no time'}`);

    this.session = null;
    return { bestLapMs, lapCount };
  }

  get isRunning()       { return this.session !== null; }
  get currentEntryId()  { return this.session?.entryId ?? null; }
  get currentBestLap()  { return this.session?.bestLapMs ?? null; }
}

module.exports = new PoleTimingServiceClass();
