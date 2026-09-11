/**
 * Assessment periods: which window of the ledger a tax applies to.
 *
 * PIT is assessed on the calendar year (a sole trader's "year of assessment"
 * in Nigeria is 1 Jan – 31 Dec; a shop may declare a different fiscal start
 * month, which we honour). VAT is monthly. All date maths is on plain
 * YYYY-MM-DD strings so it never depends on the terminal's timezone.
 */

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

/** Calendar month containing `asOf`. */
export function monthWindow(asOf: string): { start: string; end: string } {
  const [y, m] = asOf.split("-").map(Number) as [number, number];
  return { start: iso(utc(y, m - 1, 1)), end: iso(utc(y, m, 0)) };
}

/** Assessment year containing `asOf`, starting on `startMonth` (1 = Jan). */
export function yearWindow(asOf: string, startMonth = 1): { start: string; end: string } {
  const [y, m] = asOf.split("-").map(Number) as [number, number];
  const startYear = m >= startMonth ? y : y - 1;
  return { start: iso(utc(startYear, startMonth - 1, 1)), end: iso(utc(startYear + 1, startMonth - 1, 0)) };
}

export function windowFor(period: "monthly" | "annual", asOf: string, startMonth = 1): { start: string; end: string } {
  return period === "monthly" ? monthWindow(asOf) : yearWindow(asOf, startMonth);
}

/** All periods from `from` up to and including the one containing `until`. */
export function periodsBetween(period: "monthly" | "annual", from: string, until: string, startMonth = 1): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let cursor = windowFor(period, from, startMonth);
  const last = windowFor(period, until, startMonth);
  let guard = 0;
  while (cursor.start <= last.start && guard++ < 600) {
    out.push(cursor);
    const [y, m] = cursor.end.split("-").map(Number) as [number, number];
    const next = iso(utc(y, m, 1)); // day after cursor.end
    cursor = windowFor(period, next, startMonth);
  }
  return out;
}

/**
 * Due date for a period, from a filing_due rule:
 *   monthly → { day, months_after }       e.g. 21st of the following month
 *   annual  → { month, day, years_after } e.g. 31 March of the following year
 */
export function dueDateFor(
  periodEnd: string,
  rule: { day: number; months_after?: number; month?: number; years_after?: number } | null,
): string | null {
  if (!rule) return null;
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  if (rule.month !== undefined) {
    return iso(utc(y + (rule.years_after ?? 1), rule.month - 1, rule.day));
  }
  return iso(utc(y, m - 1 + (rule.months_after ?? 1), rule.day));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
