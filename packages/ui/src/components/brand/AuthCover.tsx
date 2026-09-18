import { ZogalMark } from "./ZogalMark.js";
import { cn } from "../../lib/utils.js";

/**
 * The ink cover beside a sign-in form — Doka's name plate with the day-book
 * from the product page: a ruled ledger of one shop's day, rows arriving one
 * by one. Same block on the desktop till and the web dashboard, so both
 * doors match. No leaves.
 */
const ROWS: [string, string, string][] = [
  ["08:12", "Opening stock counted", "412 units"],
  ["09:40", "Delivery · Peak Milk × 48", "₦86,400"],
  ["12:05", "Sales so far · 31 receipts", "₦118,300"],
  ["15:30", "Expense · generator diesel", "₦9,000"],
  ["18:55", "Closing · takings", "₦184,500"],
  ["", "Profit after cost & expenses", "₦41,200"],
];

export function AuthCover({ sub = "by Zogal", stamp = "Product 01", title = "The till that knows your profit.", line, className, dayBook = true }: {
  sub?: string; stamp?: string; title?: string; line?: string; className?: string; dayBook?: boolean;
}) {
  return (
    <aside className={cn("relative bg-brand-forest text-white p-8 md:p-10 flex flex-col gap-10 overflow-hidden", className)}>
      <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full" style={{ background: "radial-gradient(circle, rgba(255,180,163,0.18) 0%, transparent 65%)" }} />
      <div className="relative flex items-center gap-2.5">
        <ZogalMark size={30} />
        <span className="text-title">Doka <span className="text-white/55 font-semibold">{sub}</span></span>
      </div>
      <div className="relative grid gap-4 max-w-md">
        <span className="stamp text-brand-signal w-fit">{stamp}</span>
        <h2 className="text-display leading-[1.02]" style={{ fontSize: 38 }}>{title}</h2>
        <div className="border-t-2 border-white/30 pt-4 text-subheading text-white/70 font-medium">
          {line ?? "Sales, stock and true profit — recorded as they happen, even with no network."}
        </div>
      </div>
      {dayBook && (
        <div className="relative mt-auto max-w-md rounded-[16px] border border-white/15 bg-white/[0.04] p-5" aria-hidden>
          <div className="flex items-center justify-between">
            <span className="text-micro text-white/50">Day book</span>
            <span className="stamp text-brand-signal" style={{ fontSize: 10 }}>Balanced</span>
          </div>
          <div className="mt-3">
            {ROWS.map(([t, d, v], i) => (
              <div key={i} className={cn("ledger-row grid grid-cols-[52px_1fr_auto] gap-3 items-baseline py-2 text-small", i === ROWS.length - 1 ? "border-t-2 border-white/40" : "border-t border-white/10")} style={{ animationDelay: `${0.2 + i * 0.15}s` }}>
                <span className="tabular text-caption text-white/45">{t}</span>
                <span className={i === ROWS.length - 1 ? "font-extrabold" : "text-white/85"}>{d}</span>
                <span className={cn("tabular font-extrabold", i === ROWS.length - 1 && "text-brand-signal")}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
