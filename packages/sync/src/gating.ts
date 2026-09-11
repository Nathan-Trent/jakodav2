/**
 * SYNC: progressive gating (TRD §7, locked).
 *
 * Two independent clocks can gate a terminal, and the STRICTER one wins:
 *
 *   1. Subscription expiry  → grace (full use) → read-only → locked
 *   2. Mandatory sync       → warn → (past the limit) read-only → locked
 *
 * Both are evaluated against *elapsed time we can defend* (see clock.ts), not
 * the system clock, because the system clock is the thing being cheated.
 *
 * This module is deliberately pure: inputs in, decision out. It is the piece
 * most likely to be argued about later, so it is the piece that must be
 * readable and testable without a database, a device, or a network.
 */

export type GateLevel = "full" | "read_only" | "locked";

export interface GatePolicy {
  /** Days of normal use after subscription expiry (TRD §7 default 5). */
  graceDays: number;
  /** Days of read-only after grace, before fully locked (§5.1 setting). */
  readOnlyDays: number;
  /** A terminal must sync at least this often (TRD §7: 5 days). */
  mandatorySyncDays: number;
  /** Start warning this many days before the mandatory-sync limit. */
  syncWarningDays: number;
}

export interface GateInput {
  /** Subscription status from the last verified token. */
  status: "active" | "past_due" | "cancelled";
  /** Subscription expiry, or null for no expiry (pre-billing). */
  expiresAt: Date | null;
  /** Defensible elapsed seconds since the last successful sync (clock.ts). */
  elapsedSinceSyncSeconds: number;
  /** Server time at the last successful sync. Anchor for expiry maths. */
  lastSyncServerTime: Date | null;
  /** False when the token failed signature/shape checks, or there is none. */
  tokenValid: boolean;
  policy: GatePolicy;
}

export interface GateDecision {
  level: GateLevel;
  /** Primary cause, for the message shown to the user. */
  reason: "ok" | "never_synced" | "sync_overdue" | "subscription_expired" | "subscription_cancelled" | "token_invalid";
  /** Plain-language headline. */
  title: string;
  /** What the user can do about it. */
  action: string;
  /** Whole days until the next escalation, when one is coming. */
  daysUntilNextStep: number | null;
  /** True when the user should be warned but nothing is blocked yet. */
  warn: boolean;
}

const DAY = 86_400;

export function evaluateGate(input: GateInput): GateDecision {
  const { policy } = input;

  // No sync ever completed: the terminal has never been told what it may do.
  // It gets one mandatory-sync window to get online, then it is read-only.
  if (!input.lastSyncServerTime) {
    const overdue = input.elapsedSinceSyncSeconds > policy.mandatorySyncDays * DAY;
    return overdue
      ? gate("read_only", "never_synced", "This terminal has never synced",
             "Connect to the internet and sign in to activate it.", null, false)
      : gate("full", "never_synced", "Not synced yet",
             "Connect to the internet soon so this terminal stays active.",
             daysLeft(policy.mandatorySyncDays * DAY - input.elapsedSinceSyncSeconds), true);
  }

  // A token we cannot verify is treated as absent, not as permission.
  if (!input.tokenValid) {
    return gate("read_only", "token_invalid", "Subscription can't be verified",
                "Connect to the internet so this terminal can check its subscription.", null, false);
  }

  if (input.status === "cancelled") {
    return gate("locked", "subscription_cancelled", "Subscription cancelled",
                "Renew from the web dashboard, then sync this terminal.", null, false);
  }

  // --- 1. Subscription expiry ------------------------------------------------
  // "Now" is the last server time we trust, plus time we can defend.
  const now = new Date(input.lastSyncServerTime.getTime() + input.elapsedSinceSyncSeconds * 1000);
  let subDecision: GateDecision | null = null;
  if (input.expiresAt) {
    const pastExpiry = (now.getTime() - input.expiresAt.getTime()) / 1000;
    if (pastExpiry > 0) {
      const graceEnds = policy.graceDays * DAY;
      const readOnlyEnds = graceEnds + policy.readOnlyDays * DAY;
      if (pastExpiry < graceEnds) {
        subDecision = gate("full", "subscription_expired", "Subscription expired",
          "Renew to avoid interruption — this terminal keeps working for now.",
          daysLeft(graceEnds - pastExpiry), true);
      } else if (pastExpiry < readOnlyEnds) {
        subDecision = gate("read_only", "subscription_expired", "Subscription expired",
          "Renew from the web dashboard, then sync. You can still see stock and past sales.",
          daysLeft(readOnlyEnds - pastExpiry), false);
      } else {
        subDecision = gate("locked", "subscription_expired", "Subscription expired",
          "Renew from the web dashboard, then sync this terminal.", null, false);
      }
    }
  }

  // --- 2. Mandatory sync cadence --------------------------------------------
  const since = input.elapsedSinceSyncSeconds;
  const limit = policy.mandatorySyncDays * DAY;
  const lockAt = limit + policy.readOnlyDays * DAY;
  let syncDecision: GateDecision | null = null;
  if (since >= lockAt) {
    syncDecision = gate("locked", "sync_overdue", "This terminal hasn't synced in too long",
      "Connect to the internet to unlock it.", null, false);
  } else if (since >= limit) {
    syncDecision = gate("read_only", "sync_overdue", "Sync overdue",
      "Connect to the internet to start selling again. Stock and history stay visible.",
      daysLeft(lockAt - since), false);
  } else if (since >= (policy.mandatorySyncDays - policy.syncWarningDays) * DAY) {
    syncDecision = gate("full", "sync_overdue", "Sync soon",
      `This terminal must connect within ${daysLeft(limit - since) ?? 1} day(s) to keep selling.`,
      daysLeft(limit - since), true);
  }

  // Strictest wins; among equals, prefer the one that blocks something.
  const candidates = [subDecision, syncDecision].filter((d): d is GateDecision => d !== null);
  if (candidates.length === 0) {
    return gate("full", "ok", "Up to date", "", null, false);
  }
  candidates.sort((a, b) => rank(b.level) - rank(a.level) || Number(a.warn) - Number(b.warn));
  return candidates[0]!;
}

function rank(l: GateLevel): number {
  return l === "locked" ? 2 : l === "read_only" ? 1 : 0;
}

function daysLeft(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.ceil(seconds / DAY));
}

function gate(
  level: GateLevel, reason: GateDecision["reason"], title: string, action: string,
  daysUntilNextStep: number | null, warn: boolean,
): GateDecision {
  return { level, reason, title, action, daysUntilNextStep, warn };
}

/** Writes are blocked at read_only and above (TRD §7). */
export function canWrite(level: GateLevel): boolean {
  return level === "full";
}

/**
 * TRD §7: during read-only, tax numbers and reports are hidden too — only
 * stock levels and sales/purchase history stay visible.
 */
export function canSeeFinancials(level: GateLevel): boolean {
  return level === "full";
}
