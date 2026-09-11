import type {
  BusinessCategory, FiledPeriod, LedgerSummary, PeriodStatus, ShopTaxProfile,
  TaxObligation, TaxRule, TaxType, TaxTypeKey,
} from "./types.js";
import { daysBetween, dueDateFor, periodsBetween, windowFor } from "./periods.js";

/**
 * TAX ENGINE — deterministic rules evaluation (TRD §8, PRD §5.5).
 *
 * Inputs: the shop's declaration, the rule rows in force, and ledger totals.
 * Output: what applies, what's estimated, and when it's due. No I/O, no
 * dates from the wall clock (asOf is passed in), no AI anywhere near a number.
 *
 * "verified" propagates: if ANY rule used to produce a figure is unverified,
 * the figure is labelled a draft estimate. That is how the TRD §8.1 caveat —
 * exact values need an accountant — reaches the screen without blocking the
 * build.
 */

/** Rules in force on a date, newest effective_from first. */
export function rulesInForce(rules: TaxRule[], taxTypeKey: TaxTypeKey, asOf: string): TaxRule[] {
  return rules
    .filter((r) => r.taxTypeKey === taxTypeKey && r.effectiveFrom <= asOf && (r.effectiveTo === null || r.effectiveTo >= asOf))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

function pick<K extends TaxRule["kind"]>(rules: TaxRule[], kind: K): Extract<TaxRule, { kind: K }> | null {
  return (rules.find((r) => r.kind === kind) as Extract<TaxRule, { kind: K }> | undefined) ?? null;
}

/** Progressive bands: tax on `amount`, plus the marginal rate reached. */
export function applyBands(amount: number, bands: { upto: number | null; rate: number }[]): { tax: number; marginalRate: number } {
  let tax = 0, lower = 0, marginal = 0;
  for (const b of bands) {
    if (amount <= lower) break;
    const upper = b.upto ?? Number.POSITIVE_INFINITY;
    const slice = Math.min(amount, upper) - lower;
    tax += slice * b.rate;
    marginal = b.rate;
    lower = upper;
  }
  return { tax: round2(tax), marginalRate: marginal };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface EngineInput {
  asOf: string;                       // YYYY-MM-DD, shop-local
  profile: ShopTaxProfile;
  category: BusinessCategory;
  taxTypes: TaxType[];
  rules: TaxRule[];
  /** Ledger totals for the assessment YEAR containing asOf (annual basis). */
  year: LedgerSummary;
  /** Ledger totals for the current MONTH (VAT's own period). */
  month: LedgerSummary;
}

export function computeObligations(input: EngineInput): TaxObligation[] {
  const { asOf, profile, category, taxTypes, rules } = input;
  const out: TaxObligation[] = [];

  for (const key of category.taxTypes) {
    const tt = taxTypes.find((t) => t.key === key);
    if (!tt) continue;
    const inForce = rulesInForce(rules, key, asOf);
    const win = windowFor(tt.period, asOf, profile.fiscalYearStartMonth);
    const notes: string[] = [];
    let verified = inForce.length > 0 && inForce.every((r) => r.verified);
    if (inForce.length === 0) {
      out.push({
        taxType: tt, periodStart: win.start, periodEnd: win.end,
        basisAmount: 0, basisLabel: "", threshold: null, liable: false, estimate: null,
        rate: null, effectiveRate: null, nextDue: null, verified: false,
        notes: ["No rules are configured for this tax yet."],
      });
      continue;
    }

    const threshold = pick(inForce, "threshold");
    const rate = pick(inForce, "rate");
    const bands = pick(inForce, "bands");
    const due = pick(inForce, "filing_due");

    // The threshold test is always against the YEAR's turnover, whatever the
    // filing period — that is what "small business" means in the law.
    const yearTurnover = input.year.turnover;
    let thresholdOut: TaxObligation["threshold"] = null;
    let liable = true;
    if (threshold) {
      const above = yearTurnover >= threshold.params.amount;
      thresholdOut = { amount: threshold.params.amount, current: yearTurnover, above, remaining: Math.max(0, threshold.params.amount - yearTurnover) };
      liable = above || (key === "vat" && profile.vatRegistered);
      if (!above && key === "vat" && profile.vatRegistered) notes.push("Registered for VAT voluntarily, so it applies below the threshold.");
      if (!liable) notes.push(`Below the ${tt.name} threshold this year — nothing to pay unless turnover crosses it.`);
    }

    // Basis: what the rate/bands apply to.
    const basisSummary = tt.period === "monthly" ? input.month : input.year;
    const basisAmount = tt.basis === "turnover" ? basisSummary.turnover : basisSummary.netProfit;
    const basisLabel = tt.basis === "turnover"
      ? (tt.period === "monthly" ? "Sales this month" : "Sales this year")
      : "Net profit this year (sales − cost of goods − expenses)";

    let estimate: number | null = null;
    let marginal: number | null = null;
    let effective: number | null = null;
    if (liable) {
      if (bands) {
        const r = applyBands(Math.max(0, basisAmount), bands.params.bands);
        estimate = r.tax; marginal = r.marginalRate;
        effective = basisAmount > 0 ? round2(r.tax / basisAmount) : 0;
      } else if (rate) {
        estimate = round2(Math.max(0, basisAmount) * rate.params.rate);
        marginal = rate.params.rate; effective = rate.params.rate;
        if (key === "vat") notes.push("Output VAT on sales only; VAT you paid on purchases (input VAT) can be offset when you file.");
      } else {
        notes.push("A rate for this tax is not configured yet.");
        verified = false;
      }
      if (tt.basis === "net_profit" && basisAmount <= 0) notes.push("No profit so far this year, so nothing is estimated.");
    }

    const nextDue = due ? { date: dueDateFor(win.end, due.params)!, periodStart: win.start, periodEnd: win.end } : null;
    if (!verified) notes.unshift("Estimate — the rates and thresholds have not yet been confirmed by an accountant.");

    out.push({
      taxType: tt, periodStart: win.start, periodEnd: win.end,
      basisAmount, basisLabel, threshold: thresholdOut, liable, estimate,
      rate: marginal, effectiveRate: effective, nextDue, verified, notes,
    });
  }
  return out;
}

/**
 * Outstanding vs filed (PRD §5.7): every period from when the shop declared
 * its category up to now, matched against what has been filed.
 */
export function periodStatuses(opts: {
  asOf: string;
  declaredOn: string;
  profile: ShopTaxProfile;
  category: BusinessCategory;
  taxTypes: TaxType[];
  rules: TaxRule[];
  filed: FiledPeriod[];
}): PeriodStatus[] {
  const { asOf, declaredOn, profile, category, taxTypes, rules, filed } = opts;
  const out: PeriodStatus[] = [];
  for (const key of category.taxTypes) {
    const tt = taxTypes.find((t) => t.key === key);
    if (!tt) continue;
    const windows = periodsBetween(tt.period, declaredOn, asOf, profile.fiscalYearStartMonth);
    for (const w of windows) {
      const due = pick(rulesInForce(rules, key, w.end), "filing_due");
      const dueDate = due ? dueDateFor(w.end, due.params) : null;
      const f = filed.find((p) => p.taxTypeKey === key && p.periodStart === w.start) ?? null;
      let status: PeriodStatus["status"];
      if (f) status = "filed";
      else if (w.end >= asOf) status = "upcoming";              // period still running
      else if (dueDate && daysBetween(dueDate, asOf) > 0) status = "overdue";
      else status = "due";
      out.push({ taxTypeKey: key, periodStart: w.start, periodEnd: w.end, dueDate, status, filed: f });
    }
  }
  return out.sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.taxTypeKey.localeCompare(b.taxTypeKey));
}
