import { useEffect, useState, type FormEvent } from "react";
import { IconTruckDelivery } from "@tabler/icons-react";
import type { ItemRow } from "@zogal/shared";
import { formatNaira, fromKobo, toKobo, type Kobo } from "@zogal/shared";
import { announceStockChange, setItemPrices, stockChannel } from "@zogal/inventory-batches";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberField } from "@/components/ui/number-field";
import { Label } from "@/components/ui/label";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import { getSupabase } from "@/lib/supabase";
import { useOnline } from "@/lib/useOnline";
import { cn } from "@/lib/utils";

/**
 * "Add stock" — the everyday front door for restocking ONE item.
 *
 * The Purchases screen is for a delivery of many lines; this is the
 * five-second case: "I just bought 20 more of these." It shows what the shop
 * currently pays and charges, takes a quantity, and lets the cost be kept or
 * changed. Either way it creates a NEW batch — earlier batches are history at
 * their own price and are never touched (PRD §5.1, §6.3).
 *
 * Online only, by Nathan's call: batches must be consistent across terminals,
 * and a delivery is a considered act, not a till action.
 */
export function AddStockDialog({ item, onClose, onDone }: { item: ItemRow | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { active, inventory, device } = useSession();
  const { data, stockFor, costPerUnit } = useShopData();
  const online = useOnline();
  const shop = active!.shop;
  const perms = active!.permissions;
  const canEditPrices = perms.includes("items.edit");

  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [priceStep, setPriceStep] = useState<{ newCost: Kobo } | null>(null);
  const [suggested, setSuggested] = useState("");
  const [floor, setFloor] = useState("");

  // Last batch cost is the sensible default; fall back to the weighted average.
  const lastBatch = item ? data.batches.find((b) => b.item_id === item.id) : undefined;
  const lastCost: Kobo | undefined = lastBatch ? toKobo(lastBatch.unit_cost) : item ? costPerUnit(item.id) : undefined;

  useEffect(() => {
    if (!item) return;
    setQty("");
    setCost(lastCost !== undefined ? fromKobo(lastCost) : "");
    setPriceStep(null);
    setSuggested(fromKobo(toKobo(item.suggested_price)));
    setFloor(fromKobo(toKobo(item.floor_price)));
  }, [item, lastCost]);

  if (!item) return null;

  const q = Math.max(0, Math.floor(Number(qty) || 0));
  let newCost: Kobo | null = null;
  try { newCost = cost ? toKobo(cost) : null; } catch { newCost = null; }
  const costChanged = newCost !== null && lastCost !== undefined && newCost !== lastCost;
  const canSubmit = online && q > 0 && newCost !== null && newCost >= 0;
  const onHand = stockFor(item.id);

  async function receive(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || newCost === null) return;
    setBusy(true);
    try {
      await inventory.recordPurchase({
        shopId: shop.id,
        deviceId: device?.device_id ?? null,
        note: "Added stock",
        lines: [{ itemId: item!.id, quantity: q, unitCost: fromKobo(newCost) }],
      });
      void announceStockChange(stockChannel(getSupabase(), shop.id), device?.device_id ?? null);
      notifySuccess(`Added ${q} × ${item!.name}`, {
        description: `New batch at ${formatNaira(newCost)}. Earlier batches are unchanged.`,
      });
      if (costChanged && canEditPrices) {
        setPriceStep({ newCost }); // PRD §6.3: ask about selling price, don't assume
      } else {
        onClose();
        await onDone();
      }
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  async function applyPrices(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await setItemPrices(getSupabase(), {
        itemId: item!.id, floorPrice: fromKobo(toKobo(floor)), suggestedPrice: fromKobo(toKobo(suggested)),
        reason: `Cost changed ${lastCost !== undefined ? formatNaira(lastCost) : "—"} → ${formatNaira(priceStep!.newCost)} on restock`,
      });
      notifySuccess("Selling prices updated", { description: "Applies to all stock, old and new. Cost prices untouched." });
      onClose();
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  const margin = newCost !== null ? (toKobo(suggested || "0") - newCost) : null;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        {!priceStep ? (
          <form onSubmit={receive} className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><IconTruckDelivery size={18} /> Add stock — {item.name}</DialogTitle>
              <DialogDescription>
                {onHand} in stock now. This creates a new batch; what you paid for earlier stock stays as it was.
              </DialogDescription>
            </DialogHeader>

            {!online && (
              <Alert tone="info" title="Adding stock needs a connection">
                Batches have to stay consistent across every terminal, so this waits until you're back online. Your numbers are kept.
              </Alert>
            )}

            {/* What the shop currently pays and charges — the context for the decision */}
            <div className="grid grid-cols-3 gap-2 rounded-[10px] bg-muted p-3 text-center">
              <div>
                <div className="text-micro text-muted-foreground">Last cost</div>
                <div className="text-small font-semibold tabular">{lastCost !== undefined ? formatNaira(lastCost) : "—"}</div>
              </div>
              <div>
                <div className="text-micro text-muted-foreground">Floor</div>
                <div className="text-small font-semibold tabular">{formatNaira(toKobo(item.floor_price))}</div>
              </div>
              <div>
                <div className="text-micro text-muted-foreground">Suggested</div>
                <div className="text-small font-semibold tabular">{formatNaira(toKobo(item.suggested_price))}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="as-qty">Quantity received</Label>
                <NumberField id="as-qty" decimals={0} min={1} value={qty} onChange={setQty} autoFocus required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="as-cost">Cost per unit (₦)</Label>
                <NumberField id="as-cost" prefix="₦" decimals={2} value={cost} onChange={setCost}
                  className={cn(costChanged && "[&_input]:border-status-amber")} required />
              </div>
            </div>

            {costChanged && (
              <p className="text-caption text-status-amber">
                Cost changed from {formatNaira(lastCost!)}. The new stock gets this cost; you'll be asked about the selling price next.
              </p>
            )}
            {margin !== null && margin < 0 && !costChanged && (
              <p className="text-caption text-status-red">Suggested price is below this cost — you'd sell at a loss.</p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !canSubmit}>{busy ? "Saving…" : `Receive ${q > 0 ? q : ""}`.trim()}</Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={applyPrices} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Cost changed — update the selling price?</DialogTitle>
              <DialogDescription>
                Stock is saved at {formatNaira(priceStep.newCost)}. Any price you set here applies to all units, old and new, and is logged. Cost is never changed.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="as-floor">Floor (₦)</Label>
                <NumberField id="as-floor" prefix="₦" decimals={2} value={floor} onChange={setFloor} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="as-sugg">Suggested (₦)</Label>
                <NumberField id="as-sugg" prefix="₦" decimals={2} value={suggested} onChange={setSuggested} />
              </div>
            </div>
            <p className={cn("text-caption", (toKobo(suggested || "0") - priceStep.newCost) < 0 ? "text-status-red" : "text-muted-foreground")}>
              Margin at suggested: {formatNaira((toKobo(suggested || "0") - priceStep.newCost) as Kobo)}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={async () => { onClose(); await onDone(); }}>Keep prices as they are</Button>
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Apply new prices"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
