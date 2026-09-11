/**
 * SYNC: the local copy of everything the terminal has already downloaded.
 *
 * A till must work end to end with no network. The outbox (queue.ts) covers
 * writes; this covers reads. Without it the app is only offline-*tolerant* —
 * it can record a sale but has nothing to show you, which is no use in a shop.
 *
 * The rule: the terminal always renders what it last downloaded. Being offline
 * changes ONE thing — it cannot learn about changes made elsewhere. That is a
 * staleness notice, not an error, and never an empty screen.
 *
 * Stored in the same IndexedDB database as the outbox so a single durable
 * store holds everything the terminal knows.
 */

const DB_NAME = "zogal-sync";
const DB_VERSION = 2;
const OUTBOX = "outbox";
const CACHE = "cache";

export interface CacheEntry<T> {
  key: string;
  rows: T;
  cachedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const store = db.createObjectStore(OUTBOX, { keyPath: "seq", autoIncrement: true });
        store.createIndex("pending", "syncedAt");
        store.createIndex("clientRef", "clientRef", { unique: true });
      }
      // v2 adds the read cache; existing outbox data is untouched.
      if (ev.oldVersion < 2 && !db.objectStoreNames.contains(CACHE)) {
        db.createObjectStore(CACHE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(CACHE, mode);
        const req = fn(t.objectStore(CACHE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Namespaced per shop so two shops on one terminal never bleed together. */
export function cacheKey(shopId: string, collection: string): string {
  return `${shopId}:${collection}`;
}

export async function putCache<T>(key: string, rows: T): Promise<void> {
  await tx("readwrite", (s) => s.put({ key, rows, cachedAt: new Date().toISOString() }));
}

export async function getCache<T>(key: string): Promise<CacheEntry<T> | null> {
  const e = await tx<CacheEntry<T> | undefined>("readonly", (s) => s.get(key) as IDBRequest<CacheEntry<T> | undefined>);
  return e ?? null;
}

/**
 * Fetch if we can, fall back to the cache if we cannot.
 *
 * Note the order: a successful fetch refreshes the cache, and ANY failure —
 * offline, server down, a timeout — serves what we already had. The caller is
 * told which it got so it can say "as of 2 hours ago" instead of pretending.
 */
export async function readThrough<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { online?: boolean } = {},
): Promise<{ data: T | null; fromCache: boolean; cachedAt: string | null }> {
  const online = opts.online ?? (typeof navigator === "undefined" || navigator.onLine);

  if (online) {
    try {
      const data = await fetcher();
      await putCache(key, data);
      return { data, fromCache: false, cachedAt: new Date().toISOString() };
    } catch {
      // Fall through: a failed request is not a reason to show nothing.
    }
  }

  const entry = await getCache<T>(key);
  return entry
    ? { data: entry.rows, fromCache: true, cachedAt: entry.cachedAt }
    : { data: null, fromCache: true, cachedAt: null };
}

/** Wipe one shop's cache — used when a terminal is rebound to another shop. */
export async function clearShopCache(shopId: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(CACHE, "readwrite");
    const store = t.objectStore(CACHE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) if (String(k).startsWith(`${shopId}:`)) store.delete(k);
    };
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => reject(t.error);
  });
}
