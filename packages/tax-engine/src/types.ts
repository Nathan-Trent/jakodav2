/**
 * TAX ENGINE types — mirror the tables in 0010_tax_engine.sql.
 * Money here is NAIRA as a JS number (the ledger summary is already
 * aggregated server-side in numeric(14,2)); kobo would add noise to rule
 * params like "25,000,000 threshold" for no precision gain at this scale.
 */

export type TaxTypeKey = "vat" | "pit" | "cit" | "dev_levy" | (string & {});
export type TaxPeriodKind = "monthly" | "annual";
export type TaxBasis = "turnover" | "net_profit";

export interface TaxType {
  key: TaxTypeKey;
  name: string;
  authority: string;
  period: TaxPeriodKind;
  basis: TaxBasis;
  description: string;
}

export interface BusinessCategory {
  key: string;
  name: string;
  description: string;
  /** Tax types that apply to this category (from business_category_tax_types). */
  taxTypes: TaxTypeKey[];
}

export interface ShopTaxProfile {
  shopId: string;
  categoryKey: string;
  vatRegistered: boolean;
  tin: string | null;
  /** 1 = January. */
  fiscalYearStartMonth: number;
}

/** A rule row. `params` shape depends on `kind`. */
export type TaxRule =
  | { id: string; taxTypeKey: TaxTypeKey; kind: "rate"; effectiveFrom: string; effectiveTo: string | null; verified: boolean; params: { rate: number } }
  | { id: string; taxTypeKey: TaxTypeKey; kind: "threshold"; effectiveFrom: string; effectiveTo: string | null; verified: boolean; params: { amount: number; basis: "annual_turnover"; below: "exempt" } }
  | { id: string; taxTypeKey: TaxTypeKey; kind: "bands"; effectiveFrom: string; effectiveTo: string | null; verified: boolean; params: { basis: "annual_net_profit"; bands: { upto: number | null; rate: number }[] } }
  | { id: string; taxTypeKey: TaxTypeKey; kind: "filing_due"; effectiveFrom: string; effectiveTo: string | null; verified: boolean; params: { day: number; months_after?: number; month?: number; years_after?: number } };

/** Output of shop_tax_summary() for one window. */
export interface LedgerSummary {
  from: string;
  to: string;
  turnover: number;
  salesCount: number;
  cogs: number;
  expenses: Record<string, number>;
  expensesTotal: number;
  grossProfit: number;
  netProfit: number;
}

export interface FiledPeriod {
  taxTypeKey: TaxTypeKey;
  periodStart: string;
  periodEnd: string;
  filedAt: string;
  reference: string;
}

/** What the engine says about one tax type for the shop, right now. */
export interface TaxObligation {
  taxType: TaxType;
  /** The year of assessment / month this applies to. */
  periodStart: string;
  periodEnd: string;
  /** The figure the rules were applied to, and what it is. */
  basisAmount: number;
  basisLabel: string;
  /** Threshold test, when the tax has one. */
  threshold: { amount: number; current: number; above: boolean; remaining: number } | null;
  /** True when this tax currently applies to the shop (registered or above threshold). */
  liable: boolean;
  /** Estimated amount owed for the period so far. Null when not liable. */
  estimate: number | null;
  /** Marginal rate now, if the tax has bands or a rate. */
  rate: number | null;
  effectiveRate: number | null;
  /** Next filing due date, and the period it covers. */
  nextDue: { date: string; periodStart: string; periodEnd: string } | null;
  /** False if any rule used was unverified — figures are draft estimates. */
  verified: boolean;
  /** Plain-language notes the UI shows alongside the number. */
  notes: string[];
}

/** One row of the outstanding-vs-filed view (PRD §5.7). */
export interface PeriodStatus {
  taxTypeKey: TaxTypeKey;
  periodStart: string;
  periodEnd: string;
  dueDate: string | null;
  status: "filed" | "due" | "overdue" | "upcoming";
  filed: FiledPeriod | null;
}
