/**
 * SYNC: defensible elapsed time (TRD §7).
 *
 * The problem: the app must know how long it has been since its last sync,
 * and it must not be fooled by someone winding the system clock back to dodge
 * an expiry. So the system clock is never trusted on its own.
 *
 * Two independent measures, and we take the LARGER:
 *
 *   1. A monotonic accumulator. `performance.now()` only counts forward and
 *      is immune to the system date. We add each tick's delta to a persisted
 *      total, so the count survives restarts even though the timer itself
 *      resets. Changing the clock cannot reduce it.
 *
 *   2. A wall-clock ratchet, measured from the sync anchor. We persist the
 *      furthest the clock has read since the last sync. If it now reads
 *      earlier, it was moved backwards — we keep the high-water mark.
 *
 * Taking the larger means neither trick helps: closing the app doesn't stop
 * the wall ratchet, and winding the clock back doesn't stop the accumulator.
 *
 * Two situations that look identical but are not, and why there are two
 * entry points:
 *
 *   - `tick()` runs every few seconds while the app is open. Between two of
 *     those, real time barely moves, so a large forward jump is the clock
 *     being changed — we advance only by the monotonic delta and flag it.
 *     Without this, setting the clock to 2099 once would poison the ratchet
 *     and lock the terminal permanently with no way back.
 *   - `resume()` runs once at startup. The jump since the last tick IS
 *     legitimate — it is the time the app spent closed, which is exactly what
 *     the ratchet exists to capture — so it is accepted.
 *
 * Known limit, stated plainly: time while the app is closed AND the clock is
 * wound back is under-counted — the accumulator cannot see it and the ratchet
 * refuses it. The under-count is bounded by how long they keep the app shut,
 * and the divergence is reported on the next sync (clock_anomalies), which is
 * what TRD §7 asks for. A locked terminal always recovers by syncing.
 */

export interface ClockState {
  /** Server time at the last successful sync (ISO). The anchor of truth. */
  lastSyncServerTime: string | null;
  /** Wall clock as this device read it at that moment (ms). */
  lastSyncWallMs: number | null;
  /** Monotonic seconds accumulated since that sync. Only ever increases. */
  accumulatedSeconds: number;
  /** Furthest the wall clock has read since the sync anchor (ms). */
  maxWallSinceSyncMs: number | null;
  /** Seconds of backwards (or suspicious forward) clock movement seen. */
  lastAnomalySeconds: number | null;
}

/** A forward jump larger than this between two in-session ticks is the clock
 *  being changed, not time passing. Generous enough to survive a laptop sleep
 *  that the timer failed to account for. */
const IN_SESSION_JUMP_TOLERANCE_S = 900;

export function emptyClockState(): ClockState {
  return {
    lastSyncServerTime: null,
    lastSyncWallMs: null,
    accumulatedSeconds: 0,
    maxWallSinceSyncMs: null,
    lastAnomalySeconds: null,
  };
}

/**
 * Fold an in-session tick into the state. `monotonicDeltaSeconds` is what this
 * process observed passing since the previous tick, from performance.now().
 */
export function tick(state: ClockState, monotonicDeltaSeconds: number, nowMs = Date.now()): ClockState {
  const delta = Number.isFinite(monotonicDeltaSeconds) && monotonicDeltaSeconds > 0
    ? Math.min(monotonicDeltaSeconds, 3600)
    : 0;

  const accumulated = state.accumulatedSeconds + delta;
  const prevMax = state.maxWallSinceSyncMs;

  let maxWall = prevMax;
  let anomaly = state.lastAnomalySeconds;

  if (prevMax === null) {
    maxWall = nowMs;
  } else {
    const jumpS = (nowMs - prevMax) / 1000;
    if (jumpS < 0) {
      // Wound backwards: hold the high-water mark, record how far.
      anomaly = Math.round(-jumpS);
    } else if (jumpS > delta + IN_SESSION_JUMP_TOLERANCE_S) {
      // Jumped forward further than real time could have moved in-session.
      // Advance only by what we measured, and flag the difference.
      maxWall = prevMax + delta * 1000;
      anomaly = Math.round(jumpS - delta);
    } else {
      maxWall = nowMs;
    }
  }

  return { ...state, accumulatedSeconds: accumulated, maxWallSinceSyncMs: maxWall, lastAnomalySeconds: anomaly };
}

/**
 * Called once when the app starts. The gap since the last tick is time the
 * app spent closed — legitimate, and the whole reason the ratchet exists.
 */
export function resume(state: ClockState, nowMs = Date.now()): ClockState {
  if (state.maxWallSinceSyncMs === null) {
    return { ...state, maxWallSinceSyncMs: nowMs };
  }
  if (nowMs < state.maxWallSinceSyncMs) {
    return { ...state, lastAnomalySeconds: Math.round((state.maxWallSinceSyncMs - nowMs) / 1000) };
  }
  return { ...state, maxWallSinceSyncMs: nowMs };
}

/** Elapsed seconds since the last sync that we are willing to defend. */
export function elapsedSinceSync(state: ClockState): number {
  const byWall = state.lastSyncWallMs !== null && state.maxWallSinceSyncMs !== null
    ? Math.max(0, (state.maxWallSinceSyncMs - state.lastSyncWallMs) / 1000)
    : 0;
  return Math.max(state.accumulatedSeconds, byWall);
}

/** Reset the counters against a fresh, server-stamped sync. */
export function markSynced(state: ClockState, serverTimeIso: string, nowMs = Date.now()): ClockState {
  return {
    lastSyncServerTime: serverTimeIso,
    lastSyncWallMs: nowMs,
    accumulatedSeconds: 0,
    // Fresh anchor: whatever the clock did before this sync is now irrelevant,
    // so a poisoned high-water mark cannot survive a successful sync.
    maxWallSinceSyncMs: nowMs,
    lastAnomalySeconds: null,
  };
}

/**
 * What we report to the server so it can log divergence (TRD §7).
 * Both numbers describe the same interval measured two different ways.
 */
export function anomalyReport(state: ClockState): { monotonic_seconds: number; wall_clock_seconds: number } {
  const wall = state.lastSyncWallMs === null ? 0 : Math.max(0, (Date.now() - state.lastSyncWallMs) / 1000);
  return {
    monotonic_seconds: Math.round(state.accumulatedSeconds),
    wall_clock_seconds: Math.round(wall),
  };
}
