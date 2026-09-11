import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "@zogal/sync";
import { composeView, type ShopSnapshot } from "./shopView";

/**
 * composeView is what the till trusts when there is no network. These pin the
 * three things Nathan asked for: offline sales lower stock, appear in history
 * marked as unsent, and count in today's figures — computed locally.
 */

const item = (id: string, name: string) => ({
  id, shop_id: "shop", name, floor_price: "1000.00", suggested_price: "1500.00",
  is_active: true, created_by: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
});

const batch = (id: string, itemId: string, remaining: number, cost: string, at: string) => ({
  id, shop_id: "shop", item_id: itemId, purchase_id: null, quantity_received: remaining, quantity_remaining: remaining,
  unit_cost: cost, purchased_at: at, created_by: null, created_at: at,
});

const snapshot: ShopSnapshot = {
  items: [item("a", "Phone case"), item("b", "Charger")],
  barcodes: [],
  stock: { a: 10, b: 3 },
  stockValue: { a: 600_000, b: 150_000 },
  batches: [
    batch("b1", "a", 4, "500.00", "2026-09-01T00:00:00Z"),
    batch("b2", "a", 6, "700.00", "2026-09-02T00:00:00Z"),
    batch("b3", "b", 3, "500.00", "2026-09-01T00:00:00Z"),
  ],
  purchases: [],
  devices: [],
  sales: [{
    id: "s-server", shop_id: "shop", client_ref: "r0", sold_by: "u", device_id: "d", sold_at: "2026-09-11T08:00:00Z",
    status: "completed", total: "1500.00", note: null, created_at: "2026-09-11T08:00:00Z", updated_at: "2026-09-11T08:00:00Z",
  }],
  dashboard: {
    today: { date: "2026-09-11", sales_count: 1, sales_total: 1500, units_sold: 1, gross_profit: 1000 },
    week: [], stock: { items: 2, units: 13, value: 750_000, low_stock: 0 },
    devices: { total: 1, online: 1 }, staff: { total: 1 }, scope: "shop",
  },
};

function offlineSale(ref: string, lines: { item_id: string; quantity: number; unit_price: string }[], at = new Date().toISOString()): OutboxEntry<{ lines: (typeof lines[number] & { floor_price_at_sale: string })[]; note: null }> {
  return {
    seq: 1, kind: "sale", clientRef: ref, shopId: "shop", deviceId: "d", userId: "nathan", occurredAt: at,
    payload: { lines: lines.map((l) => ({ ...l, floor_price_at_sale: "1000.00" })), note: null },
    attempts: 0, lastError: null, syncedAt: null,
  };
}

describe("composeView — offline sales are visible everywhere", () => {
  it("is the snapshot untouched when nothing is queued", () => {
    const v = composeView(snapshot, [], true);
    expect(v.stock).toEqual({ a: 10, b: 3 });
    expect(v.sales.map((s) => s.pending)).toEqual([false]);
    expect(v.pendingSales).toBe(0);
    expect(v.dashboard?.today.sales_count).toBe(1);
  });

  it("lowers stock by what was sold offline", () => {
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "a", quantity: 3, unit_price: "1500.00" }])], true);
    expect(v.stock.a).toBe(7);
    expect(v.stock.b).toBe(3);
  });

  it("never lets stock go negative even if the overlay outruns the snapshot", () => {
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "b", quantity: 99, unit_price: "1500.00" }])], true);
    expect(v.stock.b).toBe(0);
  });

  it("puts unsent sales at the top of history, marked pending, with the seller", () => {
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "a", quantity: 2, unit_price: "1500.00" }])], true);
    expect(v.sales[0]?.pending).toBe(true);
    expect(v.sales[0]?.id).toBe("r1");
    expect(v.sales[0]?.sold_by).toBe("nathan");
    expect(v.sales[0]?.total).toBe("3000.00");
    expect(v.sales[1]?.pending).toBe(false);
    expect(v.pendingSales).toBe(1);
  });

  it("adds today's unsent sales to takings, count and units — and profit via local FIFO", () => {
    // 3 × ₦1,500 from item a: FIFO takes 3 from the ₦500 batch → profit 3 × 1,000 = 3,000
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "a", quantity: 3, unit_price: "1500.00" }])], true);
    expect(v.dashboard?.today.sales_count).toBe(2);
    expect(v.dashboard?.today.units_sold).toBe(4);
    expect(v.dashboard?.today.sales_total).toBe(1500 + 4500);
    expect(v.dashboard?.today.gross_profit).toBe(1000 + 3000);
  });

  it("spans batches for profit the way the server would", () => {
    // 6 from item a: 4 @ 500 then 2 @ 700 → cost 3,400 → profit 9,000 − 3,400 = 5,600
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "a", quantity: 6, unit_price: "1500.00" }])], true);
    expect(v.dashboard?.today.gross_profit).toBe(1000 + 5600);
  });

  it("does not invent a profit figure for a salesperson who can't see costs", () => {
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "a", quantity: 3, unit_price: "1500.00" }])], false);
    expect(v.dashboard?.today.sales_total).toBe(6000);
    expect(v.dashboard?.today.gross_profit).toBe(1000); // untouched, not fabricated
  });

  it("leaves yesterday's unsent sales out of today's figures but in history", () => {
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "a", quantity: 1, unit_price: "1500.00" }], "2026-01-01T10:00:00Z")], true);
    expect(v.dashboard?.today.sales_count).toBe(1);
    expect(v.sales[0]?.pending).toBe(true);
    expect(v.stock.a).toBe(9);
  });

  it("recomputes low-stock from the overlaid stock", () => {
    const v = composeView(snapshot, [offlineSale("r1", [{ item_id: "b", quantity: 2, unit_price: "1500.00" }])], true);
    expect(v.stock.b).toBe(1);
    expect(v.dashboard?.stock.low_stock).toBe(1);
  });
});
