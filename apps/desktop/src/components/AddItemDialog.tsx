import { useEffect, useState, type FormEvent } from "react";
import { IconScan } from "@tabler/icons-react";
import { fromKobo, toKobo, type ItemRow } from "@zogal/shared";
import { addManufacturerBarcode } from "@zogal/inventory-batches";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, NumberField, Label, notifyError, notifyInfo } from "@zogal/ui";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

/**
 * Add item + initial stock. Cost is only asked for if the user may record
 * purchases. The pack's own barcode can be scanned in right here (0028) —
 * or arrives pre-filled when Add stock met a code it didn't know.
 */
export function AddItemDialog({ open, onOpenChange, onDone, initialBarcode, noInitialStock = false }: {
  open: boolean; onOpenChange: (o: boolean) => void; onDone: (name: string, item: ItemRow) => Promise<void>; initialBarcode?: string | null;
  /** Add stock opens this for an unknown scan: quantity and cost go on the receiving line, not here. */
  noInitialStock?: boolean;
}) {
  const { active, inventory, device } = useSession();
  const [barcode, setBarcode] = useState("");
  useEffect(() => { if (open) setBarcode(initialBarcode ?? ""); }, [open, initialBarcode]);
  // While the dialog is open, a scanner read fills the barcode box (never the name).
  useBarcodeScanner((code) => { setBarcode(code.trim()); notifyInfo("Barcode read", code.trim()); }, { enabled: open, minLength: 4 });
  const shop = active!.shop;
  const canPurchase = active!.permissions.includes("purchases.create") && !noInitialStock;
  const [name, setName] = useState("");
  const [floor, setFloor] = useState("");
  const [suggested, setSuggested] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const item = await inventory.createItem({
        shopId: shop.id,
        name,
        floorPrice: fromKobo(toKobo(floor)),
        suggestedPrice: fromKobo(toKobo(suggested)),
      });
      if (barcode.trim()) {
        try { await addManufacturerBarcode(getSupabase(), shop.id, item.id, barcode.trim()); }
        catch (e) { notifyError(e, "Item saved, but the barcode wasn't attached"); }
      }
      if (canPurchase && Number(qty) > 0) {
        // Initial stock = first immutable batch (PRD §5.1)
        await inventory.recordPurchase({
          shopId: shop.id,
          deviceId: device?.device_id ?? null,
          note: "Initial stock",
          lines: [{ itemId: item.id, quantity: Number(qty), unitCost: fromKobo(toKobo(cost || "0")) }],
        });
      }
      setName(""); setFloor(""); setSuggested(""); setQty(""); setCost(""); setBarcode("");
      await onDone(item.name, item);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New item</DialogTitle>
          <DialogDescription>Selling prices are editable later; the initial cost becomes a frozen batch.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="item-name">Name</Label>
            <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="item-floor">Floor price (₦)</Label>
              <NumberField id="item-floor" prefix="₦" decimals={2} value={floor} onChange={setFloor} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="item-suggested">Suggested price (₦)</Label>
              <NumberField id="item-suggested" prefix="₦" decimals={2} value={suggested} onChange={setSuggested} required />
            </div>
          </div>
          {canPurchase && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="item-qty">Initial quantity</Label>
                <NumberField id="item-qty" decimals={0} value={qty} onChange={setQty} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="item-cost">Cost per unit (₦)</Label>
                <NumberField id="item-cost" prefix="₦" decimals={2} value={cost} onChange={setCost} />
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="item-barcode" className="flex items-center gap-2"><IconScan size={14} /> Barcode on the pack <span className="text-muted-foreground font-normal">(optional — scan it now, or type it)</span></Label>
            <Input id="item-barcode" className="font-mono" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Point the scanner at the pack" />
          </div>
          <Button disabled={busy} className="justify-self-end">{busy ? "Saving…" : "Save item"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
