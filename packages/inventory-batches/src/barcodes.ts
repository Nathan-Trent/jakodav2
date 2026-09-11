import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { BarcodeRow, ItemRow, NumericString } from "@jakoda/shared";
import { z } from "zod";

/**
 * Barcodes are store-scoped (PRD §5.3): the same code may exist in two
 * shops; a scan in the wrong shop simply finds nothing. All lookups go
 * through RLS-filtered reads, so this module never has to think about it.
 */

export interface ScannedItem {
  item_id: string;
  name: string;
  floor_price: NumericString;
  suggested_price: NumericString;
  is_active: boolean;
}

/** Manufacturer codes: EAN-8/13, UPC-A, or Code128-ish alphanumerics. */
export const ManualBarcodeSchema = z
  .string()
  .trim()
  .min(4, "Too short for a barcode")
  .max(64)
  .regex(/^[A-Za-z0-9\-_.]+$/, "Only letters, digits, - _ . are allowed");

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const sum = d.slice(0, 12).reduce((s, n, i) => s + (i % 2 === 0 ? n : n * 3), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

export async function lookupBarcode(db: SupabaseClient, shopId: string, code: string): Promise<ScannedItem | null> {
  const { data, error } = await db.rpc("lookup_barcode", { p_shop_id: shopId, p_code: code });
  if (error) throw error;
  const rows = data as ScannedItem[];
  return rows[0] ?? null;
}

export async function listBarcodes(db: SupabaseClient, shopId: string): Promise<BarcodeRow[]> {
  const { data, error } = await db.from("barcodes").select<"*", BarcodeRow>().eq("shop_id", shopId);
  if (error) throw error;
  return data;
}

/** System-generated EAN-13 (GS1 in-store prefix), unique within the shop. */
export async function generateBarcode(db: SupabaseClient, itemId: string): Promise<BarcodeRow> {
  const { data, error } = await db.rpc("generate_barcode", { p_item_id: itemId });
  if (error) throw error;
  return data as BarcodeRow;
}

/** Attach an existing manufacturer code. Unique per shop — 23505 on clash. */
export async function addManufacturerBarcode(db: SupabaseClient, shopId: string, itemId: string, code: string): Promise<BarcodeRow> {
  const clean = ManualBarcodeSchema.parse(code);
  const { data, error } = await db
    .from("barcodes")
    .insert({ shop_id: shopId, item_id: itemId, code: clean, source: "manufacturer" })
    .select()
    .single<BarcodeRow>();
  if (error) throw error;
  return data;
}

export async function removeBarcode(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("barcodes").delete().eq("id", id);
  if (error) throw error;
}

/** Atomic, logged selling-price change (set_item_prices, 0006). */
export async function setItemPrices(
  db: SupabaseClient,
  input: { itemId: string; floorPrice: string; suggestedPrice: string; reason?: string | undefined },
): Promise<ItemRow> {
  const { data, error } = await db.rpc("set_item_prices", {
    p_item_id: input.itemId,
    p_floor: input.floorPrice,
    p_suggested: input.suggestedPrice,
    p_reason: input.reason ?? null,
  });
  if (error) throw error;
  return data as ItemRow;
}

// ---------------------------------------------------------------------------
// SYNC: multi-terminal stock signal (PRD §6.2 "simultaneous sales in real
// time"). A per-shop broadcast channel; the payload carries no data, only
// "something changed — refetch". Supabase-specific transport, trivially
// replaceable by polling (which the hook below also does as a fallback).
// ---------------------------------------------------------------------------
export function stockChannel(db: SupabaseClient, shopId: string): RealtimeChannel {
  return db.channel(`shop:${shopId}:stock`, { config: { broadcast: { self: false } } });
}

export async function announceStockChange(channel: RealtimeChannel, deviceId: string | null): Promise<void> {
  await channel.send({ type: "broadcast", event: "stock", payload: { device_id: deviceId, at: Date.now() } });
}
