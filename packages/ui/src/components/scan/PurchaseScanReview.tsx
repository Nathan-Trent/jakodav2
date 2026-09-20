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

/**
 * Review of a scanned supplier invoice / delivery note / restock list (0029).
 * Each row must point at a shop item — matched by the reader, picked here,
 * or created on the spot (name + prices; the host does the creating). Confirm
 * hands lines to the host's Add stock form; it is saved there as usual.
 */
export interface ScannedPurchaseRow {
  line: number; item_text: string; item_id: string | null;
  quantity: number | null; unit_cost: number | null; line_total: number | null;
  confidence: "high" | "medium" | "low"; note: string | null;
}
export interface PurchaseScanPage { page_date: string | null; supplier: string | null; rows: ScannedPurchaseRow[]; warnings: string[] }

interface Draft { key: number; text: string; itemId: string; qty: string; cost: string; confidence: ScannedPurchaseRow["confidence"]; note: string | null; creating: boolean; newFloor: string; newSelling: string }

export function PurchaseScanReview({ open, pages, items, onClose, onConfirm, onCreateItem }: {
  open: boolean;
  pages: PurchaseScanPage[];
  items: { id: string; name: string }[];
  onClose: () => void;
  onConfirm: (lines: { itemId: string; quantity: number; unitCost: string }[], meta: { supplier: string | null }) => void;
  /** Create an item now so this line can point at it. Host owns the write. */
  onCreateItem: (input: { name: string; floorPrice: string; suggestedPrice: string }) => Promise<{ id: string; name: string }>;
}) {
  const [rows, setRows] = useState<Draft[]>([]);
  const [supplier, setSupplier] = useState("");
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const money = (n: number | null) => (n == null ? "" : fromKobo(Math.round(n * 100) as Kobo));

  useEffect(() => {
    if (!open) return;
    let k = 0;
    setRows(pages.flatMap((p) => p.rows.map((r) => ({
      key: k++, text: r.item_text, itemId: r.item_id ?? "",
      qty: r.quantity != null ? String(Math.max(1, Math.round(r.quantity))) : "",
      cost: money(r.unit_cost ?? (r.line_total != null && r.quantity ? r.line_total / r.quantity : null)),
      confidence: r.confidence, note: r.note, creating: false, newFloor: "", newSelling: "",
    }))));
    setSupplier(pages.map((p) => p.supplier).find(Boolean) ?? "");
  }, [open, pages]);

  const warnings = useMemo(() => pages.flatMap((p) => p.warnings), [pages]);
  const problems = rows.map((r) => {
    if (!r.itemId) return "Which item?";
    if (!(Math.floor(Number(r.qty)) > 0)) return "Quantity?";
    try { toKobo(r.cost); } catch { return "Cost?"; }
    if (!r.cost) return "Cost?";
    return null;
  });
  const blocking = problems.filter(Boolean).length;
  const update = (key: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function create(r: Draft) {
    if (!r.text.trim() || !r.newSelling) return;
    setBusyKey(r.key);
    try {
      const it = await onCreateItem({ name: r.text.trim(), floorPrice: fromKobo(toKobo(r.newFloor || r.newSelling)), suggestedPrice: fromKobo(toKobo(r.newSelling)) });
      update(r.key, { itemId: it.id, creating: false });
    } finally { setBusyKey(null); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && busyKey === null && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Check what was read</DialogTitle>
          <DialogDescription>{rows.length} line{rows.length === 1 ? "" : "s"} from {pages.length} page{pages.length === 1 ? "" : "s"}. Point each line at the right item, fix numbers, then add them to the delivery. Nothing is saved until you save the delivery.</DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && <Alert tone="warning" title="The reader had doubts">{warnings.join(" · ")}</Alert>}
        <div className="grid gap-1 max-w-sm">
          <label className="text-caption text-muted-foreground">Supplier (optional)</label>
          <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="As printed on the invoice" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-small">
            <thead className="text-caption text-muted-foreground text-left"><tr><th className="py-1 pr-2">As written</th><th className="pr-2">Item</th><th className="pr-2 w-24">Qty</th><th className="pr-2 w-32">Cost each</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className={cn("border-t align-top", problems[i] && "bg-status-amber/5")}>
                  <td className="py-1.5 pr-2 min-w-[160px]">
                    <div>{r.text}</div>
                    <div className="flex gap-1 mt-1 items-center flex-wrap">
                      {r.confidence !== "high" && <Badge variant="warning">{r.confidence === "low" ? "unsure" : "check"}</Badge>}
                      {r.note && <span className="text-caption text-muted-foreground">{r.note}</span>}
                      {problems[i] && <span className="text-caption text-status-red">{problems[i]}</span>}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2 min-w-[220px]">
                    {!r.creating ? (
                      <div className="grid gap-1">
                        <select className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={r.itemId} onChange={(e) => update(r.key, { itemId: e.target.value })}>
                          <option value="">Choose an item…</option>
                          {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                        </select>
                        {!r.itemId && <button type="button" className="text-caption underline text-left" onClick={() => update(r.key, { creating: true })}>Not in the shop yet — create “{r.text}”</button>}
                      </div>
                    ) : (
                      <div className="grid gap-1 rounded-md border p-2">
                        <Input value={r.text} onChange={(e) => update(r.key, { text: e.target.value })} placeholder="Item name" />
                        <div className="grid grid-cols-2 gap-1">
                          <NumberField prefix="₦" decimals={2} value={r.newSelling} onChange={(v) => update(r.key, { newSelling: v, newFloor: r.newFloor || v })} placeholder="Selling" />
                          <NumberField prefix="₦" decimals={2} value={r.newFloor} onChange={(v) => update(r.key, { newFloor: v })} placeholder="Floor" />
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" disabled={busyKey !== null || !r.text.trim() || !r.newSelling} onClick={() => void create(r)}>{busyKey === r.key ? "Creating…" : "Create item"}</Button>
                          <Button size="sm" variant="ghost" onClick={() => update(r.key, { creating: false })}>Back</Button>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2"><NumberField decimals={0} min={1} value={r.qty} onChange={(v) => update(r.key, { qty: v })} /></td>
                  <td className="py-1.5 pr-2"><NumberField prefix="₦" decimals={2} value={r.cost} onChange={(v) => update(r.key, { cost: v })} /></td>
                  <td className="py-1.5"><Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><IconTrash size={14} /></Button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">Nothing left to add.</td></tr>}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busyKey !== null} onClick={onClose}>Cancel</Button>
          <Button disabled={busyKey !== null || blocking > 0 || rows.length === 0}
            onClick={() => onConfirm(rows.map((r) => ({ itemId: r.itemId, quantity: Math.floor(Number(r.qty)), unitCost: fromKobo(toKobo(r.cost)) })), { supplier: supplier.trim() || null })}>
            {blocking ? `Fix ${blocking} line${blocking === 1 ? "" : "s"} first` : `Add ${rows.length} line${rows.length === 1 ? "" : "s"} to the delivery`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
