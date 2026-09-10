import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ItemRow, SaleRow } from "@jakodav/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@jakodav/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { errorMessage, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

interface CartLine {
  item: ItemRow;
  quantity: number;
  /** Actual sale price as typed — may exceed suggested, never below floor. */
  unitPrice: Kobo;
}

/**
 * Stage 3 skeleton POS: item list + stock, add item, sell.
 * Barcode scanning (Stage 4) and offline queueing (Stage 5) plug in here.
 */
export function PosScreen() {
  const { ctx, active, device, inventory, signOut } = useSession();
  const shop = active!.shop;
  const perms = active!.permissions;
  const can = (p: (typeof perms)[number]) => perms.includes(p);
  const viewCost = can("items.view_cost");

  const [items, setItems] = useState<ItemRow[]>([]);
  const [stock, setStock] = useState<Map<string, number>>(new Map());
  /** Weighted cost of remaining stock per item — only fetched with items.view_cost. */
  const [costs, setCosts] = useState<Map<string, Kobo>>(new Map());
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // sales RLS already limits a salesperson to their own sales
  const load = useCallback(async () => {
    const [i, s, r, v] = await Promise.all([
      inventory.listItems(shop.id),
      inventory.stockQuantities(shop.id),
      inventory.recentSales(shop.id),
      viewCost ? inventory.stockOnHand(shop.id) : Promise.resolve([]),
    ]);
    setItems(i);
    setStock(s);
    setSales(r);
    setCosts(
      new Map(
        v.filter((row) => row.on_hand > 0)
          .map((row) => [row.item_id, Math.round(toKobo(row.stock_value) / row.on_hand) as Kobo]),
      ),
    );
  }, [inventory, shop.id, viewCost]);

  useEffect(() => {
    load().catch((e) => toast.error(errorMessage(e)));
  }, [load]);

  function addToCart(item: ItemRow) {
    setCart((c) => {
      const existing = c.find((l) => l.item.id === item.id);
      if (existing) return c.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { item, quantity: 1, unitPrice: toKobo(item.suggested_price) }];
    });
  }

  function updateLine(id: string, patch: Partial<Pick<CartLine, "quantity" | "unitPrice">>) {
    setCart((c) => c.map((l) => (l.item.id === id ? { ...l, ...patch } : l)));
  }

  const total = useMemo(() => addKobo(...cart.map((l) => mulKobo(l.unitPrice, l.quantity))), [cart]);

  const cartProblems = cart
    .map((l) => {
      const floor = toKobo(l.item.floor_price);
      if (l.unitPrice < floor) return `${l.item.name}: below floor ${formatNaira(floor)}`;
      const onHand = stock.get(l.item.id) ?? 0;
      if (l.quantity > onHand) return `${l.item.name}: only ${onHand} in stock`;
      return null;
    })
    .filter((x): x is string => !!x);

  async function checkout() {
    if (!ctx?.user || cart.length === 0 || cartProblems.length) return;
    setBusy(true);
    try {
      const sale = await inventory.recordSale({
        shopId: shop.id,
        // SYNC: client-generated so an offline replay can't double-record.
        clientRef: crypto.randomUUID(),
        soldBy: ctx.user.id,
        deviceId: device?.device_id ?? null,
        lines: cart.map((l) => ({
          item_id: l.item.id,
          quantity: l.quantity,
          unit_price: fromKobo(l.unitPrice),
        })),
      });
      setCart([]);
      toast.success(`Sale recorded — ${formatNaira(toKobo(sale.total))}`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid grid-rows-[auto_1fr]">
      <header className="flex items-center justify-between border-b px-5 py-3">
        <div>
          <h1 className="font-semibold">{shop.name}</h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{ctx?.user?.full_name}</span>
            <Badge variant="outline">{active!.role.name}</Badge>
            {device ? <Badge variant="success">Terminal activated</Badge> : <Badge variant="warning">Not activated</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          {can("items.create") && (
            <Button variant="outline" onClick={() => setShowAdd(true)}>
              <Plus /> Add item
            </Button>
          )}
          <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </header>

      <div className="grid grid-cols-[1fr_380px] min-h-0">
        {/* Items */}
        <section className="overflow-y-auto p-5 grid gap-6 content-start">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No items yet.{can("items.create") ? " Add your first item to start selling." : ""}
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
              {items.map((it) => {
                const onHand = stock.get(it.id) ?? 0;
                const cost = costs.get(it.id);
                const suggested = toKobo(it.suggested_price);
                const margin = cost !== undefined ? ((suggested - cost) as Kobo) : undefined;
                const disabled = !can("sales.create") || onHand === 0;
                return (
                  <Card
                    key={it.id}
                    role="button"
                    aria-disabled={disabled}
                    tabIndex={disabled ? -1 : 0}
                    onClick={() => !disabled && addToCart(it)}
                    onKeyDown={(e) => e.key === "Enter" && !disabled && addToCart(it)}
                    className={cn("py-4 gap-1 cursor-pointer transition-colors hover:border-primary", disabled && "opacity-50 cursor-not-allowed hover:border-border")}
                  >
                    <CardContent className="px-4 grid gap-0.5">
                      <div className="font-medium truncate">{it.name}</div>
                      <div className="text-sm">{formatNaira(suggested)}</div>
                      <div className="text-xs text-muted-foreground">
                        floor {formatNaira(toKobo(it.floor_price))} · {onHand} in stock
                      </div>
                      {/* Cost + margin: Owner/Admin only (items.view_cost); salespeople never see this */}
                      {viewCost && cost !== undefined && margin !== undefined && (
                        <div className="text-xs text-muted-foreground">
                          cost {formatNaira(cost)} · margin{" "}
                          <span className={margin < 0 ? "text-status-red" : "text-status-green"}>
                            {formatNaira(margin)} ({suggested > 0 ? Math.round((margin / suggested) * 100) : 0}%)
                          </span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {sales.length > 0 && (
            <div className="grid gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">Recent sales</h2>
              <Card className="py-0">
                <Table>
                  <TableBody>
                    {sales.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="text-muted-foreground">{new Date(s.sold_at).toLocaleString()}</TableCell>
                        <TableCell className="text-right font-medium">{formatNaira(toKobo(s.total))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </div>
          )}
        </section>

        {/* Cart */}
        <aside className="border-l p-5 flex flex-col gap-3 overflow-y-auto">
          <h2 className="font-medium">Sale</h2>
          {cart.length === 0 && <p className="text-sm text-muted-foreground">Tap an item to add it.</p>}
          {cart.map((l) => {
            const floor = toKobo(l.item.floor_price);
            const below = l.unitPrice < floor;
            return (
              <Card key={l.item.id} className="py-3 gap-2">
                <CardContent className="px-3 grid gap-2">
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-medium truncate">{l.item.name}</span>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => setCart((c) => c.filter((x) => x !== l))} aria-label="Remove">
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Qty</Label>
                      <Input type="number" min={1} value={l.quantity}
                        onChange={(e) => updateLine(l.item.id, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Price (₦)</Label>
                      <Input type="number" min={0} step="0.01" aria-invalid={below}
                        value={fromKobo(l.unitPrice)}
                        onChange={(e) => { try { updateLine(l.item.id, { unitPrice: toKobo(e.target.value || "0") }); } catch { /* ignore partial input */ } }} />
                    </div>
                  </div>
                  {below && <p className="text-xs text-destructive">Below floor price {formatNaira(floor)}</p>}
                </CardContent>
              </Card>
            );
          })}
          <div className="mt-auto grid gap-3">
            {cartProblems.length > 0 && <p className="text-sm text-destructive">{cartProblems[0]}</p>}
            <Separator />
            <div className="flex justify-between text-lg font-semibold">
              <span>Total</span>
              <span>{formatNaira(total)}</span>
            </div>
            <Button size="xl" className="w-full" disabled={busy || cart.length === 0 || cartProblems.length > 0 || !can("sales.create")} onClick={() => void checkout()}>
              {busy ? "Recording…" : "Record sale"}
            </Button>
          </div>
        </aside>
      </div>

      <AddItemDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        onDone={async (name) => {
          setShowAdd(false);
          toast.success(`Added “${name}”`);
          await load();
        }}
      />
    </div>
  );
}

/** Add item + initial stock. Cost is only asked for if the user may record purchases. */
function AddItemDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (name: string) => Promise<void> }) {
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
