import type { SupabaseClient } from "@supabase/supabase-js";

/** shop_report() — owner reporting for a period (reports.view). Numbers arrive as numeric strings or numbers. */
export interface ShopReport {
  from: string; to: string;
  totals: { sales_count: number; units: number; revenue: number | string; gross_profit: number | string | null; expenses: number | string | null };
  by_seller: { user_id: string; name: string; sales_count: number; units: number; revenue: number | string; gross_profit: number | string | null }[];
  by_terminal: { device_id: string; name: string; sales_count: number; revenue: number | string }[];
  by_item: { item_id: string; name: string; units: number; revenue: number | string; gross_profit: number | string | null; on_hand: number }[];
  by_customer: { customer_id: string; name: string; sales_count: number; revenue: number | string }[];
  expenses_by_category: { category: string; amount: number | string }[];
  by_day: { day: string; revenue: number | string; count: number }[];
}

export async function fetchShopReport(db: SupabaseClient, shopId: string, from: string, to: string): Promise<ShopReport> {
  const { data, error } = await db.rpc("shop_report", { p_shop_id: shopId, p_from: from, p_to: to });
  if (error) throw error;
  return data as ShopReport;
}
