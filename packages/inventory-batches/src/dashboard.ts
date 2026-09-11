import type { SupabaseClient } from "@supabase/supabase-js";
import type { NumericString } from "@jakoda/shared";

/** Shape of shop_dashboard() — see 0005_dashboard.sql. */
export interface ShopDashboard {
  today: {
    date: string;
    sales_count: number;
    sales_total: NumericString | number;
    units_sold: number;
    /** null unless caller has items.view_cost */
    gross_profit: NumericString | number | null;
  };
  week: { day: string; total: NumericString | number; count: number }[];
  stock: {
    items: number;
    units: number;
    /** null unless caller has items.view_cost */
    value: NumericString | number | null;
    low_stock: number;
  };
  devices: { total: number; online: number };
  staff: { total: number };
  /** "shop" = all sales; "mine" = caller lacks sales.view_all */
  scope: "shop" | "mine";
}

export async function fetchShopDashboard(db: SupabaseClient, shopId: string): Promise<ShopDashboard> {
  const { data, error } = await db.rpc("shop_dashboard", { p_shop_id: shopId });
  if (error) throw error;
  return data as ShopDashboard;
}

/** Recent sales with seller and line summary — for activity feeds. */
export interface RecentSale {
  id: string;
  sold_at: string;
  total: NumericString;
  device_id: string | null;
  users: { full_name: string } | null;
  sale_lines: { quantity: number; unit_price: NumericString; items: { name: string } | null }[];
}

export async function fetchRecentSales(db: SupabaseClient, shopId: string, limit = 10): Promise<RecentSale[]> {
  const { data, error } = await db
    .from("sales")
    .select("id, sold_at, total, device_id, users!sales_sold_by_fkey(full_name), sale_lines(quantity, unit_price, items(name))")
    .eq("shop_id", shopId)
    .eq("status", "completed")
    .order("sold_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as unknown as RecentSale[];
}
