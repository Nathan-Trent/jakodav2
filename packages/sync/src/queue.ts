/**
 * SYNC: the local outbox (TRD §7, PRD §6.9).
 *
 * Every till action is written here FIRST and acknowledged to the user
 * immediately — the sale is done the moment the drawer closes, network or
 * not. A background pass drains it to the server.
 *
 * IndexedDB rather than SQLite: it is transactional, durable across restarts,
 * and needs no native plugin (so no second Rust toolchain dependency). The
 * trade-off is that it lives in the webview profile and is readable from
 * devtools — acceptable for a queue of the shop's own sales, and noted in
 * BUILD_LOG as the reason the device credential should still move to native
 * storage.
 *
 * Ordering is by `seq`, so replays hit the server in the order they happened.
 * Idempotency is `client_ref` (unique per shop server-side), so a reconnect
 * that dies halfway can safely repeat.
 */

const DB_NAME = "zogal-sync";
/** Bumped to 2 when the read cache was added; see cache.ts for the schema. */
const DB_VERSION = 2;
const STORE = "outbox";
const CACHE = "cache";

export type OutboxKind = "sale";

export interface OutboxEntry<T = unknown> {
  /** Auto-increment: replay order. */
  seq?: number;
  kind: OutboxKind;
  /** Idempotency key sent to the server. */
  clientRef: string;
  shopId: string;
  deviceId: string | null;
  /**
   * Who was signed in when this happened. A shared terminal changes hands
   * between shifts; whoever is signed in at SYNC time is not necessarily who
   * made the sale, so the entry carries its own seller.
   */
  userId: string;
  /** When it actually happened, not when it syncs. */
  occurredAt: string;
  payload: T;
  attempts: number;
  lastError: string | null;
  /** Set once the server has accepted it; kept briefly for the activity feed. */
  syncedAt: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
        store.createIndex("pending", "syncedAt");
        store.createIndex("clientRef", "clientRef", { unique: true });
      }
      if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Append an action. Returns its sequence number. */
export async function enqueue<T>(entry: Omit<OutboxEntry<T>, "seq" | "attempts" | "lastError" | "syncedAt">): Promise<number> {
  return tx("readwrite", (s) => s.add({ ...entry, attempts: 0, lastError: null, syncedAt: null })) as Promise<number>;
}

/** Everything not yet accepted by the server, oldest first. */
export async function pending(): Promise<OutboxEntry[]> {
  const all = await tx<OutboxEntry[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  return all.filter((e) => e.syncedAt === null).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

export async function markSynced(seq: number): Promise<void> {
  const entry = await tx<OutboxEntry>("readonly", (s) => s.get(seq) as IDBRequest<OutboxEntry>);
  if (!entry) return;
  await tx("readwrite", (s) => s.put({ ...entry, syncedAt: new Date().toISOString(), lastError: null }));
}

export async function markFailed(seq: number, error: string): Promise<void> {
  const entry = await tx<OutboxEntry>("readonly", (s) => s.get(seq) as IDBRequest<OutboxEntry>);
  if (!entry) return;
  await tx("readwrite", (s) => s.put({ ...entry, attempts: entry.attempts + 1, lastError: error }));
}

/** Drop entries the server accepted more than `olderThanDays` ago. */
export async function prune(olderThanDays = 7): Promise<number> {
  const all = await tx<OutboxEntry[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const stale = all.filter((e) => e.syncedAt !== null && Date.parse(e.syncedAt) < cutoff);
  for (const e of stale) if (e.seq !== undefined) await tx("readwrite", (s) => s.delete(e.seq!));
  return stale.length;
}

/** Oldest unsynced action — drives "you have unsent sales from …" messaging. */
export async function oldestPendingAt(): Promise<Date | null> {
  const p = await pending();
  return p.length && p[0] ? new Date(p[0].occurredAt) : null;
}
