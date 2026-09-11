import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconBarcode, IconPlus, IconTrash } from "@tabler/icons-react";
import type { ItemRow, SaleRow } from "@jakoda/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@jakoda/shared";
import { PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AddItemDialog } from "@/components/AddItemDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { notifyError, notifyInfo, notifySuccess } from "@/lib/feedback";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";
import { Alert } from "@/components/Alert";
import { announceStockChange, lookupBarcode, stockChannel } from "@jakoda/inventory-batches";
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
  const { ctx, active, device, inventory } = useSession();
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
  const [lastScan, setLastScan] = useState<{ code: string; ok: boolean; name?: string } | null>(null);
  const channelRef = useRef<ReturnType<typeof stockChannel> | null>(null);

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
    load().catch((e) => notifyError(e));
  }, [load]);

  // SYNC: other terminals announce stock changes on a per-shop broadcast
  // channel; we refetch quantities. Polling every 30s covers a missed message.
  useEffect(() => {
    const db = getSupabase();
    const ch = stockChannel(db, shop.id);
    ch.on("broadcast", { event: "stock" }, () => { void inventory.stockQuantities(shop.id).then(setStock).catch(() => {}); });
    ch.subscribe();
    channelRef.current = ch;
    const poll = window.setInterval(() => { void inventory.stockQuantities(shop.id).then(setStock).catch(() => {}); }, 30_000);
    return () => { window.clearInterval(poll); void db.removeChannel(ch); channelRef.current = null; };
  }, [inventory, shop.id]);

  // Barcode scanner (keyboard-wedge). Unknown codes say only "not recognised"
  // — never whether the code exists elsewhere (PRD §5.3).
  useBarcodeScanner(async (code) => {
    if (!can("sales.create")) return;
    try {
      const hit = await lookupBarcode(getSupabase(), shop.id, code);
      if (!hit || !hit.is_active) {
        setLastScan({ code, ok: false });
        notifyInfo("Barcode not recognised", `${code} isn't attached to any item in ${shop.name}.`);
        return;
      }
      const item = items.find((i) => i.id === hit.item_id);
      if (!item) { await load(); }
      const resolved = item ?? items.find((i) => i.id === hit.item_id);
      if (resolved) addToCart(resolved);
      setLastScan({ code, ok: true, name: hit.name });
    } catch (e) {
      notifyError(e);
    }
  }, { enabled: !showAdd });

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
      notifySuccess(`Sale recorded — ${formatNaira(toKobo(sale.total))}`, { description: `${sale.id.slice(0, 8)} · ${new Date(sale.sold_at).toLocaleTimeString()}` });
      await load();
      if (channelRef.current) void announceStockChange(channelRef.current, device?.device_id ?? null);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid grid-rows-[auto_1fr]">
      <PageHeader title="Sell" description="Scan a barcode or tap an item. Price can go above suggested, never below floor."
        actions={can("items.create") && <Button variant="outline" onClick={() => setShowAdd(true)}><IconPlus size={16} /> Add item</Button>} />

      <div className="grid grid-cols-[minmax(0,1fr)_380px] min-h-0">
        {/* Items */}
        <section className="overflow-y-auto px-8 pb-8 grid gap-6 content-start">
          {lastScan && (
            <Alert tone={lastScan.ok ? "success" : "warning"} title={lastScan.ok ? `Scanned: ${lastScan.name}` : "Barcode not recognised"}
              action={<button className="text-caption underline" onClick={() => setLastScan(null)}>Dismiss</button>}>
              <span className="font-mono">{lastScan.code}</span>{lastScan.ok ? " added to the sale." : ` — not attached to any item here. Attach it under Items.`}
            </Alert>
          )}
          {items.length === 0 ? (
            <Alert tone="info" title="No items yet" action={can("items.create") ? <Button size="sm" onClick={() => setShowAdd(true)}><IconPlus size={14} /> Add item</Button> : undefined}>
              {can("items.create") ? "Add your first item, then scan or tap it to sell." : "Ask the shop owner to add items."}
            </Alert>
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
                    className={cn("py-4 gap-1 cursor-pointer pressable hover:border-brand-action", disabled && "opacity-50 cursor-not-allowed hover:border-border")}
                  >
                    <CardContent className="px-4 grid gap-0.5">
                      <div className="font-medium truncate">{it.name}</div>
                      <div className="figure text-[17px] tabular">{formatNaira(suggested)}</div>
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
        <aside className="border-l bg-card p-5 flex flex-col gap-3 overflow-y-auto">
          <h2 className="font-medium">Sale</h2>
          {cart.length === 0 && (
            <div className="text-sm text-muted-foreground flex items-center gap-2"><IconBarcode size={16} /> Scan a barcode or tap an item to add it.</div>
          )}
          {cart.map((l) => {
            const floor = toKobo(l.item.floor_price);
            const below = l.unitPrice < floor;
            return (
              <Card key={l.item.id} className="py-3 gap-2">
                <CardContent className="px-3 grid gap-2">
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-medium truncate">{l.item.name}</span>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => setCart((c) => c.filter((x) => x !== l))} aria-label="Remove">
                      <IconTrash size={16} />
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
            <div className="flex justify-between items-baseline">
              <span className="text-subheading">Total</span>
              <span className="figure figure-lg">{formatNaira(total)}</span>
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
          notifySuccess(`Added “${name}”`);
          await load();
        }}
      />
    </div>
  );
}
