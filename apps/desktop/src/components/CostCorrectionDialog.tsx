import { useEffect, useState, type FormEvent } from "react";
import type { BatchRow } from "@zogal/shared";
import { formatNaira, fromKobo, toKobo } from "@zogal/shared";
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, NumberField, Label, notifyError, notifySuccess } from "@zogal/ui";
import { useSession } from "@/lib/session";

/**
 * Admin override for a mistyped batch cost (TRD §4 purchase_cost_corrections).
 * Requires a typed reason; the original value stays in history; units
 * already sold keep the cost they were sold at. This is the ONLY way a
 * batch cost changes — the batch itself is immutable.
 */
export function CostCorrectionDialog({ batch, itemName, onClose, onDone }: { batch: BatchRow | null; itemName: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { ctx, inventory } = useSession();
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (batch) { setCost(fromKobo(toKobo(batch.unit_cost))); setReason(""); }
  }, [batch]);

  if (!batch) return null;
  const unchanged = cost === fromKobo(toKobo(batch.unit_cost));
  const reasonOk = reason.trim().length >= 5;
  const sold = batch.quantity_received - batch.quantity_remaining;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ctx?.user || !batch) return;
    setBusy(true);
    try {
      await inventory.correctBatchCost({ batchId: batch.id, newUnitCost: fromKobo(toKobo(cost)), reason: reason.trim(), correctedBy: ctx.user.id });
      notifySuccess("Batch cost corrected", { description: `${formatNaira(toKobo(batch.unit_cost))} → ${formatNaira(toKobo(cost))}. The original stays in the correction log.` });
      onClose();
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct batch cost — {itemName}</DialogTitle>
          <DialogDescription>
            Received {new Date(batch.purchased_at).toLocaleDateString()} · {batch.quantity_received} units at {formatNaira(toKobo(batch.unit_cost))}.
            Use this only for a typing mistake. A genuine price change from the supplier is a new purchase, not a correction.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {sold > 0 && (
            <Alert tone="warning" title={`${sold} unit${sold === 1 ? "" : "s"} from this batch already sold`}>
              Those sales keep the cost they were recorded at; only the {batch.quantity_remaining} remaining unit{batch.quantity_remaining === 1 ? "" : "s"} will use the corrected cost going forward.
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="cc-cost">Correct cost per unit (₦)</Label>
            <NumberField id="cc-cost" prefix="₦" decimals={2} value={cost} onChange={setCost} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-reason">Reason <span className="text-muted-foreground font-normal">(required, kept forever)</span></Label>
            <Input id="cc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. typed 6200 instead of 62000" maxLength={300} aria-invalid={reason.length > 0 && !reasonOk} />
            {reason.length > 0 && !reasonOk && <p className="text-caption text-destructive">Please write at least a few words.</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || unchanged || !reasonOk}>{busy ? "Saving…" : "Save correction"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
