import type { Kobo } from "@jakodav/shared";

/**
 * Pure FIFO allocator. Mirrors consume_batches_fifo() in
 * supabase/migrations/0001_foundation.sql exactly — same ordering
 * (purchased_at, then id), same shortfall behaviour.
 *
 * SYNC: the online path runs the SQL function under row locks. This TS version
 * exists so the offline desktop client (Stage 5) can compute the identical
 * allocation against its local batch cache, and so tests can pin the
 * behaviour without a database. If the SQL changes, this must change with it.
 */

export interface OpenBatch {
  id: string;
  purchasedAt: string; // ISO timestamp
  quantityRemaining: number;
  unitCost: Kobo;
}

export interface Allocation {
  batchId: string;
  quantity: number;
  unitCost: Kobo;
}

export class InsufficientStockError extends Error {
  constructor(
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`insufficient_stock: requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
  }
}

export function sortFifo(batches: readonly OpenBatch[]): OpenBatch[] {
  return [...batches].sort(
    (a, b) => a.purchasedAt.localeCompare(b.purchasedAt) || a.id.localeCompare(b.id),
  );
}

/**
 * Allocate `quantity` units from the oldest batches first.
 * Does not mutate input. Throws InsufficientStockError if stock is short —
 * never returns a partial allocation (matches the SQL rollback).
 */
export function allocateFifo(batches: readonly OpenBatch[], quantity: number): Allocation[] {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError("quantity must be a positive integer");
  }
  const out: Allocation[] = [];
  let needed = quantity;
  for (const b of sortFifo(batches)) {
    if (needed === 0) break;
    if (b.quantityRemaining <= 0) continue;
    const take = Math.min(b.quantityRemaining, needed);
    out.push({ batchId: b.id, quantity: take, unitCost: b.unitCost });
    needed -= take;
  }
  if (needed > 0) {
    const available = batches.reduce((s, b) => s + Math.max(0, b.quantityRemaining), 0);
    throw new InsufficientStockError(quantity, available);
  }
  return out;
}

/** Apply an allocation to a batch list, returning the decremented copy. */
export function applyAllocation(
  batches: readonly OpenBatch[],
  allocation: readonly Allocation[],
): OpenBatch[] {
  const taken = new Map(allocation.map((a) => [a.batchId, a.quantity]));
  return batches.map((b) => {
    const t = taken.get(b.id) ?? 0;
    return t ? { ...b, quantityRemaining: b.quantityRemaining - t } : b;
  });
}

/** Cost of goods sold for an allocation, in kobo. */
export function cogs(allocation: readonly Allocation[]): Kobo {
  return allocation.reduce((s, a) => s + a.unitCost * a.quantity, 0) as Kobo;
}
