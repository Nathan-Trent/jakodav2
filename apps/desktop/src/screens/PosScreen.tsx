import { useMemo, useState } from "react";
import { IconBarcode, IconCloudUpload, IconPlus, IconTrash } from "@tabler/icons-react";
import type { ItemRow } from "@zogal/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@zogal/shared";
import { announceStockChange, lookupBarcode, stockChannel } from "@zogal/inventory-batches";
import { enqueue } from "@zogal/sync";
import { PageHeader } from "@/components/AppShell";
import { AddItemDialog } from "@/components/AddItemDialog";
import { Alert } from "@/components/Alert";
import { StaleNotice } from "@/components/StaleNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NumberField } from "@/components/ui/number-field";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { notifyError, notifyInfo, notifySuccess } from "@/lib/feedback";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import { useSync } from "@/lib/sync";
import { getSupabase } from "@/lib/supabase";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";
import { cn } from "@/lib/utils";

interface CartLine {
  item: ItemRow;
  /** Kept as typed so the box can be empty mid-edit; parsed where used. */
  qtyText: string;
  /** Actual sale price as typed — may exceed suggested, never below floor. */
  priceText: string;
}

/** Parse a line; null where the user hasn't given a usable number yet. */
function lineNumbers(l: CartLine): { quantity: number | null; unitPrice: Kobo | null } {
  const q = l.qtyText === "" ? null : Math.floor(Number(l.qtyText));
  let p: Kobo | null = null;
  try { p = l.priceText === "" ? null : toKobo(l.priceText); } catch { p = null; }
  return { quantity: q !== null && q > 0 ? q : null, unitPrice: p };
}

/**
 * The till. Reads entirely from the terminal's working set (shopData), so it
 * stays fully usable with no network: items, prices, stock and recent sales
 * are whatever was last downloaded, and new sales queue locally.
 */
export function PosScreen() {
  const { ctx, active, device, inventory } = useSession();
  const { data, loading, stockFor, costPerUnit, reloadOverlay, refresh } = useShopData();
  const { writable } = useSync();
  const shop = active!.shop;
  const perms = active!.permissions;
  const can = (p: (typeof perms)[number]) => perms.includes(p);
  const viewCost = can("items.view_cost");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [lastScan, setLastScan] = useState<{ code: string; ok: boolean; name?: string } | null>(null);

  function addToCart(item: ItemRow) {
    setCart((c) => {
      const existing = c.find((l) => l.item.id === item.id);
      if (existing) return c.map((l) => (l === existing ? { ...l, qtyText: String((lineNumbers(l).quantity ?? 0) + 1) } : l));
      return [...c, { item, qtyText: "1", priceText: fromKobo(toKobo(item.suggested_price)) }];
    });
  }

  function updateLine(id: string, patch: Partial<Pick<CartLine, "qtyText" | "priceText">>) {
    setCart((c) => c.map((l) => (l.item.id === id ? { ...l, ...patch } : l)));
  }

  /**
   * Scanner. Resolves against the cached barcode list first, so scanning keeps
   * working offline; the server is only consulted for a code we've never seen.
   * An unknown code says only "not recognised" (PRD §5.3).
   */
  useBarcodeScanner(async (code) => {
    if (!can("sales.create")) return;
    const trimmed = code.trim();
    let itemId = data.barcodes.find((b) => b.code === trimmed)?.item_id ?? null;

    if (!itemId && navigator.onLine) {
      try {
        itemId = (await lookupBarcode(getSupabase(), shop.id, trimmed))?.item_id ?? null;
      } catch { /* offline or server down: the cache is all we have, and that's fine */ }
    }

    const item = itemId ? data.items.find((i) => i.id === itemId) : undefined;
    if (!item || !item.is_active) {
      setLastScan({ code: trimmed, ok: false });
      notifyInfo("Barcode not recognised", `${trimmed} isn't attached to any item in ${shop.name}.`);
      return;
    }
    addToCart(item);
    setLastScan({ code: trimmed, ok: true, name: item.name });
  }, { enabled: !showAdd });

  const total = useMemo(
    () => addKobo(...cart.map((l) => { const n = lineNumbers(l); return n.quantity && n.unitPrice !== null ? mulKobo(n.unitPrice, n.quantity) : (0 as Kobo); })),
    [cart],
  );

  const cartProblems = cart
    .map((l) => {
      const { quantity, unitPrice } = lineNumbers(l);
      if (quantity === null) return `${l.item.name}: enter a quantity`;
      if (unitPrice === null) return `${l.item.name}: enter a price`;
      const floor = toKobo(l.item.floor_price);
      if (unitPrice < floor) return `${l.item.name}: below floor ${formatNaira(floor)}`;
      const onHand = stockFor(l.item.id);
      if (quantity > onHand) return `${l.item.name}: only ${onHand} in stock`;
      return null;
    })
    .filter((x): x is string => !!x);

  /**
   * SYNC: the sale is a fact the moment the goods leave the shop. Online we
   * write through so other terminals see the stock; offline we queue it and
   * apply the stock change locally. The same client_ref makes a later replay
   * idempotent either way.
   */
  async function checkout() {
    if (!ctx?.user || cart.length === 0 || cartProblems.length || !writable) return;
    setBusy(true);
    const clientRef = crypto.randomUUID();
    const soldAt = new Date().toISOString();
    const lines = cart.map((l) => {
      const n = lineNumbers(l);
      return {
        item_id: l.item.id,
        quantity: n.quantity!,          // cartProblems guarantees these
        unit_price: fromKobo(n.unitPrice!),
        // Snapshot so a floor changed while offline can't void a real sale.
        floor_price_at_sale: fromKobo(toKobo(l.item.floor_price)),
      };
    });

    try {
      if (navigator.onLine) {
        const sale = await inventory.recordSale({
          shopId: shop.id, clientRef, soldBy: ctx.user.id,
          deviceId: device?.device_id ?? null, soldAt,
          lines: lines.map(({ item_id, quantity, unit_price }) => ({ item_id, quantity, unit_price })),
        });
        setCart([]);
        notifySuccess(`Sale recorded — ${formatNaira(toKobo(sale.total))}`);
        await refresh();
        void announceStockChange(stockChannel(getSupabase(), shop.id), device?.device_id ?? null);
      } else {
        await enqueue({
          kind: "sale", clientRef, shopId: shop.id,
          deviceId: device?.device_id ?? null, userId: ctx.user.id, occurredAt: soldAt,
          payload: { lines, note: null },
        });
        // The overlay re-reads the outbox: stock, history and figures all
        // move at once, computed locally.
        await reloadOverlay();
        setCart([]);
        notifySuccess(`Sale saved — ${formatNaira(total)}`, {
          description: "Recorded on this terminal. It uploads automatically when the connection returns.",
        });
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid grid-rows-[auto_1fr]">
      <PageHeader
        title="Sell"
        description="Scan a barcode or tap an item. Price can go above suggested, never below floor."
        actions={can("items.create") && <Button variant="outline" onClick={() => setShowAdd(true)}><IconPlus size={16} /> Add item</Button>}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_380px] min-h-0">
        <section className="overflow-y-auto px-8 pb-8 grid gap-4 content-start">
          <StaleNotice />

          {!writable && (
            <Alert tone="warning" title="Selling is paused on this terminal">
              You can still look up stock and past sales. Sync to start selling again.
            </Alert>
          )}

          {lastScan && (
            <Alert
              tone={lastScan.ok ? "success" : "warning"}
              title={lastScan.ok ? `Scanned: ${lastScan.name}` : "Barcode not recognised"}
              action={<button className="text-caption underline" onClick={() => setLastScan(null)}>Dismiss</button>}
            >
              <span className="font-mono">{lastScan.code}</span>
              {lastScan.ok ? " added to the sale." : " — not attached to any item here. Attach it under Items."}
            </Alert>
          )}

          {loading ? (
            <p className="text-small text-muted-foreground">Loading items…</p>
          ) : data.items.length === 0 ? (
            <Alert
              tone="info"
              title="No items yet"
              action={can("items.create") ? <Button size="sm" onClick={() => setShowAdd(true)}><IconPlus size={14} /> Add item</Button> : undefined}
            >
              {can("items.create") ? "Add your first item, then scan or tap it to sell." : "Ask the shop owner to add items."}
            </Alert>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
              {data.items.map((it) => {
                const onHand = stockFor(it.id);
                const cost = costPerUnit(it.id);
                const suggested = toKobo(it.suggested_price);
                const margin = cost !== undefined ? ((suggested - cost) as Kobo) : undefined;
                const disabled = !can("sales.create") || onHand === 0 || !writable;
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

          {data.sales.length > 0 && (
            <div>
              <h2 className="text-small font-medium text-muted-foreground mb-2">Recent sales</h2>
              <ul className="divide-y rounded-lg border bg-card">
                {data.sales.slice(0, 8).map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="text-muted-foreground flex-1">{new Date(s.sold_at).toLocaleString()}</span>
                    {s.pending && (
                      <span className="inline-flex items-center gap-1 text-caption text-status-amber" title="Recorded on this terminal; uploads when the connection returns">
                        <IconCloudUpload size={12} /> Not yet uploaded
                      </span>
                    )}
                    <span className="font-medium tabular">{formatNaira(toKobo(s.total))}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="border-l bg-card p-5 flex flex-col gap-3 overflow-y-auto">
          <h2 className="font-medium">Sale</h2>
          {cart.length === 0 && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <IconBarcode size={16} /> Scan a barcode or tap an item to add it.
            </div>
          )}
          {cart.map((l) => {
            const floor = toKobo(l.item.floor_price);
            const { unitPrice } = lineNumbers(l);
            const below = unitPrice !== null && unitPrice < floor;
            return (
              <div key={l.item.id} className="rounded-[10px] border p-3 grid gap-2">
                <div className="flex justify-between gap-2">
                  <span className="font-medium truncate">{l.item.name}</span>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Remove" onClick={() => setCart((c) => c.filter((x) => x !== l))}>
                    <IconTrash size={14} />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label className="text-caption text-muted-foreground">Qty</Label>
                    <NumberField decimals={0} min={1} value={l.qtyText} onChange={(v) => updateLine(l.item.id, { qtyText: v })} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-caption text-muted-foreground">Price</Label>
                    <NumberField prefix="₦" decimals={2} value={l.priceText} aria-invalid={below}
                      onChange={(v) => updateLine(l.item.id, { priceText: v })} />
                  </div>
                </div>
                {below && <p className="text-xs text-destructive">Below floor price {formatNaira(floor)}</p>}
              </div>
            );
          })}
          <div className="mt-auto grid gap-2">
            {cartProblems.length > 0 && <p className="text-small text-destructive">{cartProblems[0]}</p>}
            <Separator />
            <div className="flex justify-between items-baseline">
              <span className="text-subheading">Total</span>
              <span className="figure figure-lg">{formatNaira(total)}</span>
            </div>
            <Button size="xl" className="w-full" disabled={busy || cart.length === 0 || cartProblems.length > 0 || !can("sales.create") || !writable} onClick={() => void checkout()}>
              {busy ? "Recording…" : "Record sale"}
            </Button>
          </div>
        </aside>
      </div>

      <AddItemDialog open={showAdd} onOpenChange={setShowAdd} onDone={async (name) => { setShowAdd(false); notifySuccess(`Added “${name}”`); await refresh(); }} />
    </div>
  );
}
