import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BarcodeRow, BatchRow, ItemRow, SaleRow } from "@zogal/shared";
import { toKobo, type Kobo } from "@zogal/shared";
import { fetchShopDashboard, listBarcodes, stockChannel, type ShopDashboard } from "@zogal/inventory-batches";
import { cacheKey, getCache, putCache } from "@zogal/sync";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

/**
 * SYNC: the terminal's working set.
 *
 * The till renders from THIS, never straight from the network. On start it is
 * hydrated from IndexedDB (instant, works with no connection), then refreshed
 * from the server when one is available.
 *
 * The point Nathan made, and the rule this enforces: being offline means the
 * terminal cannot learn about changes made elsewhere. It does NOT mean the
 * terminal forgets what it already knows. Items, stock, history and figures
 * stay on screen; all that changes is a quiet "as of <time>" notice.
 *
 * Local edits (an offline sale) are applied to this set immediately so the
 * next sale sees the right stock, and the server reconciles on replay.
 */
export interface ShopData {
  items: ItemRow[];
  barcodes: BarcodeRow[];
  /** itemId → units on hand. */
  stock: Record<string, number>;
  /** itemId → total value of remaining stock, kobo. Only with items.view_cost. */
  stockValue: Record<string, number>;
  batches: BatchRow[];
  sales: SaleRow[];
  dashboard: ShopDashboard | null;
}

const EMPTY: ShopData = { items: [], barcodes: [], stock: {}, stockValue: {}, batches: [], sales: [], dashboard: null };

interface ShopDataContext {
  data: ShopData;
  /** True until the first hydrate finishes — show a loading state, not "empty". */
  loading: boolean;
  refreshing: boolean;
  /** When this data was last fetched from the server. */
  lastUpdatedAt: Date | null;
  /** True when we're showing what we last downloaded rather than fresh data. */
  stale: boolean;
  refresh: () => Promise<void>;
  /** Apply a local change straight away (offline sale). */
  applyLocalSale: (lines: { itemId: string; quantity: number }[]) => void;
  /** Stock net of anything queued but not yet accepted. */
  stockFor: (itemId: string) => number;
  costPerUnit: (itemId: string) => Kobo | undefined;
}

const Ctx = createContext<ShopDataContext | null>(null);

export function ShopDataProvider({ children }: { children: ReactNode }) {
  const { active, inventory } = useSession();
  const shopId = active?.shop.id ?? null;
  const viewCost = active?.permissions.includes("items.view_cost") ?? false;

  const [data, setData] = useState<ShopData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const channelRef = useRef<ReturnType<typeof stockChannel> | null>(null);

  const key = shopId ? cacheKey(shopId, "working-set") : null;

  /** Instant: whatever this terminal last downloaded. */
  const hydrate = useCallback(async () => {
    if (!key) { setLoading(false); return; }
    const entry = await getCache<ShopData>(key);
    if (entry) {
      setData({ ...EMPTY, ...entry.rows });
      setLastUpdatedAt(new Date(entry.cachedAt));
      setStale(true);
    }
    setLoading(false);
  }, [key]);

  /** Opportunistic: only when there is a connection. Failure is not an error. */
  const refresh = useCallback(async () => {
    if (!shopId || !key || !navigator.onLine) { setStale(true); return; }
    setRefreshing(true);
    try {
      const db = getSupabase();
      const [items, barcodes, stockMap, sales, dashboard, stockRows, batches] = await Promise.all([
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
      ]);

      const next: ShopData = {
        items,
        barcodes,
        stock: Object.fromEntries(stockMap),
        stockValue: Object.fromEntries(stockRows.map((r) => [r.item_id, toKobo(r.stock_value)])),
        batches,
        sales,
        dashboard,
      };
      setData(next);
      await putCache(key, next);
      setLastUpdatedAt(new Date());
      setStale(false);
    } catch {
      // Server unreachable mid-session: keep showing what we have.
      setStale(true);
    } finally {
      setRefreshing(false);
    }
  }, [shopId, key, inventory, viewCost]);

  useEffect(() => {
    setData(EMPTY);
    setLoading(true);
    void hydrate().then(() => refresh());
  }, [hydrate, refresh]);

  // Refresh when the connection comes back, and when another terminal sells.
  useEffect(() => {
    if (!shopId) return;
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);

    const db = getSupabase();
    const ch = stockChannel(db, shopId);
    ch.on("broadcast", { event: "stock" }, () => void refresh());
    ch.subscribe();
    channelRef.current = ch;

    const poll = window.setInterval(() => { if (navigator.onLine) void refresh(); }, 60_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(poll);
      void db.removeChannel(ch);
      channelRef.current = null;
    };
  }, [shopId, refresh]);

  /** Offline sale: decrement locally so the next sale sees the right stock. */
  const applyLocalSale = useCallback((lines: { itemId: string; quantity: number }[]) => {
    setData((d) => {
      const stock = { ...d.stock };
      for (const l of lines) stock[l.itemId] = Math.max(0, (stock[l.itemId] ?? 0) - l.quantity);
      const next = { ...d, stock };
      if (key) void putCache(key, next);
      return next;
    });
  }, [key]);

  const value = useMemo<ShopDataContext>(() => ({
    data,
    loading,
    refreshing,
    lastUpdatedAt,
    stale,
    refresh,
    applyLocalSale,
    stockFor: (itemId) => data.stock[itemId] ?? 0,
    costPerUnit: (itemId) => {
      const onHand = data.stock[itemId] ?? 0;
      const value = data.stockValue[itemId];
      return value !== undefined && onHand > 0 ? (Math.round(value / onHand) as Kobo) : undefined;
    },
  }), [data, loading, refreshing, lastUpdatedAt, stale, refresh, applyLocalSale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShopData(): ShopDataContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShopData outside ShopDataProvider");
  return v;
}

/** "as of 12:04" / "as of Tue 14:30" — for the staleness notice. */
export function asOf(d: Date | null): string {
  if (!d) return "never";
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
