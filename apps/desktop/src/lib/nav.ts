import type { Permission } from "@zogal/auth-permissions";
import {
  IconBox,
  IconCash,
  IconChartBar,
  IconAlertTriangle,
  IconDeviceDesktop,
  IconLayoutDashboard,
  IconReceipt,
  IconReceiptTax,
  IconSettings,
  IconShoppingCart,
  IconTruckDelivery,
  IconUsers,
  IconAddressBook,
  IconHistory,
  IconCamera,
  type Icon,
} from "@tabler/icons-react";

export type PageKey =
  | "dashboard" | "sell" | "sales" | "customers" | "notebook" | "items" | "purchases" | "expenses"
  | "staff" | "devices" | "reports" | "tax" | "settings" | "conflicts";

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
  // Everyone: a cashier sees their own sales (RLS), the owner the whole shop.
  { key: "sales", label: "Sales", icon: IconHistory },
  { key: "customers", label: "Customers", icon: IconAddressBook, anyOf: ["sales.create", "customers.manage"] },
  { key: "notebook", label: "Scan a page", icon: IconCamera, anyOf: ["sales.create"] },
  { key: "items", label: "Items", icon: IconBox },
  { key: "purchases", label: "Purchases", icon: IconTruckDelivery, anyOf: ["purchases.create"] },
  { key: "expenses", label: "Expenses", icon: IconCash, anyOf: ["expenses.create", "expenses.view"] },
  { key: "staff", label: "Staff", icon: IconUsers, anyOf: ["users.manage"],
    comingIn: { stage: 8, what: "Invite staff, roles, per-person permissions, manager PINs" } },
  { key: "devices", label: "Terminals", icon: IconDeviceDesktop, anyOf: ["shop.settings"] },
  { key: "conflicts", label: "Sync issues", icon: IconAlertTriangle, anyOf: ["reports.view"] },
  { key: "reports", label: "Reports", icon: IconChartBar, anyOf: ["reports.view"],
    comingIn: { stage: 8, what: "Sales, profit, stock and staff performance over any period" } },
  { key: "tax", label: "Tax", icon: IconReceiptTax, anyOf: ["tax.view"] },
  { key: "settings", label: "Settings", icon: IconSettings, anyOf: ["shop.settings"],
    comingIn: { stage: 8, what: "Shop details, receipts, subscription" } },
];

export const RECEIPT_ICON = IconReceipt;

export function visibleNav(perms: readonly Permission[]): NavItem[] {
  return NAV.filter((n) => !n.anyOf || n.anyOf.some((p) => perms.includes(p)));
}
