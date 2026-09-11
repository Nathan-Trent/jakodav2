import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BatchRow,
  ItemRow,
  ItemStockRow,
  PurchaseCostCorrectionRow,
  PurchaseRow,
  SaleRow,
} from "@jakoda/shared";
import {
  CostCorrectionSchema,
  NewItemSchema,
  NewPurchaseSchema,
  NewSaleSchema,
  type CostCorrection,
  type NewItem,
  type NewPurchase,
  type NewSale,
} from "./schemas.js";

/**
 * Online data access for the inventory module. Every write is either a
 * single RLS-checked insert or a call to one of the SECURITY DEFINER SQL
 * functions in 0001_foundation.sql — business rules (FIFO, floor price,
 * batch immutability) are enforced in the database, not re-implemented here.
 *
 * SYNC: Stage 5 will wrap this with an offline queue; keep every method
 * idempotent-friendly (sales already carry client_ref for this).
 */
export class InventoryRepository {
  constructor(private readonly db: SupabaseClient) {}

  async createItem(input: NewItem): Promise<ItemRow> {
    const v = NewItemSchema.parse(input);
    const { data, error } = await this.db
      .from("items")
      .insert({
        shop_id: v.shopId,
        name: v.name,
        floor_price: v.floorPrice,
        suggested_price: v.suggestedPrice,
      })
      .select()
      .single<ItemRow>();
    if (error) throw error;
    return data;
  }

  /**
   * Record a purchase: one purchases row + one immutable batch per line.
   * A new cost always creates a new batch (PRD §6.3) — never touches an
   * existing one.
   */
  async recordPurchase(input: NewPurchase): Promise<{ purchase: PurchaseRow; batches: BatchRow[] }> {
    const v = NewPurchaseSchema.parse(input);
    const { data: purchase, error: pErr } = await this.db
      .from("purchases")
      .insert({
        shop_id: v.shopId,
        supplier_name: v.supplierName ?? null,
        note: v.note ?? null,
        purchased_at: v.purchasedAt ?? new Date().toISOString(),
      })
      .select()
      .single<PurchaseRow>();
    if (pErr) throw pErr;

    const { data: batches, error: bErr } = await this.db
      .from("batches")
      .insert(
        v.lines.map((l) => ({
          shop_id: v.shopId,
          item_id: l.itemId,
          purchase_id: purchase.id,
          quantity_received: l.quantity,
          quantity_remaining: l.quantity,
          unit_cost: l.unitCost,
          purchased_at: purchase.purchased_at,
        })),
      )
      .select<"*", BatchRow>();
    if (bErr) throw bErr;
    return { purchase, batches };
  }

  /** Atomic sale via record_sale(): floor check + FIFO under row locks. */
  async recordSale(input: NewSale): Promise<SaleRow> {
    const v = NewSaleSchema.parse(input);
    const { data, error } = await this.db.rpc("record_sale", {
      p_shop_id: v.shopId,
      p_client_ref: v.clientRef,
      p_sold_by: v.soldBy,
      p_lines: v.lines,
      p_sold_at: v.soldAt ?? new Date().toISOString(),
      p_note: v.note ?? null,
      p_device_id: v.deviceId ?? null,
    });
    if (error) throw error;
    return data as SaleRow;
  }

  /** Logged admin override for a mistyped batch cost. */
  async correctBatchCost(input: CostCorrection): Promise<PurchaseCostCorrectionRow> {
    const v = CostCorrectionSchema.parse(input);
    const { data, error } = await this.db.rpc("correct_batch_cost", {
      p_batch_id: v.batchId,
      p_new_unit_cost: v.newUnitCost,
      p_reason: v.reason,
      p_corrected_by: v.correctedBy,
    });
    if (error) throw error;
    return data as PurchaseCostCorrectionRow;
  }

  async listItems(shopId: string): Promise<ItemRow[]> {
    const { data, error } = await this.db
      .from("items")
      .select<"*", ItemRow>()
      .eq("shop_id", shopId)
      .eq("is_active", true)
      .order("name");
    if (error) throw error;
    return data;
  }

  /** On-hand quantities for every item — visible to all members, no costs. */
  async stockQuantities(shopId: string): Promise<Map<string, number>> {
    const { data, error } = await this.db.rpc("shop_stock", { p_shop_id: shopId });
    if (error) throw error;
    return new Map((data as { item_id: string; on_hand: number }[]).map((r) => [r.item_id, r.on_hand]));
  }

  async recentSales(shopId: string, limit = 20): Promise<SaleRow[]> {
    const { data, error } = await this.db
      .from("sales")
      .select<"*", SaleRow>()
      .eq("shop_id", shopId)
      .order("sold_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  /** Stock with valuation — requires items.view_cost (RLS returns 0 otherwise). */
  async stockOnHand(shopId: string): Promise<ItemStockRow[]> {
    const { data, error } = await this.db
      .from("item_stock")
      .select<"*", ItemStockRow>()
      .eq("shop_id", shopId)
      .order("name");
    if (error) throw error;
    return data;
  }
}
