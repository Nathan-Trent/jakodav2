import type { Permission } from "@jakoda/auth-permissions";
import {
  IconBox,
  IconCash,
  IconChartBar,
  IconDeviceDesktop,
  IconLayoutDashboard,
  IconReceipt,
  IconReceiptTax,
  IconSettings,
  IconShoppingCart,
  IconTruckDelivery,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";

export type PageKey =
  | "dashboard" | "sell" | "items" | "purchases" | "expenses"
  | "staff" | "devices" | "reports" | "tax" | "settings";

export interface NavItem {
  key: PageKey;
  label: string;
  icon: Icon;
  /** Any of these permissions shows the item; omit = everyone in the shop. */
  anyOf?: Permission[];
  /** Set when the section isn't built yet — renders a "coming" page. */
  comingIn?: { stage: number; what: string };
}

/**
 * The full navigation of the product, in build order. Unbuilt sections are
 * listed deliberately so the app reads as one system with a plan, not a
 * skeleton — each shows what's coming and when (TRD §9 build sequence).
 */
export const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: IconLayoutDashboard },
  { key: "sell", label: "Sell", icon: IconShoppingCart, anyOf: ["sales.create"] },
  { key: "items", label: "Items", icon: IconBox },
  { key: "purchases", label: "Purchases", icon: IconTruckDelivery, anyOf: ["purchases.create"],
    comingIn: { stage: 4, what: "Restock by scanning, batch history, cost corrections" } },
  { key: "expenses", label: "Expenses", icon: IconCash, anyOf: ["expenses.create", "expenses.view"],
    comingIn: { stage: 6, what: "Categorised expense log feeding true profit" } },
  { key: "staff", label: "Staff", icon: IconUsers, anyOf: ["users.manage"],
    comingIn: { stage: 8, what: "Invite staff, roles, per-person permissions, manager PINs" } },
  { key: "devices", label: "Terminals", icon: IconDeviceDesktop, anyOf: ["shop.settings"] },
  { key: "reports", label: "Reports", icon: IconChartBar, anyOf: ["reports.view"],
    comingIn: { stage: 8, what: "Sales, profit, stock and staff performance over any period" } },
  { key: "tax", label: "Tax", icon: IconReceiptTax, anyOf: ["tax.view"],
    comingIn: { stage: 6, what: "Live turnover tracking, what's due, filing status" } },
  { key: "settings", label: "Settings", icon: IconSettings, anyOf: ["shop.settings"],
    comingIn: { stage: 8, what: "Shop details, receipts, subscription" } },
];

export const RECEIPT_ICON = IconReceipt;

export function visibleNav(perms: readonly Permission[]): NavItem[] {
  return NAV.filter((n) => !n.anyOf || n.anyOf.some((p) => perms.includes(p)));
}
