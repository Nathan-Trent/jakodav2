import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Zogal back office (platform admins only — 0013/0014). Every call here is
 * refused by Postgres for anyone not in platform_admins; the client checks
 * isPlatformAdmin() only to decide whether to show the section.
 */
export interface AdminShop {
  id: string; name: string; timezone: string; is_active: boolean; created_at: string;
  subscription: { status: "active" | "past_due" | "cancelled"; plan: string; expires_at: string | null } | null;
  owner: { name: string; email: string } | null;
  members: number; devices: number; devices_online: number;
  last_sale_at: string | null; sales_30d: number | string; scans_this_month: number; open_conflicts: number;
}

export interface PlatformSettingRow { key: string; value: unknown; description: string; updated_by: string | null; updated_at: string }
export interface PlatformSettingHistoryRow { id: number; key: string; old_value: unknown; new_value: unknown; changed_by: string | null; changed_at: string }

export async function isPlatformAdmin(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("is_platform_admin");
  if (error) return false;
  return data === true;
}

export async function adminListShops(db: SupabaseClient): Promise<AdminShop[]> {
  const { data, error } = await db.rpc("admin_list_shops");
  if (error) throw error;
  return data as AdminShop[];
}

export async function adminSetSubscription(
  db: SupabaseClient, input: { shopId: string; status: "active" | "past_due" | "cancelled"; plan: string; expiresAt: string | null },
): Promise<void> {
  const { error } = await db.rpc("admin_set_subscription", {
    p_shop_id: input.shopId, p_status: input.status, p_plan: input.plan, p_expires_at: input.expiresAt,
  });
  if (error) throw error;
}

export async function listPlatformSettings(db: SupabaseClient): Promise<PlatformSettingRow[]> {
  const { data, error } = await db.from("platform_settings").select("*").order("key");
  if (error) throw error;
  return data as PlatformSettingRow[];
}

export async function adminSetPlatformSetting(db: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await db.rpc("admin_set_platform_setting", { p_key: key, p_value: value });
  if (error) throw error;
}

export async function platformSettingsHistory(db: SupabaseClient, limit = 50): Promise<PlatformSettingHistoryRow[]> {
  const { data, error } = await db.from("platform_settings_history").select("*").order("changed_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data as PlatformSettingHistoryRow[];
}

export async function adminOperationalSettings(db: SupabaseClient): Promise<{ settings: Record<string, number>; updated_at: string }> {
  const { data, error } = await db.rpc("admin_operational_settings");
  if (error) throw error;
  return data as { settings: Record<string, number>; updated_at: string };
}

export async function adminUpdateOperationalSettings(db: SupabaseClient, patch: Record<string, number>): Promise<Record<string, number>> {
  const { data, error } = await db.rpc("admin_update_operational_settings", { p_patch: patch });
  if (error) throw error;
  return data as Record<string, number>;
}
