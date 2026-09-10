import type { ISOTimestamp, RoleRow, ShopRow, UserRow, UUID } from "@jakodav/shared";
import type { Permission } from "./permissions.js";

/** Shape returned by get_my_context() — one round trip after login. */
export interface Membership {
  shop: ShopRow;
  role: Pick<RoleRow, "id" | "key" | "name" | "is_system">;
  permissions: Permission[];
}

export interface MyContext {
  user: Omit<UserRow, "auth_user_id"> | null;
  memberships: Membership[];
}

export interface ShopInvitationRow {
  id: UUID;
  shop_id: UUID;
  email: string;
  role_id: UUID;
  invited_by: UUID | null;
  expires_at: ISOTimestamp;
  accepted_at: ISOTimestamp | null;
  accepted_by: UUID | null;
  revoked_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
}

/** Client-visible columns of `devices` (credential_hash is never granted). */
export interface DeviceRow {
  id: UUID;
  shop_id: UUID;
  name: string;
  activated_by: UUID | null;
  activated_at: ISOTimestamp;
  last_sync_at: ISOTimestamp | null;
  revoked_at: ISOTimestamp | null;
  created_at: ISOTimestamp;
}

export interface DeviceStatusRow {
  id: UUID;
  shop_id: UUID;
  name: string;
  last_sync_at: ISOTimestamp | null;
  revoked_at: ISOTimestamp | null;
  is_online: boolean;
}

export interface ManagerOverrideRow {
  id: UUID;
  shop_id: UUID;
  requested_by: UUID | null;
  manager_id: UUID | null;
  pin_id: UUID | null;
  action: string;
  reference_id: UUID | null;
  succeeded: boolean;
  created_at: ISOTimestamp;
}

/** Returned once by activate_device(); persist on the device, never re-fetchable. */
export interface DeviceActivation {
  device_id: UUID;
  shop_id: UUID;
  credential: string;
}

export interface DeviceHeartbeat {
  shop_id: UUID;
  subscription_token: string | null;
  server_time: ISOTimestamp;
}
