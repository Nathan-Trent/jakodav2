import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { RoleRow, ShopMemberRow, ShopRow } from "@jakoda/shared";
import { z } from "zod";
import { isPermission, type Permission } from "./permissions.js";
import type {
  DeviceActivation,
  DeviceHeartbeat,
  DeviceRow,
  DeviceStatusRow,
  ManagerOverrideRow,
  MyContext,
  ShopInvitationRow,
} from "./types.js";

const email = z.string().trim().toLowerCase().email();

/**
 * Auth + tenancy operations. Login itself is Supabase Auth (the one
 * non-portable piece, confined to signIn/signUp/signOut); everything else
 * hits our own tables via the definer functions in 0002_auth_roles.sql.
 */
export class AuthRepository {
  constructor(private readonly db: SupabaseClient) {}

  // ---- login mechanism (Supabase Auth) -----------------------------------

  async signUp(input: { email: string; password: string; fullName: string }): Promise<void> {
    const { error } = await this.db.auth.signUp({
      email: email.parse(input.email),
      password: input.password,
      // picked up by handle_new_auth_user() → public.users.full_name
      options: { data: { full_name: input.fullName.trim() } },
    });
    if (error) throw error;
  }

  async signIn(input: { email: string; password: string }): Promise<Session> {
    const { data, error } = await this.db.auth.signInWithPassword({
      email: email.parse(input.email),
      password: input.password,
    });
    if (error) throw error;
    return data.session;
  }

  async signOut(): Promise<void> {
    const { error } = await this.db.auth.signOut();
    if (error) throw error;
  }

  // ---- bootstrap -----------------------------------------------------------

  /**
   * Call right after login: accepts any pending invitations for the user's
   * verified email, then returns user + memberships + effective permissions.
   */
  async bootstrap(): Promise<MyContext> {
    const { error: invErr } = await this.db.rpc("accept_my_invitations");
    if (invErr) throw invErr;
    return this.getMyContext();
  }

  async getMyContext(): Promise<MyContext> {
    const { data, error } = await this.db.rpc("get_my_context");
    if (error) throw error;
    const ctx = data as MyContext;
    // Defensive: drop any permission key the client doesn't know (DB seed ahead of client).
    for (const m of ctx.memberships) {
      m.permissions = m.permissions.filter((p): p is Permission => isPermission(p));
    }
    return ctx;
  }

  // ---- shops & members -----------------------------------------------------

  async createShop(name: string): Promise<ShopRow> {
    const { data, error } = await this.db.rpc("create_shop", { p_name: name.trim() });
    if (error) throw error;
    return data as ShopRow;
  }

  async listMembers(shopId: string): Promise<ShopMemberRow[]> {
    const { data, error } = await this.db
      .from("shop_members")
      .select<"*", ShopMemberRow>()
      .eq("shop_id", shopId);
    if (error) throw error;
    return data;
  }

  async setMemberRole(shopId: string, userId: string, roleId: string): Promise<void> {
    const { error } = await this.db
      .from("shop_members")
      .update({ role_id: roleId })
      .eq("shop_id", shopId)
      .eq("user_id", userId);
    if (error) throw error;
  }

  async setMemberActive(shopId: string, userId: string, isActive: boolean): Promise<void> {
    const { error } = await this.db
      .from("shop_members")
      .update({ is_active: isActive })
      .eq("shop_id", shopId)
      .eq("user_id", userId);
    if (error) throw error;
  }

  /** Per-person grant/revoke on top of the role (PRD §4). */
  async setPermissionOverride(
    shopId: string,
    userId: string,
    permission: Permission,
    allowed: boolean | null,
  ): Promise<void> {
    const q = this.db.from("member_permission_overrides");
    const { error } =
      allowed === null
        ? await q.delete().match({ shop_id: shopId, user_id: userId, permission_key: permission })
        : await q.upsert({ shop_id: shopId, user_id: userId, permission_key: permission, allowed });
    if (error) throw error;
  }

  // ---- invitations ---------------------------------------------------------

  async invite(input: {
    shopId: string;
    email: string;
    roleId: string;
    invitedBy: string;
  }): Promise<ShopInvitationRow> {
    const { data, error } = await this.db
      .from("shop_invitations")
      .insert({
        shop_id: input.shopId,
        email: email.parse(input.email),
        role_id: input.roleId,
        invited_by: input.invitedBy,
      })
      .select()
      .single<ShopInvitationRow>();
    if (error) throw error;
    return data;
  }

  async revokeInvitation(id: string): Promise<void> {
    const { error } = await this.db
      .from("shop_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  }

  // ---- roles ---------------------------------------------------------------

  async listRoles(shopId: string): Promise<RoleRow[]> {
    const { data, error } = await this.db
      .from("roles")
      .select<"*", RoleRow>()
      .or(`shop_id.is.null,shop_id.eq.${shopId}`)
      .order("is_system", { ascending: false })
      .order("name");
    if (error) throw error;
    return data;
  }

  async createCustomRole(input: {
    shopId: string;
    key: string;
    name: string;
    permissions: Permission[];
  }): Promise<RoleRow> {
    const { data, error } = await this.db.rpc("create_custom_role", {
      p_shop_id: input.shopId,
      p_key: input.key,
      p_name: input.name,
      p_permissions: input.permissions,
    });
    if (error) throw error;
    return data as RoleRow;
  }

  // ---- manager PINs --------------------------------------------------------

  /** The caller's own current PIN (minted/rotated lazily). Show only to them. */
  async getMyManagerPin(shopId: string): Promise<{ pin: string; expires_at: string }> {
    const { data, error } = await this.db.rpc("get_my_manager_pin", { p_shop_id: shopId });
    if (error) throw error;
    const row = (data as { pin: string; expires_at: string }[])[0];
    if (!row) throw new Error("no PIN returned");
    return row;
  }

  /** Returns the approving manager's user id, or throws on a bad PIN. */
  async authorizeOverride(input: {
    shopId: string;
    pin: string;
    action: string;
    referenceId?: string;
  }): Promise<string> {
    const { data, error } = await this.db.rpc("authorize_override", {
      p_shop_id: input.shopId,
      p_pin: input.pin,
      p_action: input.action,
      p_reference_id: input.referenceId ?? null,
    });
    if (error) throw error;
    return data as string;
  }

  async listOverrides(shopId: string, limit = 100): Promise<ManagerOverrideRow[]> {
    const { data, error } = await this.db
      .from("manager_overrides")
      .select<"*", ManagerOverrideRow>()
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  // ---- devices -------------------------------------------------------------

  async createActivationCode(shopId: string): Promise<{ code: string; expires_at: string }> {
    const { data, error } = await this.db.rpc("create_device_activation_code", { p_shop_id: shopId });
    if (error) throw error;
    const row = (data as { code: string; expires_at: string }[])[0];
    if (!row) throw new Error("no code returned");
    return row;
  }

  /** Desktop first-run. Works unauthenticated. Persist the result locally. */
  async activateDevice(code: string, deviceName: string): Promise<DeviceActivation> {
    const { data, error } = await this.db.rpc("activate_device", {
      p_code: code.trim().toUpperCase(),
      p_device_name: deviceName.trim(),
    });
    if (error) throw error;
    const row = (data as DeviceActivation[])[0];
    if (!row) throw new Error("activation returned no device");
    return row;
  }

  /** SYNC: call after every successful sync to stamp last_sync_at. */
  async deviceHeartbeat(deviceId: string, credential: string): Promise<DeviceHeartbeat> {
    const { data, error } = await this.db.rpc("device_heartbeat", {
      p_device_id: deviceId,
      p_credential: credential,
    });
    if (error) throw error;
    const row = (data as DeviceHeartbeat[])[0];
    if (!row) throw new Error("heartbeat returned nothing");
    return row;
  }

  async listDevices(shopId: string): Promise<DeviceStatusRow[]> {
    const { data, error } = await this.db
      .from("device_status")
      .select<"*", DeviceStatusRow>()
      .eq("shop_id", shopId)
      .order("name");
    if (error) throw error;
    return data;
  }

  async revokeDevice(id: string): Promise<DeviceRow> {
    const { data, error } = await this.db
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single<DeviceRow>();
    if (error) throw error;
    return data;
  }
}
