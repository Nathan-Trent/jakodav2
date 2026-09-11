/**
 * SYNC module — Stage 5 (TRD §7).
 *
 * Owns everything about a terminal running without a network:
 *  - `queue`    local write-ahead outbox; instant local writes, durable
 *  - `clock`    elapsed time the app can defend against a tampered clock
 *  - `token`    Ed25519 verification of the signed subscription token
 *  - `gating`   grace → read-only → locked, from both expiry and sync cadence
 *  - `engine`   ties them together and publishes one SyncStatus to the UI
 *
 * Conflicts are surfaced, never resolved here: the server records what really
 * happened and raises a sync_conflict for the owner (PRD §5.4).
 */
export {
  enqueue, pending, pendingCount, prune, oldestPendingAt,
  markFailed,
  // queue and clock both have a markSynced; the queue's is per-entry.
  markSynced as markEntrySynced,
  type OutboxEntry, type OutboxKind,
} from "./queue.js";
export * from "./clock.js";
export * from "./token.js";
export * from "./gating.js";
export * from "./engine.js";
export * from "./conflicts.js";
