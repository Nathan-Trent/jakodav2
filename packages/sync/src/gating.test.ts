import { describe, expect, it } from "vitest";
import { canSeeFinancials, canWrite, evaluateGate, type GateInput, type GatePolicy } from "./gating.js";

const DAY = 86_400;
const policy: GatePolicy = { graceDays: 5, readOnlyDays: 7, mandatorySyncDays: 5, syncWarningDays: 3 };
const syncedAt = new Date("2026-09-01T00:00:00Z");

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    status: "active",
    expiresAt: null,
    elapsedSinceSyncSeconds: 0,
    lastSyncServerTime: syncedAt,
    tokenValid: true,
    policy,
    ...over,
  };
}

describe("evaluateGate — mandatory sync cadence", () => {
  it("is unrestricted just after a sync", () => {
    const d = evaluateGate(input());
    expect(d.level).toBe("full");
    expect(d.reason).toBe("ok");
    expect(d.warn).toBe(false);
  });

  it("warns inside the warning window but does not block", () => {
    const d = evaluateGate(input({ elapsedSinceSyncSeconds: 3 * DAY }));
    expect(d.level).toBe("full");
    expect(d.warn).toBe(true);
    expect(d.reason).toBe("sync_overdue");
    expect(canWrite(d.level)).toBe(true);
  });

  it("drops to read-only once the 5-day limit passes", () => {
    const d = evaluateGate(input({ elapsedSinceSyncSeconds: 5 * DAY + 1 }));
    expect(d.level).toBe("read_only");
    expect(canWrite(d.level)).toBe(false);
    expect(canSeeFinancials(d.level)).toBe(false);
  });

  it("locks fully after the read-only window elapses", () => {
    const d = evaluateGate(input({ elapsedSinceSyncSeconds: (5 + 7) * DAY + 1 }));
    expect(d.level).toBe("locked");
  });
});

describe("evaluateGate — subscription expiry", () => {
  const expiresAt = new Date("2026-09-01T00:00:00Z");

  it("allows full use during the grace period", () => {
    const d = evaluateGate(input({ expiresAt, elapsedSinceSyncSeconds: 2 * DAY }));
    expect(d.level).toBe("full");
    expect(d.warn).toBe(true);
    expect(d.reason).toBe("subscription_expired");
  });

  it("is read-only after grace", () => {
    const d = evaluateGate(input({ expiresAt, elapsedSinceSyncSeconds: 4 * DAY, lastSyncServerTime: new Date("2026-09-03T00:00:00Z") }));
    expect(d.level).toBe("read_only");
    expect(d.reason).toBe("subscription_expired");
  });

  it("locks after grace + read-only window", () => {
    const d = evaluateGate(input({ expiresAt, elapsedSinceSyncSeconds: 1 * DAY, lastSyncServerTime: new Date("2026-09-13T00:00:00Z") }));
    expect(d.level).toBe("locked");
  });

  it("ignores expiry when there is none (pre-billing)", () => {
    const d = evaluateGate(input({ expiresAt: null, elapsedSinceSyncSeconds: 1 * DAY }));
    expect(d.level).toBe("full");
  });

  it("locks immediately when cancelled", () => {
    expect(evaluateGate(input({ status: "cancelled" })).level).toBe("locked");
  });
});

describe("evaluateGate — trust", () => {
  it("treats an unverifiable token as no permission, not as permission", () => {
    const d = evaluateGate(input({ tokenValid: false }));
    expect(d.level).toBe("read_only");
    expect(d.reason).toBe("token_invalid");
  });

  it("gives a never-synced terminal one window, then read-only", () => {
    expect(evaluateGate(input({ lastSyncServerTime: null, elapsedSinceSyncSeconds: DAY })).level).toBe("full");
    expect(evaluateGate(input({ lastSyncServerTime: null, elapsedSinceSyncSeconds: 6 * DAY })).level).toBe("read_only");
  });

  it("applies the stricter of the two clocks", () => {
    // Subscription is fine, but sync is long overdue → locked.
    const d = evaluateGate(input({ expiresAt: null, elapsedSinceSyncSeconds: 20 * DAY }));
    expect(d.level).toBe("locked");
    expect(d.reason).toBe("sync_overdue");
  });
});
