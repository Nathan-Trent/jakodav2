import { useEffect, useMemo, useState } from "react";
import { IconTrash } from "@tabler/icons-react";
import { formatNaira, fromKobo, toKobo, type Kobo } from "@zogal/shared";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { NumberField } from "../ui/number-field.js";
import { Badge } from "../ui/badge.js";
import { Alert } from "../Alert.js";
import { cn } from "../../lib/utils.js";

/**
 * Review of scanned stock-ledger pages before anything is created (0029).
 * One row per product read. The person fixes names and numbers, points a
 * row at an item that already exists (so it isn't created twice), or drops
 * it. Confirm creates items + opening stock through the host's normal path.
 */
export interface ScannedItemRow {
  line: number; name: string; existing_item_id: string | null;
  quantity: number | null; unit_cost: number | null; selling_price: number | null;
  confidence: "high" | "medium" | "low"; note: string | null;
}
export interface ItemsScanPage { page_date: string | null; rows: ScannedItemRow[]; warnings: string[] }

export interface ItemsReviewResult {
  name: string; existingItemId: string | null;
  quantity: number; unitCost: string; floorPrice: string; suggestedPrice: string;
}

interface Draft { key: number; name: string; existing: string; qty: string; cost: string; floor: string; selling: string; confidence: ScannedItemRow["confidence"]; note: string | null }

export function ItemsScanReview({ open, pages, existingItems, onClose, onConfirm }: {
  open: boolean;
  pages: ItemsScanPage[];
  existingItems: { id: string; name: string; floor_price: string; suggested_price: string }[];
  onClose: () => void;
  onConfirm: (rows: ItemsReviewResult[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const money = (n: number | null) => (n == null ? "" : fromKobo(Math.round(n * 100) as Kobo));

  useEffect(() => {
    if (!open) return;
    let k = 0;
    setRows(pages.flatMap((p) => p.rows.map((r) => ({
      key: k++, name: r.name, existing: r.existing_item_id ?? "",
      qty: r.quantity != null ? String(Math.max(0, Math.round(r.quantity))) : "",
      cost: money(r.unit_cost), selling: money(r.selling_price),
      floor: money(r.selling_price),   // floor defaults to the selling price; the owner lowers it if they allow haggling
      confidence: r.confidence, note: r.note,
    }))));
  }, [open, pages]);

  const warnings = useMemo(() => pages.flatMap((p) => p.warnings), [pages]);
  const problems = rows.map((r) => {
    if (!r.name.trim()) return "Name?";
    if (r.qty !== "" && !(Math.floor(Number(r.qty)) >= 0)) return "Quantity?";
    if (r.existing) return null;                          // existing item: only stock is added
    if (!r.selling) return "Selling price?";
    try { if (toKobo(r.floor || r.selling) > toKobo(r.selling)) return "Floor above selling"; } catch { return "Price?"; }
    if (Number(r.qty) > 0 && !r.cost) return "Cost per unit?";
    return null;
  });
  const blocking = problems.filter(Boolean).length;
  const update = (key: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function confirm() {
    if (blocking || rows.length === 0) return;
    setBusy(true);
    try {
      await onConfirm(rows.map((r) => {
        const ex = r.existing ? existingItems.find((i) => i.id === r.existing) : undefined;
        const selling = ex ? ex.suggested_price : fromKobo(toKobo(r.selling));
        return {
          name: r.name.trim(), existingItemId: r.existing || null,
          quantity: Math.max(0, Math.floor(Number(r.qty) || 0)),
          unitCost: fromKobo(toKobo(r.cost || "0")),
          floorPrice: ex ? ex.floor_price : fromKobo(toKobo(r.floor || r.selling)),
          suggestedPrice: selling,
        };
      }));
    } finally { setBusy(false); }
  }

  const newCount = rows.filter((r) => !r.existing).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Check what was read</DialogTitle>
          <DialogDescription>
            {rows.length} row{rows.length === 1 ? "" : "s"} from {pages.length} page{pages.length === 1 ? "" : "s"}. Fix anything wrong, remove what isn't a product, then add. Nothing is saved until you do.
          </DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && <Alert tone="warning" title="The reader had doubts">{warnings.join(" · ")}</Alert>}
        <div className="overflow-x-auto">
          <table className="w-full text-small">
            <thead className="text-caption text-muted-foreground text-left">
              <tr><th className="py-1 pr-2">Item</th><th className="pr-2">Already in shop?</th><th className="pr-2 w-24">Qty on hand</th><th className="pr-2 w-32">Cost each</th><th className="pr-2 w-32">Selling</th><th className="pr-2 w-32">Floor</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className={cn("border-t align-top", problems[i] && "bg-status-amber/5")}>
                  <td className="py-1.5 pr-2 min-w-[220px]">
                    <Input value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} className={cn(r.confidence === "low" && "border-status-amber")} />
                    <div className="flex gap-1 mt-1 items-center">
                      {r.confidence !== "high" && <Badge variant="warning">{r.confidence === "low" ? "unsure" : "check"}</Badge>}
                      {r.note && <span className="text-caption text-muted-foreground">{r.note}</span>}
                      {problems[i] && <span className="text-caption text-status-red">{problems[i]}</span>}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2 min-w-[180px]">
                    <select className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={r.existing} onChange={(e) => update(r.key, { existing: e.target.value })}>
                      <option value="">No — new item</option>
                      {existingItems.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2"><NumberField decimals={0} min={0} value={r.qty} onChange={(v) => update(r.key, { qty: v })} /></td>
                  <td className="py-1.5 pr-2"><NumberField prefix="₦" decimals={2} value={r.cost} onChange={(v) => update(r.key, { cost: v })} /></td>
                  <td className="py-1.5 pr-2">{r.existing ? <span className="text-muted-foreground">{formatNaira(toKobo(existingItems.find((i) => i.id === r.existing)?.suggested_price ?? "0"))}</span> : <NumberField prefix="₦" decimals={2} value={r.selling} onChange={(v) => update(r.key, { selling: v, floor: r.floor || v })} />}</td>
                  <td className="py-1.5 pr-2">{r.existing ? <span className="text-muted-foreground">kept</span> : <NumberField prefix="₦" decimals={2} value={r.floor} onChange={(v) => update(r.key, { floor: v })} />}</td>
                  <td className="py-1.5"><Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><IconTrash size={14} /></Button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">Nothing left to add.</td></tr>}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || blocking > 0 || rows.length === 0} onClick={() => void confirm()}>
            {busy ? "Adding…" : blocking ? `Fix ${blocking} row${blocking === 1 ? "" : "s"} first` : `Add ${newCount} new item${newCount === 1 ? "" : "s"}${rows.length - newCount ? ` + stock for ${rows.length - newCount}` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
