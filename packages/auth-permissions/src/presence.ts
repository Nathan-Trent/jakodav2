import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the Zogal Business back office needs from a signed-in user (0016):
 * where they signed in from, notices sent to them, and whether this session
 * is a member of staff signed in as them.
 */
export type Surface = "desktop" | "web" | "pos_web";

/** Call once per sign-in. The server takes the IP from the request; nothing is sent from here. */
export async function recordSignin(db: SupabaseClient, surface: Surface, shopId: string | null): Promise<void> {
  const { error } = await db.rpc("record_signin", { p_product: "doka", p_surface: surface, p_shop_id: shopId });
  if (error) console.warn("record_signin:", error.message); // never blocks sign-in
}

export interface UserNotice { id: string; title: string; body: string | null; read_at: string | null; created_at: string }

export async function fetchNotices(db: SupabaseClient): Promise<UserNotice[]> {
  const { data, error } = await db.from("user_notices").select("id, title, body, read_at, created_at").order("created_at", { ascending: false }).limit(20);
  if (error) return [];
  return data as UserNotice[];
}

export async function markNoticeRead(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("user_notices").update({ read_at: new Date().toISOString() }).eq("id", id);
  if (error) console.warn("notice read:", error.message);
}

export interface Impersonation { id: string; staff: string | null; expires_at: string; product: string }

/** Non-null when a member of Zogal staff is signed in as this user. Shown as a red bar; money actions refuse. */
export async function currentImpersonation(db: SupabaseClient): Promise<Impersonation | null> {
  const { data, error } = await db.rpc("current_impersonation");
  if (error || !data) return null;
  return data as Impersonation;
}

/**
 * Push instead of poll (Nathan, 2026-09-19): subscribe to this user's own
 * notices and impersonation rows. RLS (0016/0018) limits what Realtime
 * delivers to the caller's rows, so no filter is needed on the client.
 * Returns an unsubscribe. Reconnects are supabase-js's job; `onChange` is
 * called once on subscribe so the first read happens the same way.
 */
export function subscribePresence(db: SupabaseClient, onChange: () => void): () => void {
  const ch = db.channel("presence")
    .on("postgres_changes", { event: "*", schema: "public", table: "user_notices" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "impersonations" }, onChange)
    .subscribe((status) => { if (status === "SUBSCRIBED") onChange(); });
  return () => { void db.removeChannel(ch); };
}
