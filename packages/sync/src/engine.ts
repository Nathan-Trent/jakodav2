import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anomalyReport, elapsedSinceSync, emptyClockState, markSynced as markClockSynced,
  resume as resumeClock, tick as tickClock, type ClockState,
} from "./clock.js";
import { evaluateGate, type GateDecision, type GatePolicy } from "./gating.js";
import { verifySubscriptionToken, type SubscriptionPayload } from "./token.js";
import { markFailed, markSynced as markEntrySynced, oldestPendingAt, pending, prune } from "./queue.js";

/**
 * SYNC: the engine. Owns the clock state, drains the outbox, refreshes the
 * subscription token, and publishes one `SyncStatus` the UI renders.
 *
 * Everything it decides is derived from persisted state, so closing the app
 * mid-sync loses nothing: the outbox is durable and replays are idempotent.
 */

const CLOCK_KEY = "zogal.sync.clock";
const TOKEN_KEY = "zogal.sync.token";
const TICK_MS = 30_000;

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  oldestPendingAt: Date | null;
  lastSyncAt: Date | null;
  gate: GateDecision;
  subscription: SubscriptionPayload | null;
  /** Conflicts raised by the most recent drain — surfaced, never resolved here. */
  newConflicts: number;
  clockAnomalySeconds: number | null;
}

/** Used until a token has ever been seen, so a fresh install is not punished
 *  for the server's silence. Matches the migration's defaults. */
const FALLBACK_POLICY: GatePolicy = {
  graceDays: 5, readOnlyDays: 7, mandatorySyncDays: 5, syncWarningDays: 3,
};

export interface EngineOptions {
  db: SupabaseClient;
  shopId: string;
  deviceId: string;
  credential: string;
  userId: string;
  /** Ed25519 public key (base64) shipped with the app. */
  publicKeyB64: string;
  /** Supabase project URL, for the signing Edge Function. */
  functionsUrl: string;
  anonKey: string;
  onStatus: (s: SyncStatus) => void;
}

export class SyncEngine {
  private clock: ClockState;
  private token: string | null;
  private payload: SubscriptionPayload | null = null;
  private tokenValid = false;
  private timer: number | null = null;
  private lastTickMs = 0;
  private syncing = false;
  private newConflicts = 0;
  private stopped = false;

  constructor(private readonly o: EngineOptions) {
    this.clock = loadClock();
    this.token = safeGet(TOKEN_KEY);
  }

  async start(): Promise<void> {
    // Startup: the gap since the last tick is time the app spent closed.
    this.clock = resumeClock(this.clock);
    saveClock(this.clock);
    this.lastTickMs = performance.now();

    // A failed first refresh (offline, or the server ahead of/behind the app)
    // must not abort startup: the timer below is what retries, and without it
    // sync would be dead for the life of the process.
    try {
      await this.refreshToken();
    } catch {
      await this.verifyLocally();   // fall back to whatever token we already hold
    }
    this.publish();

    this.timer = window.setInterval(() => void this.onTick(), TICK_MS);
    window.addEventListener("online", this.onOnline);
    void this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) window.clearInterval(this.timer);
    window.removeEventListener("online", this.onOnline);
  }

  private onOnline = () => { void this.syncNow(); };

  private async onTick(): Promise<void> {
    const now = performance.now();
    const deltaS = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    this.clock = tickClock(this.clock, deltaS);
    saveClock(this.clock);

    // Re-check the token locally: it can expire while offline.
    await this.verifyLocally();
    this.publish();

    if (navigator.onLine) void this.syncNow();
  }

  /** Drain the outbox, then refresh the token. Safe to call repeatedly. */
  async syncNow(): Promise<void> {
    if (this.syncing || this.stopped || !navigator.onLine) return;
    this.syncing = true;
    this.newConflicts = 0;
    this.publish();
    try {
      await this.drain();
      await this.refreshToken();
      await prune();
    } catch {
      // Offline or server down: the queue is durable, we try again next tick.
    } finally {
      this.syncing = false;
      this.publish();
    }
  }

  /**
   * SYNC: replay queued actions oldest-first. A shortfall does not stop the
   * drain — the server records the sale and raises a conflict for the owner
   * (PRD §5.4: physical stock is the truth, conflicts are surfaced).
   */
  private async drain(): Promise<void> {
    const entries = await pending();
    for (const e of entries) {
      if (e.seq === undefined) continue;
      try {
        const p = e.payload as { lines: unknown[]; note: string | null };
        const { data, error } = await this.o.db.rpc("replay_offline_sale", {
          p_shop_id: e.shopId,
          p_client_ref: e.clientRef,
          p_sold_by: this.o.userId,
          p_lines: p.lines,
          p_sold_at: e.occurredAt,
          p_device_id: e.deviceId,
          p_note: p.note,
        });
        if (error) throw error;
        const res = data as { conflicts: number };
        this.newConflicts += res?.conflicts ?? 0;
        await markEntrySynced(e.seq);
      } catch (err) {
        await markFailed(e.seq, err instanceof Error ? err.message : String(err));
        // Stop on the first hard failure so order is preserved; the next pass
        // retries from here rather than skipping past a stuck entry.
        break;
      }
    }
  }

  /** Ask the signing function for a fresh token; fall back to the heartbeat. */
  private async refreshToken(): Promise<void> {
    const report = anomalyReport(this.clock);
    const body = {
      device_id: this.o.deviceId,
      credential: this.o.credential,
      monotonic_seconds: report.monotonic_seconds,
      wall_clock_seconds: report.wall_clock_seconds,
    };

    try {
      const res = await fetch(`${this.o.functionsUrl}/issue-subscription-token`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: this.o.anonKey },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const { token, payload } = (await res.json()) as { token: string; payload: SubscriptionPayload };
        this.token = token;
        safeSet(TOKEN_KEY, token);
        this.clock = markClockSynced(this.clock, payload.issued_at);
        saveClock(this.clock);
        await this.verifyLocally();
        return;
      }
    } catch {
      // Function unreachable — fall through to the plain heartbeat.
    }

    // Heartbeat still proves we reached the server and stamps last_sync_at;
    // it returns the previously issued token, which may still be in date.
    const { data, error } = await this.o.db.rpc("device_heartbeat", {
      p_device_id: this.o.deviceId,
      p_credential: this.o.credential,
      p_monotonic_seconds: report.monotonic_seconds,
      p_wall_clock_seconds: report.wall_clock_seconds,
    });
    if (error) throw error;
    const hb = data as { server_time: string; subscription_token: string | null };
    if (hb.subscription_token) { this.token = hb.subscription_token; safeSet(TOKEN_KEY, hb.subscription_token); }
    this.clock = markClockSynced(this.clock, hb.server_time);
    saveClock(this.clock);
    await this.verifyLocally();
  }

  private async verifyLocally(): Promise<void> {
    const v = await verifySubscriptionToken(this.token, this.o.publicKeyB64, this.o.deviceId);
    this.tokenValid = v.valid;
    this.payload = v.payload;
  }

  private gate(): GateDecision {
    const policy: GatePolicy = this.payload
      ? {
          graceDays: this.payload.policy.grace_days,
          readOnlyDays: this.payload.policy.read_only_days,
          mandatorySyncDays: this.payload.policy.mandatory_sync_days,
          syncWarningDays: this.payload.policy.sync_warning_days,
        }
      : FALLBACK_POLICY;

    // No public key configured at all → gating is not enforceable, so it is
    // not enforced. Being unable to check must not silently lock a shop out;
    // the operational centre sees this via the device's clock/anomaly reports.
    if (!this.o.publicKeyB64) {
      return { level: "full", reason: "ok", title: "Up to date", action: "", daysUntilNextStep: null, warn: false };
    }

    return evaluateGate({
      status: this.payload?.status ?? "active",
      expiresAt: this.payload?.expires_at ? new Date(this.payload.expires_at) : null,
      elapsedSinceSyncSeconds: elapsedSinceSync(this.clock),
      lastSyncServerTime: this.clock.lastSyncServerTime ? new Date(this.clock.lastSyncServerTime) : null,
      tokenValid: this.tokenValid,
      policy,
    });
  }

  private publish(): void {
    void (async () => {
      const p = await pending();
      this.o.onStatus({
        online: navigator.onLine,
        syncing: this.syncing,
        pendingCount: p.length,
        oldestPendingAt: await oldestPendingAt(),
        lastSyncAt: this.clock.lastSyncServerTime ? new Date(this.clock.lastSyncServerTime) : null,
        gate: this.gate(),
        subscription: this.payload,
        newConflicts: this.newConflicts,
        clockAnomalySeconds: this.clock.lastAnomalySeconds,
      });
    })();
  }
}

function loadClock(): ClockState {
  const raw = safeGet(CLOCK_KEY);
  if (!raw) return emptyClockState();
  try {
    return { ...emptyClockState(), ...(JSON.parse(raw) as ClockState) };
  } catch {
    return emptyClockState();
  }
}
function saveClock(s: ClockState): void { safeSet(CLOCK_KEY, JSON.stringify(s)); }
function safeGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
