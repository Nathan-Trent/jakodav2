import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessCategory, FiledPeriod, LedgerSummary, ShopTaxProfile, TaxRule, TaxType } from "./types.js";

/** Reference data: tax types, categories (with their tax types), all rules. */
export async function loadTaxReference(db: SupabaseClient): Promise<{ taxTypes: TaxType[]; categories: BusinessCategory[]; rules: TaxRule[] }> {
  const [tt, cats, map, rules] = await Promise.all([
    db.from("tax_types").select("*").order("sort_order"),
    db.from("business_categories").select("*").order("sort_order"),
    db.from("business_category_tax_types").select("*"),
    db.from("tax_rules").select("*").order("effective_from", { ascending: false }),
  ]);
  for (const r of [tt, cats, map, rules]) if (r.error) throw r.error;

  type CatRow = { key: string; name: string; description: string };
  type MapRow = { category_key: string; tax_type_key: string };
  type RuleRow = { id: string; tax_type_key: string; kind: TaxRule["kind"]; effective_from: string; effective_to: string | null; verified: boolean; params: unknown };

  const categories: BusinessCategory[] = (cats.data as CatRow[]).map((c) => ({
    key: c.key, name: c.name, description: c.description,
    taxTypes: (map.data as MapRow[]).filter((m) => m.category_key === c.key).map((m) => m.tax_type_key),
  }));
  const taxTypes = (tt.data as TaxType[]);
  const ruleRows = (rules.data as RuleRow[]).map((r) => ({
    id: r.id, taxTypeKey: r.tax_type_key, kind: r.kind, effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to, verified: r.verified, params: r.params,
  })) as TaxRule[];
  return { taxTypes, categories, rules: ruleRows };
}

export async function loadTaxProfile(db: SupabaseClient, shopId: string): Promise<(ShopTaxProfile & { declaredAt: string }) | null> {
  const { data, error } = await db.from("shop_tax_profiles").select("*").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as { shop_id: string; category_key: string; vat_registered: boolean; tin: string | null; fiscal_year_start_month: number; declared_at: string };
  return { shopId: r.shop_id, categoryKey: r.category_key, vatRegistered: r.vat_registered, tin: r.tin, fiscalYearStartMonth: r.fiscal_year_start_month, declaredAt: r.declared_at };
}

export async function declareTaxProfile(db: SupabaseClient, input: { shopId: string; categoryKey: string; vatRegistered: boolean; tin: string | null; declaredBy: string }): Promise<void> {
  const { error } = await db.from("shop_tax_profiles").upsert({
    shop_id: input.shopId, category_key: input.categoryKey, vat_registered: input.vatRegistered,
    tin: input.tin, declared_by: input.declaredBy,
  });
  if (error) throw error;
}

export async function loadLedgerSummary(db: SupabaseClient, shopId: string, from: string, to: string): Promise<LedgerSummary> {
  const { data, error } = await db.rpc("shop_tax_summary", { p_shop_id: shopId, p_from: from, p_to: to });
  if (error) throw error;
  const r = data as Record<string, unknown>;
  const n = (v: unknown) => (v == null ? 0 : Number(v));
  return {
    from, to,
    turnover: n(r.turnover), salesCount: n(r.sales_count), cogs: n(r.cogs),
    expenses: Object.fromEntries(Object.entries((r.expenses as Record<string, unknown>) ?? {}).map(([k, v]) => [k, n(v)])),
    expensesTotal: n(r.expenses_total), grossProfit: n(r.gross_profit), netProfit: n(r.net_profit),
  };
}

export async function loadFiledPeriods(db: SupabaseClient, shopId: string): Promise<FiledPeriod[]> {
  const { data, error } = await db.from("tax_periods").select("*").eq("shop_id", shopId).order("period_start", { ascending: false });
  if (error) throw error;
  return (data as { tax_type_key: string; period_start: string; period_end: string; filed_at: string; reference: string }[])
    .map((p) => ({ taxTypeKey: p.tax_type_key, periodStart: p.period_start, periodEnd: p.period_end, filedAt: p.filed_at, reference: p.reference }));
}

/** PRD §5.7: self-reported filing with the FIRS reference. Locks the period. */
export async function markPeriodFiled(db: SupabaseClient, input: {
  shopId: string; taxTypeKey: string; periodStart: string; periodEnd: string;
  reference: string; evidenceNote: string | null; figures: unknown; filedBy: string;
}): Promise<void> {
  const { error } = await db.from("tax_periods").insert({
    shop_id: input.shopId, tax_type_key: input.taxTypeKey, period_start: input.periodStart, period_end: input.periodEnd,
    reference: input.reference.trim(), evidence_note: input.evidenceNote, figures: input.figures, filed_by: input.filedBy,
  });
  if (error) throw error;
}

// ---- Expenses (PRD §6.4) ---------------------------------------------------
export interface ExpenseRow {
  id: string; shop_id: string; category_key: string; amount: string; incurred_on: string;
  note: string | null; recorded_by: string | null; device_id: string | null;
  amendment_id: string | null; voided_at: string | null; void_reason: string | null; created_at: string;
}

export async function listExpenses(db: SupabaseClient, shopId: string, limit = 200): Promise<ExpenseRow[]> {
  const { data, error } = await db.from("expenses").select("*").eq("shop_id", shopId)
    .order("incurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data as ExpenseRow[];
}

export async function recordExpense(db: SupabaseClient, input: {
  shopId: string; categoryKey: string; amount: string; incurredOn: string; note: string | null;
  recordedBy: string; deviceId: string | null; amendmentId?: string | null;
}): Promise<ExpenseRow> {
  const { data, error } = await db.from("expenses").insert({
    shop_id: input.shopId, category_key: input.categoryKey, amount: input.amount, incurred_on: input.incurredOn,
    note: input.note, recorded_by: input.recordedBy, device_id: input.deviceId, amendment_id: input.amendmentId ?? null,
  }).select().single();
  if (error) throw error;
  return data as ExpenseRow;
}

export async function voidExpense(db: SupabaseClient, id: string, userId: string, reason: string): Promise<void> {
  const { error } = await db.from("expenses").update({ voided_at: new Date().toISOString(), voided_by: userId, void_reason: reason }).eq("id", id);
  if (error) throw error;
}

/** Open a visible correction layer on a filed period, returning its id. */
export async function openAmendment(db: SupabaseClient, input: { shopId: string; periodId: string; reason: string; createdBy: string }): Promise<string> {
  const { data, error } = await db.from("tax_period_amendments").insert({
    shop_id: input.shopId, period_id: input.periodId, reason: input.reason, created_by: input.createdBy,
  }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function findFiledPeriodId(db: SupabaseClient, shopId: string, date: string): Promise<{ id: string; taxTypeKey: string; periodStart: string; periodEnd: string } | null> {
  const { data, error } = await db.from("tax_periods").select("id, tax_type_key, period_start, period_end")
    .eq("shop_id", shopId).lte("period_start", date).gte("period_end", date).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as { id: string; tax_type_key: string; period_start: string; period_end: string };
  return { id: r.id, taxTypeKey: r.tax_type_key, periodStart: r.period_start, periodEnd: r.period_end };
}
