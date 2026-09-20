import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Notebook photo capture (Stage 7, PRD §5.6). The client side of
 * `parse-notebook-page`: ask for the quota, send a page, close a scan.
 * Nothing here records a sale — confirmed rows go through recordSale.
 */
export interface ScanQuota {
  enabled: boolean;
  /** null = unlimited on this plan (0027). */
  allowance: number | null;
  used: number;
  remaining: number | null;
  /** day | week | month | year — the plan quota period (0027). */
  period: string;
}

export interface ParsedRow {
  line: number;
  item_text: string;
  item_id: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  confidence: "high" | "medium" | "low";
  note: string | null;
}

export interface ParsedPage {
  page_date: string | null;
  rows: ParsedRow[];
  warnings: string[];
}

export async function fetchScanQuota(db: SupabaseClient, shopId: string): Promise<ScanQuota> {
  const { data, error } = await db.rpc("notebook_scan_quota", { p_shop_id: shopId });
  if (error) throw error;
  return data as ScanQuota;
}

export class ScanError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Send one page image (base64, no data: prefix). Throws ScanError with the server's reason. */
export async function parseNotebookPage(
  db: SupabaseClient, input: { shopId: string; deviceId: string | null; imageBase64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" },
): Promise<{ scanId: string; result: ParsedPage }> {
  const { data, error } = await db.functions.invoke("parse-notebook-page", {
    body: { shop_id: input.shopId, device_id: input.deviceId, image_base64: input.imageBase64, media_type: input.mediaType },
  });
  if (error) {
    // FunctionsHttpError carries the response; surface the server's message.
    const ctx = (error as { context?: Response }).context;
    let msg = error.message;
    let status = 500;
    if (ctx && typeof ctx.json === "function") {
      status = ctx.status;
      try { msg = ((await ctx.json()) as { error?: string }).error ?? msg; } catch { /* keep default */ }
    }
    throw new ScanError(msg, status);
  }
  const d = data as { scan_id: string; result: ParsedPage };
  return { scanId: d.scan_id, result: d.result };
}

export async function closeScan(db: SupabaseClient, scanId: string, status: "confirmed" | "discarded", saleIds: string[] = []): Promise<void> {
  const { error } = await db.rpc("notebook_scan_close", { p_scan_id: scanId, p_status: status, p_sale_ids: saleIds.length ? saleIds : null });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 0029: document kinds. The kind is the screen the user is on, never a menu.
// ---------------------------------------------------------------------------
export type PageKind = "sales" | "items" | "purchase" | "expenses";

export interface ParsedItemRow {
  line: number; name: string; existing_item_id: string | null;
  quantity: number | null; unit_cost: number | null; selling_price: number | null;
  confidence: "high" | "medium" | "low"; note: string | null;
}
export interface ParsedPurchaseRow {
  line: number; item_text: string; item_id: string | null;
  quantity: number | null; unit_cost: number | null; line_total: number | null;
  confidence: "high" | "medium" | "low"; note: string | null;
}
export interface ParsedExpenseRow {
  line: number; description: string; category: "rent" | "transport" | "staff" | "utilities" | "other";
  amount: number | null; date: string | null;
  confidence: "high" | "medium" | "low"; note: string | null;
}
export interface ParsedItemsPage { page_date: string | null; rows: ParsedItemRow[]; warnings: string[] }
export interface ParsedPurchasePage { page_date: string | null; supplier: string | null; rows: ParsedPurchaseRow[]; warnings: string[] }
export interface ParsedExpensesPage { page_date: string | null; rows: ParsedExpenseRow[]; warnings: string[] }

export type ParsedByKind = { sales: ParsedPage; items: ParsedItemsPage; purchase: ParsedPurchasePage; expenses: ParsedExpensesPage };

/** Send one page image of the given kind. Same quota and errors as parseNotebookPage. */
export async function parseDocumentPage<K extends PageKind>(
  db: SupabaseClient,
  input: { kind: K; shopId: string; deviceId: string | null; imageBase64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" },
): Promise<{ scanId: string; result: ParsedByKind[K] }> {
  const { data, error } = await db.functions.invoke("parse-notebook-page", {
    body: { shop_id: input.shopId, device_id: input.deviceId, image_base64: input.imageBase64, media_type: input.mediaType, page_kind: input.kind },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let msg = error.message;
    let status = 500;
    if (ctx && typeof ctx.json === "function") {
      status = ctx.status;
      try { msg = ((await ctx.json()) as { error?: string }).error ?? msg; } catch { /* keep default */ }
    }
    throw new ScanError(msg, status);
  }
  const d = data as { scan_id: string; result: ParsedByKind[K] };
  return { scanId: d.scan_id, result: d.result };
}
