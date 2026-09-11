import { describe, expect, it } from "vitest";
import { anomalyReport, elapsedSinceSync, emptyClockState, markSynced, resume, tick } from "./clock.js";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const DAY_MS = 86_400_000;
const synced = () => markSynced(emptyClockState(), "2026-09-01T00:00:00Z", T0);

describe("clock — defensible elapsed time", () => {
  it("counts forward from a sync using the wall clock when it is honest", () => {
    let s = synced();
    // Ticks a minute apart for an hour.
    for (let i = 1; i <= 60; i++) s = tick(s, 60, T0 + i * 60_000);
    expect(elapsedSinceSync(s)).toBeCloseTo(3600, 0);
  });

  it("ignores a system clock wound backwards, and flags it", () => {
    let s = synced();
    for (let i = 1; i <= 48; i++) s = tick(s, 3600, T0 + i * 3600_000); // two honest days
    const before = elapsedSinceSync(s);
    s = tick(s, 60, T0 - 30 * DAY_MS);                                  // clock yanked back a month
    expect(elapsedSinceSync(s)).toBeGreaterThanOrEqual(before);
    expect(s.lastAnomalySeconds).toBeGreaterThan(0);
  });

  it("uses the monotonic accumulator when the wall clock stands still", () => {
    let s = synced();
    for (let i = 0; i < 48; i++) s = tick(s, 3600, T0); // clock frozen, real time passing
    expect(elapsedSinceSync(s)).toBeCloseTo(48 * 3600, 0);
  });

  it("does not let one wild forward clock set poison the ratchet", () => {
    let s = synced();
    s = tick(s, 60, T0 + 60_000);
    s = tick(s, 60, Date.parse("2099-01-01T00:00:00Z")); // clock set to 2099 in-session
    // Advances only by measured time, and says so.
    expect(elapsedSinceSync(s)).toBeLessThan(600);
    expect(s.lastAnomalySeconds).toBeGreaterThan(86_400);
  });

  it("counts time the app spent closed via resume()", () => {
    let s = synced();
    s = tick(s, 60, T0 + 60_000);       // ran for a minute, then closed
    s = resume(s, T0 + 6 * DAY_MS);      // reopened six days later
    expect(elapsedSinceSync(s)).toBeGreaterThan(5 * 86_400);
  });

  it("refuses a backwards clock on resume too", () => {
    let s = synced();
    for (let i = 1; i <= 48; i++) s = tick(s, 3600, T0 + i * 3600_000);
    const before = elapsedSinceSync(s);
    s = resume(s, T0 - 10 * DAY_MS);
    expect(elapsedSinceSync(s)).toBeGreaterThanOrEqual(before);
    expect(s.lastAnomalySeconds).toBeGreaterThan(0);
  });

  it("clamps absurd deltas rather than trusting them", () => {
    const s = tick(synced(), 999_999, T0);
    expect(s.accumulatedSeconds).toBe(3600);
  });

  it("resets on a fresh sync, clearing any poisoned high-water mark", () => {
    let s = synced();
    for (let i = 1; i <= 120; i++) s = tick(s, 3600, T0 + i * 3600_000);
    expect(elapsedSinceSync(s)).toBeGreaterThan(4 * 86_400);
    s = markSynced(s, "2026-09-06T00:00:00Z", T0 + 5 * DAY_MS);
    expect(elapsedSinceSync(s)).toBe(0);
    expect(s.lastAnomalySeconds).toBeNull();
  });

  it("reports both measures so the server can log divergence", () => {
    let s = markSynced(emptyClockState(), "2026-09-01T00:00:00Z", Date.now());
    s = tick(s, 3600, Date.now());
    s = tick(s, 3600, Date.now());
    const r = anomalyReport(s);
    expect(r.monotonic_seconds).toBeCloseTo(7200, -1);
    expect(r.wall_clock_seconds).toBeGreaterThanOrEqual(0);
  });
});
