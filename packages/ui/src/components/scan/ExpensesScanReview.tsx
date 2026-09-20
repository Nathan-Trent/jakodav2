import { useEffect, useMemo, useState } from "react";
import { IconTrash } from "@tabler/icons-react";
import { fromKobo, toKobo, type Kobo } from "@zogal/shared";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { NumberField } from "../ui/number-field.js";
import { Badge } from "../ui/badge.js";
import { Alert } from "../Alert.js";
import { cn } from "../../lib/utils.js";

/** Review of scanned receipts / an expenses page (0029). Confirm records each row through the host's normal expense path. */
export interface ScannedExpenseRow {
  line: number; description: string; category: string; amount: number | null; date: string | null;
  confidence: "high" | "medium" | "low"; note: string | null;
}
export interface ExpensesScanPage { page_date: string | null; rows: ScannedExpenseRow[]; warnings: string[] }
export interface ExpenseReviewResult { description: string; categoryKey: string; amount: string; incurredOn: string }

interface Draft { key: number; description: string; category: string; amount: string; date: string; confidence: ScannedExpenseRow["confidence"]; note: string | null }

export function ExpensesScanReview({ open, pages, categories, onClose, onConfirm }: {
  open: boolean;
  pages: ExpensesScanPage[];
  categories: { key: string; name: string }[];
  onClose: () => void;
  onConfirm: (rows: ExpenseReviewResult[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const ok = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

  useEffect(() => {
    if (!open) return;
    let k = 0;
    setRows(pages.flatMap((p) => p.rows.map((r) => ({
      key: k++, description: r.description, category: categories.some((c) => c.key === r.category) ? r.category : "other",
      amount: r.amount == null ? "" : fromKobo(Math.round(r.amount * 100) as Kobo),
      date: ok(r.date) ?? ok(p.page_date) ?? today,
      confidence: r.confidence, note: r.note,
    }))));
  }, [open, pages, categories, today]);

  const warnings = useMemo(() => pages.flatMap((p) => p.warnings), [pages]);
  const problems = rows.map((r) => {
    if (!r.description.trim()) return "What was it for?";
    try { if (!r.amount || toKobo(r.amount) <= 0) return "Amount?"; } catch { return "Amount?"; }
    if (!ok(r.date)) return "Date?";
    return null;
  });
  const blocking = problems.filter(Boolean).length;
  const update = (key: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Check what was read</DialogTitle>
          <DialogDescription>{rows.length} expense{rows.length === 1 ? "" : "s"} from {pages.length} page{pages.length === 1 ? "" : "s"}. Fix anything wrong, then record. Each becomes an ordinary expense.</DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && <Alert tone="warning" title="The reader had doubts">{warnings.join(" · ")}</Alert>}
        <div className="overflow-x-auto">
          <table className="w-full text-small">
            <thead className="text-caption text-muted-foreground text-left"><tr><th className="py-1 pr-2">For</th><th className="pr-2 w-36">Category</th><th className="pr-2 w-36">Amount</th><th className="pr-2 w-40">Date</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className={cn("border-t align-top", problems[i] && "bg-status-amber/5")}>
                  <td className="py-1.5 pr-2 min-w-[200px]">
                    <Input value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
                    <div className="flex gap-1 mt-1 items-center">
                      {r.confidence !== "high" && <Badge variant="warning">{r.confidence === "low" ? "unsure" : "check"}</Badge>}
                      {r.note && <span className="text-caption text-muted-foreground">{r.note}</span>}
                      {problems[i] && <span className="text-caption text-status-red">{problems[i]}</span>}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <select className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={r.category} onChange={(e) => update(r.key, { category: e.target.value })}>
                      {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2"><NumberField prefix="₦" decimals={2} value={r.amount} onChange={(v) => update(r.key, { amount: v })} /></td>
                  <td className="py-1.5 pr-2"><Input type="date" value={r.date} max={today} onChange={(e) => update(r.key, { date: e.target.value })} /></td>
                  <td className="py-1.5"><Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><IconTrash size={14} /></Button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">Nothing left to record.</td></tr>}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || blocking > 0 || rows.length === 0} onClick={async () => {
            setBusy(true);
            try { await onConfirm(rows.map((r) => ({ description: r.description.trim(), categoryKey: r.category, amount: fromKobo(toKobo(r.amount)), incurredOn: r.date }))); }
            finally { setBusy(false); }
          }}>
            {busy ? "Recording…" : blocking ? `Fix ${blocking} row${blocking === 1 ? "" : "s"} first` : `Record ${rows.length} expense${rows.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
