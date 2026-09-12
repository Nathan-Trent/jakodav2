/**
 * The fixed permission list (TRD §5). Must stay in lock-step with the
 * `permissions` table seed in supabase/migrations/0001_foundation.sql —
 * the DB is the source of truth; this gives the client a typed key.
 */
export const PERMISSIONS = [
  "sales.create",
  "sales.void",
  "sales.view_all",
  "customers.manage",
  "items.create",
  "items.edit",
  "items.edit_floor_price",
  "items.view_cost",
  "items.view_margin",
  "purchases.create",
  "purchases.correct_cost",
  "expenses.create",
  "expenses.view",
  "reports.view",
  "reports.view_staff_perf",
  "tax.view",
  "tax.mark_filed",
  "users.manage",
  "roles.manage",
  "shop.settings",
  "overrides.approve",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(key: string): key is Permission {
  return (PERMISSIONS as readonly string[]).includes(key);
}

/** System role ids — fixed UUIDs seeded by the migration. */
export const SYSTEM_ROLE_IDS = {
  owner: "00000000-0000-0000-0000-000000000001",
  manager: "00000000-0000-0000-0000-000000000002",
  salesperson: "00000000-0000-0000-0000-000000000003",
} as const;
