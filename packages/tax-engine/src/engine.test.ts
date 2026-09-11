import { describe, expect, it } from "vitest";
import { applyBands, computeObligations, periodStatuses, rulesInForce } from "./engine.js";
import { dueDateFor, monthWindow, periodsBetween, yearWindow } from "./periods.js";
import type { BusinessCategory, LedgerSummary, ShopTaxProfile, TaxRule, TaxType } from "./types.js";

/** Mirrors the 0010 seed (draft, unverified). */
const taxTypes: TaxType[] = [
  { key: "vat", name: "Value Added Tax", authority: "FIRS", period: "monthly", basis: "turnover", description: "" },
  { key: "pit", name: "Personal Income Tax", authority: "State IRS", period: "annual", basis: "net_profit", description: "" },
];
const soleTrader: BusinessCategory = { key: "sole_trader_retail", name: "", description: "", taxTypes: ["vat", "pit"] };
const profile: ShopTaxProfile = { shopId: "s", categoryKey: "sole_trader_retail", vatRegistered: false, tin: null, fiscalYearStartMonth: 1 };

const rule = (taxTypeKey: string, kind: TaxRule["kind"], params: unknown, verified = false, from = "2026-01-01", to: string | null = null): TaxRule =>
  ({ id: `${taxTypeKey}-${kind}-${from}`, taxTypeKey, kind, effectiveFrom: from, effectiveTo: to, verified, params } as TaxRule);

const rules: TaxRule[] = [
  rule("vat", "rate", { rate: 0.075 }),
  rule("vat", "threshold", { amount: 25_000_000, basis: "annual_turnover", below: "exempt" }),
  rule("vat", "filing_due", { day: 21, months_after: 1 }),
  rule("pit", "bands", { basis: "annual_net_profit", bands: [
    { upto: 800_000, rate: 0 }, { upto: 3_000_000, rate: 0.15 }, { upto: 12_000_000, rate: 0.18 },
    { upto: 25_000_000, rate: 0.21 }, { upto: 50_000_000, rate: 0.23 }, { upto: null, rate: 0.25 },
  ] }),
  rule("pit", "filing_due", { month: 3, day: 31, years_after: 1 }),
];

const ledger = (turnover: number, netProfit: number, from = "2026-01-01", to = "2026-12-31"): LedgerSummary =>
  ({ from, to, turnover, salesCount: 0, cogs: 0, expenses: {}, expensesTotal: 0, grossProfit: netProfit, netProfit });

describe("periods", () => {
  it("month and calendar-year windows", () => {
    expect(monthWindow("2026-09-11")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(monthWindow("2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(yearWindow("2026-09-11")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });
  it("honours a non-January fiscal year start", () => {
    expect(yearWindow("2026-03-15", 4)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(yearWindow("2026-04-01", 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });
  it("enumerates periods from declaration to now", () => {
    const ms = periodsBetween("monthly", "2026-06-15", "2026-09-11");
    expect(ms.map((m) => m.start)).toEqual(["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(periodsBetween("annual", "2025-06-15", "2026-09-11").map((y) => y.start)).toEqual(["2025-01-01", "2026-01-01"]);
  });
  it("computes due dates from the rule shape", () => {
    expect(dueDateFor("2026-09-30", { day: 21, months_after: 1 })).toBe("2026-10-21");
    expect(dueDateFor("2026-12-31", { month: 3, day: 31, years_after: 1 })).toBe("2027-03-31");
  });
});

describe("applyBands — progressive", () => {
  const bands = (rules[3] as Extract<TaxRule, { kind: "bands" }>).params.bands;
  it("nothing on the first ₦800k", () => {
    expect(applyBands(800_000, bands)).toEqual({ tax: 0, marginalRate: 0 });
  });
  it("only the slice above each band is taxed at that band's rate", () => {
    // 2,000,000: 0 on 800k, 15% on 1.2M = 180,000
    expect(applyBands(2_000_000, bands)).toEqual({ tax: 180_000, marginalRate: 0.15 });
    // 5,000,000: 0 + 15%×2.2M (330k) + 18%×2M (360k) = 690,000
    expect(applyBands(5_000_000, bands)).toEqual({ tax: 690_000, marginalRate: 0.18 });
  });
  it("top band is open-ended", () => {
    const r = applyBands(60_000_000, bands);
    expect(r.marginalRate).toBe(0.25);
    // 0 + 330k + 1.62M + 2.73M + 5.75M + 25%×10M(2.5M) = 12,930,000
    expect(r.tax).toBe(12_930_000);
  });
});

describe("computeObligations", () => {
  it("a small sole trader below the VAT threshold owes no VAT, but PIT applies to profit", () => {
    const out = computeObligations({
      asOf: "2026-09-11", profile, category: soleTrader, taxTypes, rules,
      year: ledger(4_000_000, 2_000_000), month: ledger(500_000, 200_000, "2026-09-01", "2026-09-30"),
    });
    const vat = out.find((o) => o.taxType.key === "vat")!;
    expect(vat.liable).toBe(false);
    expect(vat.estimate).toBeNull();
    expect(vat.threshold).toEqual({ amount: 25_000_000, current: 4_000_000, above: false, remaining: 21_000_000 });
    expect(vat.nextDue?.date).toBe("2026-10-21");

    const pit = out.find((o) => o.taxType.key === "pit")!;
    expect(pit.liable).toBe(true);
    expect(pit.basisAmount).toBe(2_000_000);
    expect(pit.estimate).toBe(180_000);
    expect(pit.rate).toBe(0.15);
    expect(pit.nextDue?.date).toBe("2027-03-31");
  });

  it("crossing the threshold makes VAT apply, at 7.5% of the month's sales", () => {
    const out = computeObligations({
      asOf: "2026-09-11", profile, category: soleTrader, taxTypes, rules,
      year: ledger(30_000_000, 5_000_000), month: ledger(2_000_000, 300_000, "2026-09-01", "2026-09-30"),
    });
    const vat = out.find((o) => o.taxType.key === "vat")!;
    expect(vat.liable).toBe(true);
    expect(vat.threshold?.above).toBe(true);
    expect(vat.estimate).toBe(150_000);
  });

  it("voluntary VAT registration applies it below the threshold", () => {
    const out = computeObligations({
      asOf: "2026-09-11", profile: { ...profile, vatRegistered: true }, category: soleTrader, taxTypes, rules,
      year: ledger(1_000_000, 100_000), month: ledger(100_000, 10_000, "2026-09-01", "2026-09-30"),
    });
    expect(out.find((o) => o.taxType.key === "vat")!.liable).toBe(true);
  });

  it("labels everything a draft while any rule is unverified, and clears once all are", () => {
    const draft = computeObligations({ asOf: "2026-09-11", profile, category: soleTrader, taxTypes, rules, year: ledger(1, 1), month: ledger(1, 1) });
    expect(draft.every((o) => !o.verified)).toBe(true);
    expect(draft[0]!.notes[0]).toMatch(/not yet been confirmed/);

    const confirmed = rules.map((r) => ({ ...r, verified: true })) as TaxRule[];
    const ok = computeObligations({ asOf: "2026-09-11", profile, category: soleTrader, taxTypes, rules: confirmed, year: ledger(1, 1), month: ledger(1, 1) });
    expect(ok.every((o) => o.verified)).toBe(true);
  });

  it("a loss-making year estimates no income tax", () => {
    const out = computeObligations({ asOf: "2026-09-11", profile, category: soleTrader, taxTypes, rules, year: ledger(1_000_000, -50_000), month: ledger(1, 1) });
    expect(out.find((o) => o.taxType.key === "pit")!.estimate).toBe(0);
  });

  it("retrospective: applies the rules in force on the date asked about", () => {
    // Rate changes on 2027-01-01. A 2026 question sees 7.5%; a 2027 one sees 10%.
    const versioned: TaxRule[] = [
      ...rules.filter((r) => !(r.taxTypeKey === "vat" && r.kind === "rate")),
      rule("vat", "rate", { rate: 0.075 }, false, "2026-01-01", "2026-12-31"),
      rule("vat", "rate", { rate: 0.10 }, false, "2027-01-01", null),
    ];
    expect(rulesInForce(versioned, "vat", "2026-06-01").find((r) => r.kind === "rate")!.params).toEqual({ rate: 0.075 });
    expect(rulesInForce(versioned, "vat", "2027-06-01").find((r) => r.kind === "rate")!.params).toEqual({ rate: 0.10 });
  });
});

describe("periodStatuses — outstanding vs filed", () => {
  it("marks filed, due, overdue and upcoming correctly", () => {
    const st = periodStatuses({
      asOf: "2026-09-11", declaredOn: "2026-07-10", profile, category: soleTrader, taxTypes, rules,
      filed: [{ taxTypeKey: "vat", periodStart: "2026-07-01", periodEnd: "2026-07-31", filedAt: "2026-08-15", reference: "DIN-1" }],
    });
    const vat = st.filter((s) => s.taxTypeKey === "vat");
    expect(vat.map((s) => [s.periodStart, s.status])).toEqual([
      ["2026-09-01", "upcoming"],   // still running
      ["2026-08-01", "due"],        // ended, due 21 Sep, not yet late
      ["2026-07-01", "filed"],
    ]);
    const pit = st.filter((s) => s.taxTypeKey === "pit");
    expect(pit.map((s) => [s.periodStart, s.status])).toEqual([["2026-01-01", "upcoming"]]);
  });
  it("flags overdue once the due date has passed", () => {
    const st = periodStatuses({
      asOf: "2026-10-25", declaredOn: "2026-08-01", profile, category: soleTrader, taxTypes, rules, filed: [],
    });
    expect(st.find((s) => s.taxTypeKey === "vat" && s.periodStart === "2026-08-01")!.status).toBe("overdue");
  });
});
