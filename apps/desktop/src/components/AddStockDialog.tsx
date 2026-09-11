import { useEffect, useState, type FormEvent } from "react";
import { IconArrowLeft, IconTruckDelivery } from "@tabler/icons-react";
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
 * Two steps, one save (Nathan's call):
 *   1. Quantity + cost per unit            → Next
 *   2. Floor + suggested price, always shown, margin against the NEW cost → Save
 *
 * Nothing is written until Save, so the owner can think about the selling
 * price without the stock already being in. Save records the batch (a new
 * batch — earlier batches keep their own cost, PRD §5.1, §6.3) and then, only
 * if floor/suggested actually differ from the item's current prices, updates
 * them with a logged reason.
 *
 * Online only: batches must be consistent across terminals.
 */
export function AddStockDialog({ item, onClose, onDone }: { item: ItemRow | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { active, inventory, device } = useSession();
  const { data, stockFor, costPerUnit } = useShopData();
  const online = useOnline();
  const shop = active!.shop;
  const perms = active!.permissions;
  const canEditPrices = perms.includes("items.edit");

  const [step, setStep] = useState<1 | 2>(1);
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [floor, setFloor] = useState("");
  const [suggested, setSuggested] = useState("");
  const [busy, setBusy] = useState(false);

  // Last batch cost is the sensible default; fall back to the weighted average.
  const lastBatch = item ? data.batches.find((b) => b.item_id === item.id) : undefined;
  const lastCost: Kobo | undefined = lastBatch ? toKobo(lastBatch.unit_cost) : item ? costPerUnit(item.id) : undefined;

  // Reset ONLY when a different item is opened. Keying this on lastCost (as
  // before) wiped the form whenever the stock list refreshed underneath it —
  // that was the "it clears before I can think" bug.
  const itemId = item?.id ?? null;
  useEffect(() => {
    if (!item) return;
    setStep(1);
    setQty("");
    setCost(lastCost !== undefined ? fromKobo(lastCost) : "");
    setFloor(fromKobo(toKobo(item.floor_price)));
    setSuggested(fromKobo(toKobo(item.suggested_price)));
  }, [itemId]);

  if (!item) return null;

  const q = Math.max(0, Math.floor(Number(qty) || 0));
  let newCost: Kobo | null = null;
  try { newCost = cost ? toKobo(cost) : null; } catch { newCost = null; }
  const costChanged = newCost !== null && lastCost !== undefined && newCost !== lastCost;
  const step1Ok = q > 0 && newCost !== null && newCost >= 0;
  const onHand = stockFor(item.id);

  const parse = (s: string): Kobo | null => { try { return s ? toKobo(s) : null; } catch { return null; } };
  const floorK = parse(floor);
  const suggK = parse(suggested);
  const pricesOk = !canEditPrices || (floorK !== null && suggK !== null && floorK >= 0 && suggK >= floorK);
  const pricesChanged = canEditPrices && (floorK !== toKobo(item.floor_price) || suggK !== toKobo(item.suggested_price));
  const marginSugg = newCost !== null && suggK !== null ? (suggK - newCost) as Kobo : null;
  const marginFloor = newCost !== null && floorK !== null ? (floorK - newCost) as Kobo : null;

  function next(e: FormEvent) {
    e.preventDefault();
    if (step1Ok) setStep(2);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!online || !step1Ok || !pricesOk || newCost === null) return;
    setBusy(true);
    try {
      await inventory.recordPurchase({
        shopId: shop.id,
        deviceId: device?.device_id ?? null,
        note: "Added stock",
        lines: [{ itemId: item!.id, quantity: q, unitCost: fromKobo(newCost) }],
      });
      let priceNote = "";
      if (pricesChanged && floorK !== null && suggK !== null) {
        await setItemPrices(getSupabase(), {
          itemId: item!.id, floorPrice: fromKobo(floorK), suggestedPrice: fromKobo(suggK),
          reason: `Restock: cost ${lastCost !== undefined ? formatNaira(lastCost) : "—"} → ${formatNaira(newCost)}`,
        });
        priceNote = ` Selling price now ${formatNaira(suggK)} (floor ${formatNaira(floorK)}).`;
      }
      // Sync: tell the other terminals their stock view is stale.
      void announceStockChange(stockChannel(getSupabase(), shop.id), device?.device_id ?? null);
      notifySuccess(`Added ${q} × ${item!.name}`, {
        description: `New batch at ${formatNaira(newCost)}; earlier batches unchanged.${priceNote}`,
      });
      onClose();
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={step === 1 ? next : save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><IconTruckDelivery size={18} /> Add stock — {item.name}</DialogTitle>
            <DialogDescription>
              {step === 1
                ? `${onHand} in stock now. Step 1 of 2 — what came in and what it cost.`
                : "Step 2 of 2 — what you'll sell it for. Nothing is saved until you press Save."}
            </DialogDescription>
          </DialogHeader>

          {!online && (
            <Alert tone="info" title="Adding stock needs a connection">
              Batches have to stay consistent across every terminal, so saving waits until you're back online. Your numbers are kept.
            </Alert>
          )}

          {/* What the shop currently pays and charges — the context for the decision */}
          <div className="grid grid-cols-3 gap-2 rounded-[10px] bg-muted p-3 text-center">
            <div>
              <div className="text-micro text-muted-foreground">{step === 1 ? "Last cost" : "New cost"}</div>
              <div className="text-small font-semibold tabular">
                {step === 1 ? (lastCost !== undefined ? formatNaira(lastCost) : "—") : formatNaira(newCost!)}
              </div>
            </div>
            <div>
              <div className="text-micro text-muted-foreground">Current floor</div>
              <div className="text-small font-semibold tabular">{formatNaira(toKobo(item.floor_price))}</div>
            </div>
            <div>
              <div className="text-micro text-muted-foreground">Current suggested</div>
              <div className="text-small font-semibold tabular">{formatNaira(toKobo(item.suggested_price))}</div>
            </div>
          </div>

          {step === 1 ? (
            <>
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
                  Cost changed from {formatNaira(lastCost!)}. Only this new stock gets the new cost.
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button type="submit" disabled={!step1Ok}>Next</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              {canEditPrices ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="as-floor">Floor price (₦)</Label>
                      <NumberField id="as-floor" prefix="₦" decimals={2} value={floor} onChange={setFloor} autoFocus required />
                      <p className={cn("text-caption", marginFloor !== null && marginFloor < 0 ? "text-status-red" : "text-muted-foreground")}>
                        {marginFloor !== null ? `${formatNaira(marginFloor)} above new cost` : "Lowest a cashier may sell at"}
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="as-sugg">Suggested price (₦)</Label>
                      <NumberField id="as-sugg" prefix="₦" decimals={2} value={suggested} onChange={setSuggested} required />
                      <p className={cn("text-caption", marginSugg !== null && marginSugg < 0 ? "text-status-red" : "text-muted-foreground")}>
                        {marginSugg !== null ? `${formatNaira(marginSugg)} margin per unit` : "What the till starts at"}
                      </p>
                    </div>
                  </div>
                  {floorK !== null && suggK !== null && suggK < floorK && (
                    <p className="text-caption text-status-red">Suggested price can't be below the floor.</p>
                  )}
                  {marginSugg !== null && marginSugg < 0 && (
                    <p className="text-caption text-status-red">Suggested price is below the new cost — you'd sell at a loss.</p>
                  )}
                  <p className="text-caption text-muted-foreground">
                    {pricesChanged
                      ? "New prices apply to all units, old and new, and are logged. Cost is never changed."
                      : "Prices unchanged — leave them and press Save, or adjust for the new cost."}
                  </p>
                </>
              ) : (
                <p className={cn("text-caption", marginSugg !== null && marginSugg < 0 ? "text-status-red" : "text-muted-foreground")}>
                  Margin at the current suggested price: {marginSugg !== null ? formatNaira(marginSugg) : "—"}. Only the owner can change selling prices.
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={busy}><IconArrowLeft size={16} /> Back</Button>
                <Button type="submit" disabled={busy || !online || !pricesOk} title={!online ? "Needs a connection" : undefined}>
                  {busy ? "Saving…" : `Save ${q} × ${item.name}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
