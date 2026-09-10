import { describe, expect, it } from "vitest";
import type { Kobo } from "@jakodav/shared";
import { allocateFifo, applyAllocation, cogs, InsufficientStockError } from "./fifo.js";

const k = (n: number) => n as Kobo;

const batches = [
  { id: "b2", purchasedAt: "2026-02-01T00:00:00Z", quantityRemaining: 5, unitCost: k(120_000) },
  { id: "b1", purchasedAt: "2026-01-01T00:00:00Z", quantityRemaining: 3, unitCost: k(100_000) },
  { id: "b3", purchasedAt: "2026-02-01T00:00:00Z", quantityRemaining: 2, unitCost: k(130_000) },
];

describe("allocateFifo", () => {
  it("consumes the oldest batch first regardless of input order", () => {
    expect(allocateFifo(batches, 2)).toEqual([{ batchId: "b1", quantity: 2, unitCost: 100_000 }]);
  });

  it("spans batches when one runs out, tie-breaking on id", () => {
    expect(allocateFifo(batches, 9)).toEqual([
      { batchId: "b1", quantity: 3, unitCost: 100_000 },
      { batchId: "b2", quantity: 5, unitCost: 120_000 },
      { batchId: "b3", quantity: 1, unitCost: 130_000 },
    ]);
  });

  it("throws (no partial allocation) when stock is short", () => {
    expect(() => allocateFifo(batches, 11)).toThrow(InsufficientStockError);
  });

  it("rejects non-positive quantities", () => {
    expect(() => allocateFifo(batches, 0)).toThrow(RangeError);
  });

  it("computes true COGS from the consumed batches", () => {
    expect(cogs(allocateFifo(batches, 4))).toBe(3 * 100_000 + 1 * 120_000);
  });

  it("applyAllocation decrements without mutating input", () => {
    const alloc = allocateFifo(batches, 4);
    const after = applyAllocation(batches, alloc);
    expect(after.find((b) => b.id === "b1")?.quantityRemaining).toBe(0);
    expect(after.find((b) => b.id === "b2")?.quantityRemaining).toBe(4);
    expect(batches.find((b) => b.id === "b1")?.quantityRemaining).toBe(3);
  });
});
