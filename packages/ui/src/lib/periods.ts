/**
 * Named date ranges for the period picker. All maths on local calendar days
 * (the shop's day), returned as YYYY-MM-DD.
 */
export type PeriodPreset =
  | "today" | "yesterday" | "last7" | "last30"
  | "this_month" | "last_month" | "this_year" | "last_year" | "custom";

export interface PeriodRange { from: string; to: string; preset: PeriodPreset; label: string }

const PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom…" },
];
export const PERIOD_PRESETS = PRESETS;

function local(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function shift(d: Date, days: number): Date { const x = new Date(d); x.setDate(x.getDate() + days); return x; }

export function resolvePreset(preset: PeriodPreset, now = new Date()): PeriodRange {
  const t = local(now);
  const label = PRESETS.find((p) => p.key === preset)?.label ?? preset;
  switch (preset) {
    case "today": return { from: t, to: t, preset, label };
    case "yesterday": { const y = local(shift(now, -1)); return { from: y, to: y, preset, label }; }
    case "last7": return { from: local(shift(now, -6)), to: t, preset, label };
    case "last30": return { from: local(shift(now, -29)), to: t, preset, label };
    case "this_month": return { from: local(new Date(now.getFullYear(), now.getMonth(), 1)), to: t, preset, label };
    case "last_month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: local(first), to: local(last), preset, label };
    }
    case "this_year": return { from: `${now.getFullYear()}-01-01`, to: t, preset, label };
    case "last_year": return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31`, preset, label };
    case "custom": return { from: t, to: t, preset, label };
  }
}

/** "12 Sep" / "6–12 Sep 2026" / "Jan–Dec 2025" for headings. */
export function describeRange(r: PeriodRange): string {
  if (r.preset !== "custom") return r.label;
  const a = new Date(r.from + "T00:00:00"), b = new Date(r.to + "T00:00:00");
  const f = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, o);
  if (r.from === r.to) return f(a, { day: "numeric", month: "short", year: "numeric" });
  return `${f(a, { day: "numeric", month: "short" })} – ${f(b, { day: "numeric", month: "short", year: "numeric" })}`;
}
