/**
 * Row types mirroring supabase/migrations/0001_foundation.sql.
 *
 * Hand-written for now; once the migration is applied, replace with
 * `supabase gen types typescript` output and keep these as the canonical
 * import surface (so callers never import generated types directly).
 *
 * numeric(14,2) columns arrive as strings from PostgREST — convert with
 * toKobo() at the module boundary, never do math on the raw string.
 */

export type UUID = string;
export type ISOTimestamp = string;
/** DB numeric(14,2) as returned by PostgREST. */
export type NumericString = string;

export interface ShopRow {
  id: UUID;
  name: string;
  timezone: string;
  currency: string;
  is_active: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface UserRow {
  id: UUID;
  auth_user_id: UUID | null;
  email: string | null;
  full_name: string;
  phone: string | null;
  is_active: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface RoleRow {
  id: UUID;
  shop_id: UUID | null;
  key: string;
  name: string;
  is_system: boolean;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface ShopMemberRow {
  shop_id: UUID;
  user_id: UUID;
  role_id: UUID;
  is_active: boolean;
  joined_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface MemberPermissionOverrideRow {
  shop_id: UUID;
  user_id: UUID;
  permission_key: string;
  allowed: boolean;
  set_by: UUID | null;
  created_at: ISOTimestamp;
}

export interface ItemRow {
  id: UUID;
  shop_id: UUID;
  name: string;
  floor_price: NumericString;
  suggested_price: NumericString;
  is_active: boolean;
  created_by: UUID | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface BarcodeRow {
  id: UUID;
  shop_id: UUID;
  item_id: UUID;
  code: string;
  source: "manufacturer" | "generated";
  created_at: ISOTimestamp;
}

export interface PriceChangeRow {
  id: UUID;
  shop_id: UUID;
  item_id: UUID;
  field: "floor_price" | "suggested_price";
  old_value: NumericString | null;
  new_value: NumericString;
  reason: string | null;
  changed_by: UUID | null;
  created_at: ISOTimestamp;
}

export interface PurchaseRow {
  id: UUID;
  shop_id: UUID;
  supplier_name: string | null;
  note: string | null;
  purchased_at: ISOTimestamp;
  created_by: UUID | null;
  created_at: ISOTimestamp;
}

export interface BatchRow {
  id: UUID;
  shop_id: UUID;
  item_id: UUID;
  purchase_id: UUID | null;
  quantity_received: number;
  quantity_remaining: number;
  unit_cost: NumericString;
  purchased_at: ISOTimestamp;
  created_by: UUID | null;
  created_at: ISOTimestamp;
}

export interface PurchaseCostCorrectionRow {
  id: UUID;
  shop_id: UUID;
  batch_id: UUID;
  old_unit_cost: NumericString;
  new_unit_cost: NumericString;
  reason: string;
  corrected_by: UUID | null;
  created_at: ISOTimestamp;
}

export interface SaleRow {
  id: UUID;
  shop_id: UUID;
  client_ref: UUID;
  sold_by: UUID | null;
  device_id: UUID | null;
  sold_at: ISOTimestamp;
  status: "completed" | "voided";
  total: NumericString;
  note: string | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

export interface SaleLineRow {
  id: UUID;
  sale_id: UUID;
  shop_id: UUID;
  item_id: UUID;
  quantity: number;
  unit_price: NumericString;
  floor_price_at_sale: NumericString;
  created_at: ISOTimestamp;
}

export interface SaleLineAllocationRow {
  id: UUID;
  sale_line_id: UUID;
  batch_id: UUID;
  shop_id: UUID;
  quantity: number;
  unit_cost: NumericString;
  created_at: ISOTimestamp;
}

export interface ItemStockRow {
  shop_id: UUID;
  item_id: UUID;
  name: string;
  on_hand: number;
  stock_value: NumericString;
}
