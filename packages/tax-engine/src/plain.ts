import type { TaxObligation } from "./types.js";

/**
 * Plain answers (Nathan, 2026-09-18): the tax page must tell the owner, per
 * tax, exactly three things in one line each — do I owe anything right now,
 * when is the next payment, and roughly how much — not what the law says.
 * Pure text logic over the engine's output, so it is testable and the same
 * on the till and the dashboard.
 */
export interface PlainAnswer {
  /** Headline state, drives colour. */
  state: "nothing" | "coming" | "owes" | "unknown";
  /** "Do you owe anything right now?" */
  owe: string;
  /** "When is the next payment?" */
  when: string;
  /** "Roughly how much?" */
  howMuch: string;
  /** One sentence the owner can act on. */
  next: string;
  /** Folded-away detail: how it was worked out. */
  because: string[];
}

const naira = (n: number) => "₦" + Math.round(n).toLocaleString("en-NG");

function longDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });
}

function periodWord(o: TaxObligation): string {
  if (o.taxType.period === "monthly") return new Date(o.periodStart + "T00:00:00").toLocaleDateString("en-NG", { month: "long" });
  return `the year ${o.periodStart.slice(0, 4)}`;
}

function daysUntil(iso: string, asOf: string): number {
  return Math.round((Date.parse(iso) - Date.parse(asOf)) / 86_400_000);
}

export function explainObligation(o: TaxObligation, asOf: string): PlainAnswer {
  const name = o.taxType.name;
  const because: string[] = [];
  const due = o.nextDue?.date ?? null;
  const dueLine = due ? `${longDate(due)} (${daysUntil(due, asOf)} days away)` : "Due date not set up yet";

  // No rules at all.
  if (o.notes.some((n) => n.startsWith("No rules"))) {
    return { state: "unknown", owe: "We can't say yet.", when: "—", howMuch: "—", next: `${name} hasn't been set up on Doka yet. Nothing for you to do.`, because: o.notes };
  }

  // Below threshold: nothing owed, show how far from it.
  if (!o.liable && o.threshold) {
    const t = o.threshold;
    because.push(`${name} only applies once your sales in a year reach ${naira(t.amount)}.`);
    because.push(`Your sales this year so far: ${naira(t.current)}.`);
    const pct = t.amount > 0 ? Math.round((t.current / t.amount) * 100) : 0;
    return {
      state: "nothing",
      owe: `No. You don't owe ${name} right now.`,
      when: `Not until your sales reach ${naira(t.amount)} in a year.`,
      howMuch: `Nothing. You're at ${pct}% of the level where it starts (${naira(t.remaining)} to go).`,
      next: "Nothing to do. Keep selling; Doka will tell you when you get close.",
      because,
    };
  }

  // Liable, but no rate / no profit / no estimate.
  if (o.estimate === null) {
    because.push(...o.notes);
    const noProfit = o.basisAmount <= 0 && o.basisLabel.toLowerCase().includes("profit");
    return {
      state: noProfit ? "nothing" : "unknown",
      owe: noProfit ? `Nothing so far — there's no profit yet for ${periodWord(o)}.` : `${name} applies to you, but the amount can't be worked out yet.`,
      when: dueLine,
      howMuch: noProfit ? "₦0 on current figures." : "—",
      next: noProfit ? "Keep your expenses recorded so the profit figure stays true." : "Nothing for you to do; the rate needs to be set up on Doka.",
      because,
    };
  }

  // Liable with an estimate.
  const basis = o.basisLabel || "your sales";
  because.push(`${basis}: ${naira(o.basisAmount)}.`);
  if (o.rate !== null) because.push(`${name} rate: ${Math.round(o.rate * 100)}%${o.effectiveRate !== null && o.effectiveRate !== o.rate ? ` (works out to ${(o.effectiveRate * 100).toFixed(1)}% overall after the tax-free band)` : ""}.`);
  because.push(`${naira(o.basisAmount)} × rate = about ${naira(o.estimate)}.`);
  for (const n of o.notes) if (!n.startsWith("Estimate —")) because.push(n);

  const soon = due ? daysUntil(due, asOf) <= 14 : false;
  return {
    state: soon ? "owes" : "coming",
    owe: `Yes — about ${naira(o.estimate)} ${name} for ${periodWord(o)}.`,
    when: dueLine,
    howMuch: `About ${naira(o.estimate)} on what you've sold so far${o.taxType.period === "monthly" ? "; more if sales continue this month" : " this year"}.`,
    next: due
      ? `Pay and file on the ${o.taxType.authority} portal by ${longDate(due)}, then mark it filed here.`
      : `Pay and file on the ${o.taxType.authority} portal, then mark it filed here.`,
    because,
  };
}

/** One line for the whole shop: the thing the owner most needs to know today. */
export function summariseAnswers(answers: { name: string; a: PlainAnswer }[]): string {
  const owing = answers.filter((x) => x.a.state === "owes");
  const coming = answers.filter((x) => x.a.state === "coming");
  if (owing.length) return `${owing.map((x) => x.name).join(" and ")} due within two weeks.`;
  if (coming.length) return `Nothing due in the next two weeks. ${coming.map((x) => x.name).join(" and ")} coming up.`;
  if (answers.every((x) => x.a.state === "nothing")) return "You don't owe any tax right now.";
  return "Some taxes can't be worked out yet.";
}
