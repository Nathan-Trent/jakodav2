import type { SupabaseClient } from "@supabase/supabase-js";
import type { NumericString } from "@zogal/shared";

/**
 * Sales history — one sale with everything the Sales screen shows: lines
 * with item names, seller, customer, and (only when RLS lets the caller
 * read allocations, i.e. items.view_cost) the FIFO cost so profit per sale
 * can be shown. RLS on `sales` already narrows a cashier to their own.
 */
export interface SaleHistoryLine {
  id: string;
  item_id: string;
  quantity: number;
  unit_price: NumericString;
  floor_price_at_sale: NumericString;
  items: { name: string } | null;
  /** Empty for callers without items.view_cost. */
  sale_line_allocations: { quantity: number; unit_cost: NumericString }[];
}

export interface SaleHistoryRow {
  id: string;
  client_ref: string;
  sold_at: string;
  sold_by: string | null;
  device_id: string | null;
  customer_id: string | null;
  total: NumericString;
  note: string | null;
  status: "completed" | "voided";
  users: { full_name: string } | null;
  customers: { name: string; phone: string | null } | null;
  sale_lines: SaleHistoryLine[];
}

const SELECT =
  "id, client_ref, sold_at, sold_by, device_id, customer_id, total, note, status, " +
  "users!sales_sold_by_fkey(full_name), customers(name, phone), " +
  "sale_lines(id, item_id, quantity, unit_price, floor_price_at_sale, items(name), sale_line_allocations(quantity, unit_cost))";

/** Sales in [from, to] (shop-local dates, inclusive), newest first. Capped. */
export async function fetchSalesHistory(
  db: SupabaseClient, shopId: string, from: string, to: string, opts: { customerId?: string; limit?: number } = {},
): Promise<SaleHistoryRow[]> {
  let q = db
    .from("sales")
    .select(SELECT)
    .eq("shop_id", shopId)
    // Local midnight → UTC instant, so the window matches the terminal's day.
    .gte("sold_at", new Date(`${from}T00:00:00`).toISOString())
    .lt("sold_at", new Date(`${nextDay(to)}T00:00:00`).toISOString())
    .order("sold_at", { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.customerId) q = q.eq("customer_id", opts.customerId);
  const { data, error } = await q;
  if (error) throw error;
  return data as unknown as SaleHistoryRow[];
}

function nextDay(d: string): string {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() + 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** "Indomie ×3, Peak Milk ×1 · 2 more" — the one-line summary of a sale. */
export function summariseLines(lines: { quantity: number; name: string }[], max = 2): string {
  if (lines.length === 0) return "—";
  const head = lines.slice(0, max).map((l) => `${l.name} ×${l.quantity}`).join(", ");
  const rest = lines.length - max;
  return rest > 0 ? `${head} · ${rest} more` : head;
}
