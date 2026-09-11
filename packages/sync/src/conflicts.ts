import type { SupabaseClient } from "@supabase/supabase-js";

/** SYNC: conflicts raised on replay, for the owner to resolve (TRD §7). */
export interface SyncConflictRow {
  id: string;
  shop_id: string;
  device_id: string | null;
  kind: "stock_shortfall" | "duplicate_sale" | "below_floor" | "other";
  sale_id: string | null;
  item_id: string | null;
  detail: Record<string, unknown>;
  occurred_at: string;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

export async function listConflicts(db: SupabaseClient, shopId: string, includeResolved = false): Promise<SyncConflictRow[]> {
  let q = db.from("sync_conflicts").select("*").eq("shop_id", shopId).order("detected_at", { ascending: false }).limit(100);
  if (!includeResolved) q = q.is("resolved_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return data as SyncConflictRow[];
}

export async function openConflictCount(db: SupabaseClient, shopId: string): Promise<number> {
  const { count, error } = await db
    .from("sync_conflicts")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .is("resolved_at", null);
  if (error) throw error;
  return count ?? 0;
}

/** Resolving is a note about what the owner did, not a data change. */
export async function resolveConflict(db: SupabaseClient, id: string, userId: string, resolution: string): Promise<void> {
  const { error } = await db
    .from("sync_conflicts")
    .update({ resolved_at: new Date().toISOString(), resolved_by: userId, resolution })
    .eq("id", id);
  if (error) throw error;
}
