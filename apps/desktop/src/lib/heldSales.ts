import type { ItemRow } from "@zogal/shared";
import type { PaymentType } from "@zogal/shared";
import type { OfflineCustomerRef } from "@/lib/shopView";

/**
 * Held sales — a cart parked mid-sale so the cashier can serve the next
 * customer (transfer still pending, "let me grab one more thing") and come
 * back to it. Nothing is sold and no stock moves until it is resumed and
 * recorded like any other sale.
 *
 * SYNC: deliberately NOT synced. A held sale is local to this terminal and
 * survives a restart (localStorage, keyed per shop); it never reaches the
 * outbox or the server. Resuming it on another terminal would need a server
 * table and a sync path — out of scope (Nathan, 2026-09-19).
 */
export interface HeldLine {
  item: ItemRow;
  qtyText: string;
  priceText: string;
}

export interface HeldSale {
  id: string;
  heldAt: string;
  lines: HeldLine[];
  customer: OfflineCustomerRef | null;
  paymentType: PaymentType | null;
}

const key = (shopId: string) => `doka.held.${shopId}`;

export function loadHeld(shopId: string): HeldSale[] {
  try {
    const raw = localStorage.getItem(key(shopId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as HeldSale[]) : [];
  } catch {
    return [];
  }
}

export function saveHeld(shopId: string, held: HeldSale[]): void {
  try {
    if (held.length === 0) localStorage.removeItem(key(shopId));
    else localStorage.setItem(key(shopId), JSON.stringify(held));
  } catch { /* storage full or blocked: the in-memory list still works this session */ }
}

/** "just now", "4 min ago", "2 h ago" — enough to tell held sales apart. */
export function heldAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}
