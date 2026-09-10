import type { Permission } from "./permissions.js";

/**
 * Effective permissions = role permissions ± per-member overrides.
 * Mirrors member_permissions() in the migration; the DB decides for real
 * (RLS + definer functions), this is for UI gating and offline use.
 */
export interface Override {
  permissionKey: string;
  allowed: boolean;
}

export function resolvePermissions(
  rolePermissions: readonly string[],
  overrides: readonly Override[] = [],
): ReadonlySet<Permission> {
  const set = new Set<string>(rolePermissions);
  for (const o of overrides) {
    if (o.allowed) set.add(o.permissionKey);
    else set.delete(o.permissionKey);
  }
  return set as ReadonlySet<Permission>;
}

export function can(perms: ReadonlySet<Permission>, p: Permission): boolean {
  return perms.has(p);
}
