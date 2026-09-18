import { describe, expect, it } from "vitest";
import { explainObligation, summariseAnswers } from "./plain.js";
import type { TaxObligation, TaxType } from "./types.js";

const vat: TaxType = { key: "vat", name: "VAT", authority: "FIRS", period: "monthly", basis: "turnover" } as unknown as TaxType;
const pit: TaxType = { key: "pit", name: "Personal income tax", authority: "State IRS", period: "yearly", basis: "net_profit" } as unknown as TaxType;

const base = (over: Partial<TaxObligation>): TaxObligation => ({
  taxType: vat, periodStart: "2026-09-01", periodEnd: "2026-09-30", basisAmount: 0, basisLabel: "Sales this month",
  threshold: null, liable: false, estimate: null, rate: null, effectiveRate: null, nextDue: null, verified: false, notes: [], ...over,
});

describe("explainObligation", () => {
  it("says plainly that nothing is owed below the threshold, with distance to it", () => {
    const a = explainObligation(base({ threshold: { amount: 25_000_000, current: 4_200_000, above: false, remaining: 20_800_000 } }), "2026-09-18");
    expect(a.state).toBe("nothing");
    expect(a.owe).toBe("No. You don't owe VAT right now.");
    expect(a.howMuch).toContain("17%");
    expect(a.howMuch).toContain("₦20,800,000 to go");
  });

  it("gives amount, date and the action when liable", () => {
    const a = explainObligation(base({
      liable: true, basisAmount: 510_000, estimate: 38_250, rate: 0.075, effectiveRate: 0.075,
      threshold: { amount: 25_000_000, current: 30_000_000, above: true, remaining: 0 },
      nextDue: { date: "2026-10-21", periodStart: "2026-09-01", periodEnd: "2026-09-30" },
    }), "2026-09-18");
    expect(a.state).toBe("coming");
    expect(a.owe).toBe("Yes — about ₦38,250 VAT for September.");
    expect(a.when).toContain("21 October 2026");
    expect(a.next).toContain("FIRS");
    expect(a.because[2]).toContain("₦38,250");
  });

  it("flags 'owes' when the due date is within two weeks", () => {
    const a = explainObligation(base({ liable: true, basisAmount: 100, estimate: 7.5, rate: 0.075, effectiveRate: 0.075, nextDue: { date: "2026-09-21", periodStart: "2026-08-01", periodEnd: "2026-08-31" } }), "2026-09-18");
    expect(a.state).toBe("owes");
  });

  it("explains no profit as nothing owed, not unknown", () => {
    const a = explainObligation(base({ taxType: pit, periodStart: "2026-01-01", periodEnd: "2026-12-31", liable: true, basisAmount: -12_000, basisLabel: "Net profit this year (sales − cost of goods − expenses)", notes: ["No profit so far this year, so nothing is estimated."] }), "2026-09-18");
    expect(a.state).toBe("nothing");
    expect(a.howMuch).toBe("₦0 on current figures.");
  });

  it("summarises the shop in one line", () => {
    expect(summariseAnswers([{ name: "VAT", a: { state: "nothing" } as never }, { name: "PIT", a: { state: "nothing" } as never }])).toBe("You don't owe any tax right now.");
    expect(summariseAnswers([{ name: "VAT", a: { state: "owes" } as never }])).toBe("VAT due within two weeks.");
  });
});
