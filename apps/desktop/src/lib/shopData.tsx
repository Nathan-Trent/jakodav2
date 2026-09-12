import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BatchRow, PurchaseRow } from "@zogal/shared";
import type { DeviceStatusRow } from "@zogal/auth-permissions";
import { toKobo, type Kobo } from "@zogal/shared";
import { fetchShopDashboard, listBarcodes, listCustomers, stockChannel } from "@zogal/inventory-batches";
import { cacheKey, getCache, pending, putCache, type OutboxEntry } from "@zogal/sync";
import { listExpenses, loadFiledPeriods, loadLedgerSummary, loadTaxProfile, loadTaxReference, monthWindow, yearWindow } from "@zogal/tax-engine";
import { composeView, EMPTY_SNAPSHOT as EMPTY, type OfflineSalePayload, type ShopSnapshot, type ShopView } from "@/lib/shopView";
export { asOf, type ShopSnapshot, type ShopView, type ViewSale } from "@/lib/shopView";
import { useSession } from "@/lib/session";
import { useSync } from "@/lib/sync";
import { getSupabase } from "@/lib/supabase";

/**
 * SYNC: the terminal's working set — snapshot + overlay.
 *
 * Two layers, never mixed:
 *
 *   SNAPSHOT  what the server last told us. Pure. Cached in IndexedDB so it
 *             is there instantly on start, network or not.
 *   OVERLAY   what this terminal has done since, still in the outbox. Applied
 *             on top of the snapshot at read time, never written into it.
 *
 * What every screen sees is snapshot ⊕ overlay. So an offline sale lowers the
 * stock, appears in history (marked "not yet uploaded"), and counts in today's
 * figures — all computed locally. When it uploads it leaves the overlay; on
 * the next pull it appears in the snapshot. Never double-counted, never lost,
 * and — the bug the earlier version had — never "undone" by a refresh that
 * arrives before the upload does.
 *
 * Being offline changes exactly one thing: the snapshot can't get fresher.
 * That's a staleness notice, not an error, and never an empty screen.
 */
interface ShopDataContext {
  data: ShopView;
  /** True until the first hydrate finishes — show loading, not "empty". */
  loading: boolean;
  refreshing: boolean;
  lastUpdatedAt: Date | null;
  /** True when showing what we last downloaded rather than fresh data. */
  stale: boolean;
  refresh: () => Promise<void>;
  /** Re-read the outbox — call after enqueueing so the overlay updates now. */
  reloadOverlay: () => Promise<void>;
  stockFor: (itemId: string) => number;
  costPerUnit: (itemId: string) => Kobo | undefined;
}

const Ctx = createContext<ShopDataContext | null>(null);

export function ShopDataProvider({ children }: { children: ReactNode }) {
  const { active, inventory, auth } = useSession();
  const { status: syncStatus } = useSync();
  const shopId = active?.shop.id ?? null;
  const viewCost = active?.permissions.includes("items.view_cost") ?? false;
  const viewTax = active?.permissions.includes("tax.view") ?? false;
  const viewExpenses = (active?.permissions.includes("expenses.view") || active?.permissions.includes("expenses.create")) ?? false;

  const [snapshot, setSnapshot] = useState<ShopSnapshot>(EMPTY);
  const [overlay, setOverlay] = useState<OutboxEntry<OfflineSalePayload>[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const wasSyncing = useRef(false);

  const key = shopId ? cacheKey(shopId, "snapshot") : null;

  /** The overlay is whatever is still in the outbox for this shop. */
  const reloadOverlay = useCallback(async () => {
    if (!shopId) { setOverlay([]); return; }
    const all = await pending();
    setOverlay(all.filter((e) => e.kind === "sale" && e.shopId === shopId) as OutboxEntry<OfflineSalePayload>[]);
  }, [shopId]);

  /** Instant: whatever this terminal last downloaded. */
  const hydrate = useCallback(async () => {
    if (!key) { setLoading(false); return; }
    const entry = await getCache<ShopSnapshot>(key);
    if (entry) {
      setSnapshot({ ...EMPTY, ...entry.rows });
      setLastUpdatedAt(new Date(entry.cachedAt));
      setStale(true);
    }
    await reloadOverlay();
    setLoading(false);
  }, [key, reloadOverlay]);

  /** Pull a fresh snapshot. Only when online; failure is not an error. */
  const refresh = useCallback(async () => {
    if (!shopId || !key || !navigator.onLine) { setStale(true); return; }
    setRefreshing(true);
    try {
      const db = getSupabase();
      const [items, barcodes, stockMap, sales, dashboard, stockRows, batches, purchases, devices, tax, expenses, customers] = await Promise.all([
        inventory.listItems(shopId),
        listBarcodes(db, shopId),
        inventory.stockQuantities(shopId),
        inventory.recentSales(shopId, 50),
        fetchShopDashboard(db, shopId),
        viewCost ? inventory.stockOnHand(shopId) : Promise.resolve([]),
        viewCost
          ? db.from("batches").select<"*", BatchRow>().eq("shop_id", shopId)
              .order("purchased_at", { ascending: false }).limit(200)
              .then((r) => { if (r.error) throw r.error; return r.data; })
          : Promise.resolve([] as BatchRow[]),
        db.from("purchases").select<"*", PurchaseRow>().eq("shop_id", shopId)
          .order("purchased_at", { ascending: false }).limit(200)
          .then((r) => { if (r.error) throw r.error; return r.data; }),
        auth.listDevices(shopId).catch(() => [] as DeviceStatusRow[]),
        viewTax ? loadTaxSlice(db, shopId).catch(() => null) : Promise.resolve(null),
        viewExpenses ? listExpenses(db, shopId).catch(() => []) : Promise.resolve([]),
        // Until 0012 is applied the table doesn't exist — treat as "no customers".
        listCustomers(db, shopId).catch(() => []),
      ]);
      const next: ShopSnapshot = {
        items, barcodes,
        stock: Object.fromEntries(stockMap),
        stockValue: Object.fromEntries(stockRows.map((r) => [r.item_id, toKobo(r.stock_value)])),
        batches, purchases, sales, dashboard, devices, tax, expenses, customers,
      };
      setSnapshot(next);
      await putCache(key, next);
      setLastUpdatedAt(new Date());
      setStale(false);
    } catch {
      setStale(true);
    } finally {
      setRefreshing(false);
      await reloadOverlay();
    }
  }, [shopId, key, inventory, auth, viewCost, viewTax, viewExpenses, reloadOverlay]);

  useEffect(() => {
    setSnapshot(EMPTY);
    setLoading(true);
    void hydrate().then(() => refresh());
  }, [hydrate, refresh]);

  // SYNC ordering: when the engine finishes a drain (syncing true → false),
  // pull a fresh snapshot so uploaded sales move from overlay to snapshot in
  // one step, and we also pick up whatever other terminals did meanwhile.
  useEffect(() => {
    const syncing = syncStatus?.syncing ?? false;
    if (wasSyncing.current && !syncing) void refresh();
    wasSyncing.current = syncing;
  }, [syncStatus?.syncing, refresh]);

  // Any change in what's queued (a new offline sale, or one that uploaded)
  // re-reads the overlay.
  useEffect(() => { void reloadOverlay(); }, [syncStatus?.pendingCount, reloadOverlay]);

  // Connection back, or another terminal sold → pull.
  useEffect(() => {
    if (!shopId) return;
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    const db = getSupabase();
    const ch = stockChannel(db, shopId);
    ch.on("broadcast", { event: "stock" }, () => void refresh());
    ch.subscribe();
    const poll = window.setInterval(() => { if (navigator.onLine) void refresh(); }, 60_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(poll);
      void db.removeChannel(ch);
    };
  }, [shopId, refresh]);

  /** snapshot ⊕ overlay — the only thing screens read. */
  const view = useMemo<ShopView>(() => composeView(snapshot, overlay, viewCost), [snapshot, overlay, viewCost]);

  const value = useMemo<ShopDataContext>(() => ({
    data: view,
    loading, refreshing, lastUpdatedAt, stale,
    refresh, reloadOverlay,
    stockFor: (itemId) => view.stock[itemId] ?? 0,
    costPerUnit: (itemId) => {
      // Weighted cost of what's left, per the SNAPSHOT (unsent sales consume
      // batches locally below, but the per-unit average barely moves).
      const onHand = snapshot.stock[itemId] ?? 0;
      const v = snapshot.stockValue[itemId];
      return v !== undefined && onHand > 0 ? (Math.round(v / onHand) as Kobo) : undefined;
    },
  }), [view, snapshot, loading, refreshing, lastUpdatedAt, stale, refresh, reloadOverlay]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShopData(): ShopDataContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShopData outside ShopDataProvider");
  return v;
}

/** Everything the tax engine needs, fetched together so it can be cached and computed offline. */
async function loadTaxSlice(db: ReturnType<typeof getSupabase>, shopId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const [ref, profile, filed] = await Promise.all([loadTaxReference(db), loadTaxProfile(db, shopId), loadFiledPeriods(db, shopId)]);
  const y = yearWindow(today, profile?.fiscalYearStartMonth ?? 1);
  const m = monthWindow(today);
  const [year, month] = await Promise.all([loadLedgerSummary(db, shopId, y.start, y.end), loadLedgerSummary(db, shopId, m.start, m.end)]);
  return { ...ref, profile, year, month, filed };
}
