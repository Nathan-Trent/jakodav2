import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { fromKobo, toKobo } from "@jakoda/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, useSession } from "@/lib/session";

/** Add item + initial stock. Cost is only asked for if the user may record purchases. */
export function AddItemDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (name: string) => Promise<void> }) {
  const { active, inventory } = useSession();
  const shop = active!.shop;
  const canPurchase = active!.permissions.includes("purchases.create");
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
      if (canPurchase && Number(qty) > 0) {
        // Initial stock = first immutable batch (PRD §5.1)
        await inventory.recordPurchase({
          shopId: shop.id,
          note: "Initial stock",
          lines: [{ itemId: item.id, quantity: Number(qty), unitCost: fromKobo(toKobo(cost || "0")) }],
        });
      }
      setName(""); setFloor(""); setSuggested(""); setQty(""); setCost("");
      await onDone(item.name);
    } catch (err) {
      toast.error(errorMessage(err));
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
              <Input id="item-floor" type="number" min={0} step="0.01" value={floor} onChange={(e) => setFloor(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="item-suggested">Suggested price (₦)</Label>
              <Input id="item-suggested" type="number" min={0} step="0.01" value={suggested} onChange={(e) => setSuggested(e.target.value)} required />
            </div>
          </div>
          {canPurchase && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="item-qty">Initial quantity</Label>
                <Input id="item-qty" type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="item-cost">Cost per unit (₦)</Label>
                <Input id="item-cost" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
              </div>
            </div>
          )}
          <Button disabled={busy} className="justify-self-end">{busy ? "Saving…" : "Save item"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
