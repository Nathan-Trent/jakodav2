import { z } from "zod";

/** Input validation at the module boundary — matches DB check constraints. */

const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amount must be a non-negative number with ≤2 decimals");

export const NewItemSchema = z
  .object({
    shopId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    floorPrice: money,
    suggestedPrice: money,
  })
  .refine((v) => Number(v.suggestedPrice) >= Number(v.floorPrice), {
    message: "suggested price must be ≥ floor price",
    path: ["suggestedPrice"],
  });
export type NewItem = z.infer<typeof NewItemSchema>;

export const NewPurchaseSchema = z.object({
  shopId: z.uuid(),
  supplierName: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
  purchasedAt: z.iso.datetime().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: z.number().int().positive(),
        unitCost: money,
      }),
    )
    .min(1),
});
export type NewPurchase = z.infer<typeof NewPurchaseSchema>;

export const SaleLineInputSchema = z.object({
  item_id: z.uuid(),
  quantity: z.number().int().positive(),
  unit_price: money,
});

export const NewSaleSchema = z.object({
  shopId: z.uuid(),
  /** SYNC: generated on the client so offline replays are idempotent. */
  clientRef: z.uuid(),
  soldBy: z.uuid(),
  /** The activated terminal recording the sale (null while unactivated). */
  deviceId: z.uuid().nullable().optional(),
  soldAt: z.iso.datetime().optional(),
  note: z.string().trim().max(1000).optional(),
  lines: z.array(SaleLineInputSchema).min(1),
});
export type NewSale = z.infer<typeof NewSaleSchema>;

export const CostCorrectionSchema = z.object({
  batchId: z.uuid(),
  newUnitCost: money,
  reason: z.string().trim().min(5).max(1000),
  correctedBy: z.uuid(),
});
export type CostCorrection = z.infer<typeof CostCorrectionSchema>;
