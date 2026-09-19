import type { Permission } from "@zogal/auth-permissions";
import {
  IconAlertTriangle, IconChartBar, IconCreditCard, IconDeviceDesktop,
  IconLayoutDashboard, IconReceiptTax, IconSettings, IconUsers, type Icon,
} from "@tabler/icons-react";

/**
 * Two separate products on one deployment (Nathan, 2026-09-13):
 *   /            the shop owner's dashboard
 *   /admin/...   retired — points people to ops.business.zogal.app.
 */
export type ShopPage = "overview" | "reports" | "staff" | "devices" | "tax" | "conflicts" | "subscription" | "settings";

export interface NavItem<K extends string> { key: K; label: string; icon: Icon; anyOf?: Permission[] }

export const SHOP_NAV: NavItem<ShopPage>[] = [
  { key: "overview", label: "Overview", icon: IconLayoutDashboard },
  { key: "reports", label: "Reports", icon: IconChartBar, anyOf: ["reports.view"] },
  { key: "staff", label: "Staff", icon: IconUsers, anyOf: ["users.manage"] },
  { key: "devices", label: "Terminals", icon: IconDeviceDesktop, anyOf: ["shop.settings"] },
  { key: "tax", label: "Tax", icon: IconReceiptTax, anyOf: ["tax.view"] },
  { key: "conflicts", label: "Sync issues", icon: IconAlertTriangle, anyOf: ["reports.view"] },
  { key: "subscription", label: "Subscription", icon: IconCreditCard, anyOf: ["shop.settings"] },
  { key: "settings", label: "Settings", icon: IconSettings, anyOf: ["shop.settings"] },
];


export function visibleShopNav(perms: readonly Permission[]): NavItem<ShopPage>[] {
  return SHOP_NAV.filter((n) => !n.anyOf || n.anyOf.some((p) => perms.includes(p)));
}

export const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");

export function shopPageFromPath(path: string): ShopPage {
  const k = path.replace(/^\//, "") as ShopPage;
  return SHOP_NAV.some((n) => n.key === k) ? k : "overview";
}
export const shopPath = (p: ShopPage): string => (p === "overview" ? "/" : `/${p}`);
