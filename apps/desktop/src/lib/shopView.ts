import type { BarcodeRow, BatchRow, CustomerRow, ItemRow, PurchaseRow, SaleRow } from "@zogal/shared";
import type { DeviceStatusRow } from "@zogal/auth-permissions";
import { toKobo } from "@zogal/shared";
import { allocateFifo, applyAllocation, cogs, type OpenBatch, type ShopDashboard } from "@zogal/inventory-batches";
import type { OutboxEntry } from "@zogal/sync";
import type { BusinessCategory, ExpenseRow, FiledPeriod, LedgerSummary, ShopTaxProfile, TaxRule, TaxType } from "@zogal/tax-engine";

/**
 * SYNC: snapshot ⊕ overlay — the calculation the till trusts offline.
 *
 * Pure and dependency-free on purpose: it is the piece Nathan will argue
 * with when a number looks wrong, so it must be readable and testable with
 * no React, no database and no network. shopData.tsx wires it to the app.
 */
export interface ShopSnapshot {
  items: ItemRow[];
  barcodes: BarcodeRow[];
  /** itemId → units on hand, per the server. */
  stock: Record<string, number>;
  /** itemId → value of remaining stock, kobo. Only with items.view_cost. */
  stockValue: Record<string, number>;
  batches: BatchRow[];
  /** Recent purchases — lets batches be filtered by the terminal that received them. */
  purchases: PurchaseRow[];
  sales: SaleRow[];
  dashboard: ShopDashboard | null;
  /** The shop's terminals, for names and the terminal filter. */
  devices: DeviceStatusRow[];
  /** Tax: reference data, the shop's declaration, ledger windows, filings. Only with tax.view. */
  tax: TaxSnapshot | null;
  /** Expenses (PRD §6.4). Only with expenses.view / expenses.create. */
  expenses: ExpenseRow[];
  /** The shop's customers (0012) — so the till can attach one offline. */
  customers: CustomerRow[];
}

export interface TaxSnapshot {
  taxTypes: TaxType[];
  categories: BusinessCategory[];
  rules: TaxRule[];
  profile: (ShopTaxProfile & { declaredAt: string }) | null;
  /** Ledger for the assessment year and the current month, as of the snapshot. */
  year: LedgerSummary;
  month: LedgerSummary;
  filed: FiledPeriod[];
}

/** A sale as the screens see it: from the server, or still on this terminal. */
export type ViewSale = SaleRow & {
  /** True while it sits in the outbox. Clears once the server has it. */
  pending: boolean;
  /** Line detail is only known locally for pending sales. */
  lines?: { item_id: string; quantity: number; unit_price: string }[];
  /** Customer name for a pending sale (existing or added offline). */
  customer_name?: string | null;
};

export interface ShopView {
  items: ItemRow[];
  barcodes: BarcodeRow[];
  /** Snapshot stock minus unsent sales. */
  stock: Record<string, number>;
  batches: BatchRow[];
  purchases: PurchaseRow[];
  devices: DeviceStatusRow[];
  /** Pending first (newest), then the server's, newest first. */
  sales: ViewSale[];
  /** Server figures plus unsent sales, computed locally. */
  dashboard: ShopDashboard | null;
  /** How many unsent sales are folded into the figures above. */
  pendingSales: number;
  /** Unsent sales' takings and (if costs are visible) profit — for the live tax figure. */
  pendingTurnover: number;
  pendingProfit: number | null;
  tax: TaxSnapshot | null;
  expenses: ExpenseRow[];
  /** Server list plus customers added offline (from pending sales), deduped. */
  customers: CustomerRow[];
}

/** SYNC: what an offline sale carries. `customer` is resolved server-side on replay (0012). */
export type OfflineCustomerRef = { id: string; name: string } | { name: string; phone: string | null };

export interface OfflineSalePayload {
  lines: { item_id: string; quantity: number; unit_price: string; floor_price_at_sale: string }[];
  note: string | null;
  customer?: OfflineCustomerRef | null;
}

export const EMPTY_SNAPSHOT: ShopSnapshot = { items: [], barcodes: [], stock: {}, stockValue: {}, batches: [], purchases: [], sales: [], dashboard: null, devices: [], tax: null, expenses: [], customers: [] };

/**
 * Apply unsent sales to the server's view. Pure; the calculation the till
 * relies on offline, so it stays simple enough to read in one sitting.
 */
export function composeView(snap: ShopSnapshot, overlay: OutboxEntry<OfflineSalePayload>[], viewCost: boolean): ShopView {
  if (overlay.length === 0) {
    return {
      items: snap.items, barcodes: snap.barcodes, stock: snap.stock, batches: snap.batches,
      purchases: snap.purchases, devices: snap.devices,
      sales: snap.sales.map((s) => ({ ...s, pending: false })),
      dashboard: snap.dashboard, pendingSales: 0, pendingTurnover: 0, pendingProfit: viewCost ? 0 : null,
      tax: snap.tax, expenses: snap.expenses, customers: snap.customers ?? [],
    };
  }

  // Stock: subtract every unsent line.
  const stock = { ...snap.stock };
  for (const e of overlay) for (const l of e.payload.lines) {
    stock[l.item_id] = Math.max(0, (stock[l.item_id] ?? 0) - l.quantity);
  }

  // History: pending first (newest at top), then the server's.
  const pendingSales: ViewSale[] = overlay
    .map((e) => {
      const total = e.payload.lines.reduce((s, l) => s + toKobo(l.unit_price) * l.quantity, 0);
      return {
        id: e.clientRef, shop_id: e.shopId, client_ref: e.clientRef, sold_by: e.userId,
        device_id: e.deviceId, sold_at: e.occurredAt, status: "completed" as const,
        total: (total / 100).toFixed(2), note: e.payload.note,
        customer_id: e.payload.customer && "id" in e.payload.customer ? e.payload.customer.id : null,
        created_at: e.occurredAt, updated_at: e.occurredAt,
        pending: true, lines: e.payload.lines,
        customer_name: e.payload.customer?.name ?? null,
      };
    })
    .sort((a, b) => b.sold_at.localeCompare(a.sold_at));
  const sales: ViewSale[] = [...pendingSales, ...snap.sales.map((s) => ({ ...s, pending: false }))];

  // Customers added offline show in the picker straight away (by phone,
  // else by name), so the same regular isn't typed twice in one outage.
  const customers: CustomerRow[] = [...(snap.customers ?? [])];
  for (const e of overlay) {
    const c = e.payload.customer;
    if (!c || "id" in c) continue;
    const dup = customers.some((x) => (c.phone && x.phone === c.phone) || x.name.toLowerCase() === c.name.toLowerCase());
    if (dup) continue;
    customers.push({
      id: `pending:${e.clientRef}`, shop_id: e.shopId, name: c.name, phone: c.phone, note: null,
      is_active: true, created_by: e.userId, created_at: e.occurredAt, updated_at: e.occurredAt,
    });
  }

  // All unsent sales' takings, and profit via local FIFO — feeds the live
  // tax figure (they belong to the current month/year in practice).
  let pendingTurnover = 0;
  let pendingProfit: number | null = viewCost ? 0 : null;
  {
    let open: OpenBatch[] = viewCost
      ? snap.batches.filter((b) => b.quantity_remaining > 0).map((b) => ({
          id: b.id, purchasedAt: b.purchased_at, quantityRemaining: b.quantity_remaining, unitCost: toKobo(b.unit_cost),
        }))
      : [];
    for (const e of overlay) for (const l of e.payload.lines) {
      const price = toKobo(l.unit_price);
      pendingTurnover += (price * l.quantity) / 100;
      if (pendingProfit === null) continue;
      const mine = open.filter((b) => snap.batches.find((sb) => sb.id === b.id)?.item_id === l.item_id);
      try {
        const alloc = allocateFifo(mine, l.quantity);
        pendingProfit += (price * l.quantity - cogs(alloc)) / 100;
        open = applyAllocation(open, alloc);
      } catch { pendingProfit = null; }
    }
  }

  // Today's figures: add unsent sales that happened today (shop-local day
  // approximated by the terminal's day — the server recomputes on sync).
  let dashboard = snap.dashboard;
  if (dashboard) {
    const today = new Date().toDateString();
    const todays = overlay.filter((e) => new Date(e.occurredAt).toDateString() === today);
    if (todays.length) {
      let takings = 0, units = 0, profit = 0;
      // Local FIFO against cached batches for an honest profit figure — the
      // same allocator the server uses, mirrored in TS for exactly this.
      let open: OpenBatch[] = viewCost
        ? snap.batches.filter((b) => b.quantity_remaining > 0).map((b) => ({
            id: b.id, purchasedAt: b.purchased_at, quantityRemaining: b.quantity_remaining, unitCost: toKobo(b.unit_cost),
          }))
        : [];
      let profitKnown = viewCost;
      for (const e of todays) for (const l of e.payload.lines) {
        const price = toKobo(l.unit_price);
        takings += price * l.quantity;
        units += l.quantity;
        if (!profitKnown) continue;
        const mine = open.filter((b) => snap.batches.find((sb) => sb.id === b.id)?.item_id === l.item_id);
        try {
          const alloc = allocateFifo(mine, l.quantity);
          profit += price * l.quantity - cogs(alloc);
          open = applyAllocation(open, alloc);
        } catch {
          profitKnown = false; // short of stock locally: don't invent a cost
        }
      }
      const n = (v: string | number | null | undefined) => (v == null ? 0 : typeof v === "number" ? v : Number(v));
      dashboard = {
        ...dashboard,
        today: {
          ...dashboard.today,
          sales_count: dashboard.today.sales_count + todays.length,
          units_sold: dashboard.today.units_sold + units,
          sales_total: n(dashboard.today.sales_total) + takings / 100,
          gross_profit: profitKnown && dashboard.today.gross_profit != null
            ? n(dashboard.today.gross_profit) + profit / 100
            : dashboard.today.gross_profit,
        },
        stock: {
          ...dashboard.stock,
          units: Object.values(stock).reduce((s, q) => s + q, 0),
          low_stock: snap.items.filter((i) => i.is_active && (stock[i.id] ?? 0) <= 2).length,
        },
      };
    }
  }

  return {
    items: snap.items, barcodes: snap.barcodes, stock, batches: snap.batches,
    purchases: snap.purchases, devices: snap.devices,
    sales, dashboard, pendingSales: overlay.length, pendingTurnover, pendingProfit,
    tax: snap.tax, expenses: snap.expenses, customers,
  };
}

/** "as of 12:04" / "as of Tue 14:30" — for the staleness notice. */
export function asOf(d: Date | null): string {
  if (!d) return "never";
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
