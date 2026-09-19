/**
 * Plan entitlements (0027). What a shop's plan lets it do, edited per plan
 * in the back office, enforced by the server, and carried in the terminal's
 * signed subscription token so an offline terminal enforces the same thing.
 *
 * A key missing from a plan means enabled + unlimited — a feature added to
 * the catalogue later is never silently switched off for existing plans.
 */
export type FeatureKey =
  | "terminals" | "staff" | "shops" | "items" | "customers"
  | "notebook_scans" | "staff_roles" | "tax" | "reports" | "expenses";

export type EntitlementPeriod = "day" | "week" | "month" | "year";

export interface Entitlement {
  enabled: boolean;
  /** Max at once (count) or per period (quota). null/undefined = unlimited. */
  quantity?: number | null;
  /** Quotas only. */
  period?: EntitlementPeriod | null;
}

export type Entitlements = Partial<Record<FeatureKey | string, Entitlement>>;

export interface FeatureCatalogueRow {
  product: string;
  key: FeatureKey | string;
  name: string;
  description: string;
  kind: "toggle" | "count" | "quota";
  unit: string | null;
  sort_order: number;
}

export const UNLIMITED: Readonly<Entitlement> = Object.freeze({ enabled: true, quantity: null, period: null });

/** The plan's answer for one feature; missing key = enabled, unlimited. */
export function entitlementOf(ents: Entitlements | null | undefined, key: FeatureKey | string): Entitlement {
  const e = ents?.[key];
  if (!e) return UNLIMITED;
  return { enabled: e.enabled !== false, quantity: e.quantity ?? null, period: e.period ?? null };
}

export function featureEnabled(ents: Entitlements | null | undefined, key: FeatureKey | string): boolean {
  return entitlementOf(ents, key).enabled;
}

/** "5 scans a day", "3 terminals", "Unlimited items" — same wording the server generates. */
export function entitlementLabel(f: Pick<FeatureCatalogueRow, "name" | "kind" | "unit">, e: Entitlement): string {
  if (!e.enabled) return "Not included";
  if (f.kind === "toggle") return "Included";
  const unit = f.unit ?? "";
  if (e.quantity == null) return `Unlimited ${unit}`;
  const noun = e.quantity === 1 ? unit.replace(/s$/, "") : unit;
  return f.kind === "quota" ? `${e.quantity} ${noun} a ${e.period ?? "month"}` : `${e.quantity} ${noun}`;
}
