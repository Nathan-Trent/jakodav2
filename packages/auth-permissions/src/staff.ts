import type { SupabaseClient } from "@supabase/supabase-js";
import type { Permission } from "./permissions.js";
import type { RoleRow, ShopMemberRow } from "@zogal/shared";
import type { ShopInvitationRow } from "./types.js";

/**
 * Staff management reads for the web dashboard (Stage 8). The writes
 * already exist on AuthRepository (setMemberRole, setMemberActive,
 * setPermissionOverride, invite, revokeInvitation, createCustomRole).
 */
export type StaffRow = ShopMemberRow & {
  users: { full_name: string; email: string; phone: string | null } | null;
  roles: Pick<RoleRow, "name" | "key" | "is_system"> | null;
};

export async function listStaff(db: SupabaseClient, shopId: string): Promise<StaffRow[]> {
  const { data, error } = await db
    .from("shop_members")
    .select("*, users(full_name, email, phone), roles(name, key, is_system)")
    .eq("shop_id", shopId)
    .order("joined_at");
  if (error) throw error;
  return data as unknown as StaffRow[];
}

export async function listInvitations(db: SupabaseClient, shopId: string): Promise<ShopInvitationRow[]> {
  const { data, error } = await db
    .from("shop_invitations")
    .select<"*", ShopInvitationRow>()
    .eq("shop_id", shopId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export interface PermissionOverrideRow { shop_id: string; user_id: string; permission_key: Permission; allowed: boolean }

export async function listPermissionOverrides(db: SupabaseClient, shopId: string): Promise<PermissionOverrideRow[]> {
  const { data, error } = await db
    .from("member_permission_overrides")
    .select("shop_id, user_id, permission_key, allowed")
    .eq("shop_id", shopId);
  if (error) throw error;
  return data as PermissionOverrideRow[];
}

export async function listRolePermissions(db: SupabaseClient, roleIds: string[]): Promise<Record<string, Permission[]>> {
  if (roleIds.length === 0) return {};
  const { data, error } = await db.from("role_permissions").select("role_id, permission_key").in("role_id", roleIds);
  if (error) throw error;
  const out: Record<string, Permission[]> = {};
  for (const r of data as { role_id: string; permission_key: Permission }[]) (out[r.role_id] ??= []).push(r.permission_key);
  return out;
}
