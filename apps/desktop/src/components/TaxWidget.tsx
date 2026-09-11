import { useMemo } from "react";
import { IconReceiptTax } from "@tabler/icons-react";
import { formatNaira, type Kobo } from "@zogal/shared";
import { computeObligations } from "@zogal/tax-engine";
import { Badge } from "@/components/ui/badge";
import { useShopData } from "@/lib/shopData";
import { useSync } from "@/lib/sync";
import type { PageKey } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The ambient tax widget (TRD §8): always on the dashboard, no button,
 * recomputed from the cached ledger every time the working set changes.
 * One line per applicable tax: where you stand, and the next date.
 */
export function TaxWidget({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { data } = useShopData();
  const { financialsVisible } = useSync();
  const tax = data.tax;

  const obligations = useMemo(() => {
    if (!tax?.profile) return [];
    const category = tax.categories.find((c) => c.key === tax.profile!.categoryKey);
    if (!category) return [];
    const asOf = new Date().toISOString().slice(0, 10);
    const year = { ...tax.year, turnover: tax.year.turnover + data.pendingTurnover, netProfit: tax.year.netProfit + (data.pendingProfit ?? 0) };
    const month = { ...tax.month, turnover: tax.month.turnover + data.pendingTurnover, netProfit: tax.month.netProfit + (data.pendingProfit ?? 0) };
    return computeObligations({ asOf, profile: tax.profile, category, taxTypes: tax.taxTypes, rules: tax.rules, year, month });
  }, [tax, data.pendingTurnover, data.pendingProfit]);

  if (!financialsVisible || !tax) return null;

  if (!tax.profile) {
    return (
      <button onClick={() => onNavigate("tax")} className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 -mx-3 text-left hover:bg-accent transition-colors w-[calc(100%+1.5rem)]">
        <div>
          <div className="text-small font-semibold">Tax</div>
          <div className="text-caption text-muted-foreground">Set up in one step — tell it what kind of business this is</div>
        </div>
        <Badge variant="warning">Set up</Badge>
      </button>
    );
  }

  const naira = (n: number) => formatNaira(Math.round(n * 100) as Kobo);
  const anyDraft = obligations.some((o) => !o.verified);

  return (
    <div className="grid gap-1">
      {obligations.map((o) => (
        <button key={o.taxType.key} onClick={() => onNavigate("tax")} className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 -mx-3 text-left hover:bg-accent transition-colors w-[calc(100%+1.5rem)]">
          <div className="min-w-0">
            <div className="text-small font-semibold flex items-center gap-1.5"><IconReceiptTax size={14} className="text-muted-foreground" /> {o.taxType.name}</div>
            <div className="text-caption text-muted-foreground truncate">
              {o.threshold && !o.threshold.above
                ? `${naira(o.threshold.current)} of ${naira(o.threshold.amount)} threshold`
                : o.estimate !== null ? `≈ ${naira(o.estimate)} ${o.taxType.period === "monthly" ? "this month" : "this year"}` : "Not applicable yet"}
              {o.nextDue && ` · due ${new Date(o.nextDue.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
            </div>
          </div>
          <Badge variant={o.liable ? "warning" : "secondary"} className={cn(!o.verified && "border-status-amber")}>
            {o.liable ? "Applies" : "Below"}
          </Badge>
        </button>
      ))}
      {anyDraft && <div className="text-micro text-status-amber px-0">Draft rules — estimates</div>}
    </div>
  );
}
