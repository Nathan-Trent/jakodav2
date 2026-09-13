import type { Permission } from "@zogal/auth-permissions";
import {
  IconAlertTriangle, IconBuildingStore, IconChartBar, IconCreditCard, IconDeviceDesktop,
  IconLayoutDashboard, IconReceiptTax, IconSettings, IconAdjustments, IconUsers, type Icon,
} from "@tabler/icons-react";

export type PageKey =
  | "overview" | "reports" | "staff" | "devices" | "tax" | "conflicts" | "subscription" | "settings"
  | "admin_shops" | "admin_platform" | "admin_ops";

export interface NavItem { key: PageKey; label: string; icon: Icon; anyOf?: Permission[]; section: "shop" | "admin" }

/** The control tower's map. Owner sections are permission-gated; admin ones only show to platform admins. */
export const NAV: NavItem[] = [
  { key: "overview", label: "Overview", icon: IconLayoutDashboard, section: "shop" },
  { key: "reports", label: "Reports", icon: IconChartBar, anyOf: ["reports.view"], section: "shop" },
  { key: "staff", label: "Staff", icon: IconUsers, anyOf: ["users.manage"], section: "shop" },
  { key: "devices", label: "Terminals", icon: IconDeviceDesktop, anyOf: ["shop.settings"], section: "shop" },
  { key: "tax", label: "Tax", icon: IconReceiptTax, anyOf: ["tax.view"], section: "shop" },
  { key: "conflicts", label: "Sync issues", icon: IconAlertTriangle, anyOf: ["reports.view"], section: "shop" },
  { key: "subscription", label: "Subscription", icon: IconCreditCard, anyOf: ["shop.settings"], section: "shop" },
  { key: "settings", label: "Settings", icon: IconSettings, anyOf: ["shop.settings"], section: "shop" },
  { key: "admin_shops", label: "Shops", icon: IconBuildingStore, section: "admin" },
  { key: "admin_platform", label: "Platform settings", icon: IconAdjustments, section: "admin" },
  { key: "admin_ops", label: "Operational settings", icon: IconSettings, section: "admin" },
];

export function visibleNav(perms: readonly Permission[], admin: boolean): NavItem[] {
  return NAV.filter((n) => (n.section === "admin" ? admin : !n.anyOf || n.anyOf.some((p) => perms.includes(p))));
}

/** Path ↔ page, so the browser back button and bookmarks work. */
export function pageFromPath(path: string): PageKey {
  const k = path.replace(/^\//, "").replace(/\//g, "_") as PageKey;
  return NAV.some((n) => n.key === k) ? k : "overview";
}
export function pathFor(page: PageKey): string { return "/" + page.replace(/_/g, "/"); }
