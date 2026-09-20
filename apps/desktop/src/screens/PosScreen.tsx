import { useEffect, useMemo, useState } from "react";
import { IconBarcode, IconCamera, IconPlayerPause, IconPlus, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import type { ItemRow } from "@zogal/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, PAYMENT_LABEL, type Kobo, type PaymentType } from "@zogal/shared";
import { announceStockChange, lookupBarcode, stockChannel } from "@zogal/inventory-batches";
import { enqueue } from "@zogal/sync";
import { PageHeader } from "@/components/AppShell";
import { AddItemDialog } from "@/components/AddItemDialog";
import { CustomerPicker } from "@/components/CustomerPicker";
import { PaymentTypePicker } from "@/components/PaymentTypePicker";
import { Alert, Button, Card, CardContent, ConfirmDialog, Input, NumberField, Label, Separator, notifyError, notifyInfo, notifySuccess, cn } from "@zogal/ui";
import { StaleNotice } from "@/components/StaleNotice";
import { heldAgo, loadHeld, saveHeld, type HeldSale } from "@/lib/heldSales";
import { useFeature } from "@/lib/entitlements";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import type { OfflineCustomerRef } from "@/lib/shopView";
import type { PageKey } from "@/lib/nav";
import { useSync } from "@/lib/sync";
import { getSupabase } from "@/lib/supabase";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

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
 * stays fully usable with no network: items, prices and stock are whatever
 * was last downloaded, and new sales queue locally.
 *
 * This screen does ONE job — the sale in front of the cashier. History,
 * figures and customers live on their own screens (Nathan, 2026-09-12).
 */
export function PosScreen({ onNavigate }: { onNavigate?: (k: PageKey) => void } = {}) {
  const { ctx, active, device, inventory } = useSession();
  const { data, loading, stockFor, costPerUnit, reloadOverlay, refresh } = useShopData();
  const { writable } = useSync();
  const shop = active!.shop;
  const perms = active!.permissions;
  const can = (p: (typeof perms)[number]) => perms.includes(p);
  const viewCost = can("items.view_cost");
  const customersOn = useFeature("customers");   // 0027: plan may not include customers
  const scansOn = useFeature("notebook_scans");

  const [cart, setCart] = useState<CartLine[]>([]);
  // Search by name or code against the terminal's working set — instant,
  // offline. The fallback when a scan doesn't read: type three letters, tap.
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return data.items;
    const byCode = new Set(data.barcodes.filter((b) => b.code.includes(needle)).map((b) => b.item_id));
    return data.items.filter((i) => i.name.toLowerCase().includes(needle) || byCode.has(i.id));
  }, [q, data.items, data.barcodes]);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [lastScan, setLastScan] = useState<{ code: string; ok: boolean; name?: string } | null>(null);
  const [customer, setCustomer] = useState<OfflineCustomerRef | null>(null);
  // How the customer paid. Owner's choice (0023): 'optional' assumes cash unless
  // changed; 'required' makes the cashier pick every time. Resets after each sale.
  const payMode = shop.preferences?.payment_type_mode ?? "optional";
  const [paymentType, setPaymentType] = useState<PaymentType | null>(payMode === "required" ? null : "cash");
  const resetPayment = () => setPaymentType(payMode === "required" ? null : "cash");

  // Held sales: carts parked mid-sale, local to this terminal (see lib/heldSales).
  const [held, setHeld] = useState<HeldSale[]>(() => loadHeld(shop.id));
  useEffect(() => { saveHeld(shop.id, held); }, [shop.id, held]);
  // Resume asked for while the cart still has lines — ask before losing anything.
  const [resumeClash, setResumeClash] = useState<HeldSale | null>(null);
  const [discardAsk, setDiscardAsk] = useState<HeldSale | null>(null);
  // Tick once a minute so "4 min ago" stays honest while the list is visible.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (held.length === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [held.length]);

  function clearCart() { setCart([]); setCustomer(null); resetPayment(); }

  function holdSale() {
    if (cart.length === 0) return;
    const h: HeldSale = { id: crypto.randomUUID(), heldAt: new Date().toISOString(), lines: cart, customer, paymentType };
    setHeld((hs) => [h, ...hs]);
    clearCart();
    notifyInfo("Sale held", `${customer ? customer.name : `${cart.length} item${cart.length === 1 ? "" : "s"}`} — resume it from “Held sales” when they're ready.`);
  }

  /** Put a held sale back into the cart. Items may have changed since it was held, so refresh each line from the working set. */
  function resume(h: HeldSale) {
    if (cart.length > 0) { setResumeClash(h); return; }
    applyResume(h);
  }
  /** `holdCurrent`: park what's in the cart first (the clash dialog's default). */
  function applyResume(h: HeldSale, holdCurrent = false) {
    const parked: HeldSale | null = holdCurrent && cart.length > 0
      ? { id: crypto.randomUUID(), heldAt: new Date().toISOString(), lines: cart, customer, paymentType }
      : null;
    setHeld((hs) => [...(parked ? [parked] : []), ...hs.filter((x) => x.id !== h.id)]);
    setCart(h.lines.map((l) => ({ ...l, item: data.items.find((i) => i.id === l.item.id) ?? l.item })));
    setCustomer(h.customer);
    setPaymentType(h.paymentType ?? (payMode === "required" ? null : "cash"));
    setResumeClash(null);
  }

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
        // A customer added at the till is created first so the sale can
        // reference it; a known one is passed by id.
        let customerId: string | null = null;
        if (customer && "id" in customer) customerId = customer.id;
        else if (customer) {
          // SYNC (0026): added on this terminal and maybe not uploaded yet —
          // the same idempotent replay the engine uses returns its server id
          // (or creates it now). A pre-0026 {name, phone} ref gets a fresh ref.
          const { data: id, error } = await getSupabase().rpc("replay_offline_customer", {
            p_shop_id: shop.id, p_client_ref: "client_ref" in customer ? customer.client_ref : crypto.randomUUID(),
            p_created_by: ctx.user.id, p_name: customer.name, p_phone: customer.phone, p_note: null,
          });
          if (error) throw error;
          customerId = id as string;
        }
        const sale = await inventory.recordSale({
          shopId: shop.id, clientRef, soldBy: ctx.user.id,
          deviceId: device?.device_id ?? null, soldAt, customerId, paymentType: paymentType ?? "cash",
          lines: lines.map(({ item_id, quantity, unit_price }) => ({ item_id, quantity, unit_price })),
        });
        setCart([]);
        setCustomer(null);
        notifySuccess(`Sale recorded — ${formatNaira(toKobo(sale.total))}`, { description: `${PAYMENT_LABEL[paymentType ?? "cash"]}${customer ? ` · for ${customer.name}` : ""}.` });
        resetPayment();
        await refresh();
        void announceStockChange(stockChannel(getSupabase(), shop.id), device?.device_id ?? null);
      } else {
        await enqueue({
          kind: "sale", clientRef, shopId: shop.id,
          deviceId: device?.device_id ?? null, userId: ctx.user.id, occurredAt: soldAt,
          // SYNC: the customer reference rides with the sale (0012 replay).
          payload: { lines, note: null, customer, payment_type: paymentType ?? "cash" },
        });
        // The overlay re-reads the outbox: stock, history and figures all
        // move at once, computed locally.
        await reloadOverlay();
        setCart([]);
        setCustomer(null);
        resetPayment();
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
        actions={<>
          {/* 0029: the day's handwritten sales page is another way to record sales. */}
          {scansOn && onNavigate && <Button variant="outline" onClick={() => onNavigate("notebook")}><IconCamera size={16} /> Scan a sales page</Button>}
          {can("items.create") && <Button variant="outline" onClick={() => setShowAdd(true)}><IconPlus size={16} /> Add item</Button>}
        </>}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_380px] min-h-0">
        <section className="overflow-y-auto px-8 pb-8 grid gap-4 content-start">
          <StaleNotice />

          {data.items.length > 0 && (
            <label className="relative block max-w-md">
              <IconSearch size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-11 pl-10 pr-10 text-[15px]" placeholder="Search by name or code" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && shown.length === 1 && shown[0] && can("sales.create") && writable && stockFor(shown[0].id) > 0) { addToCart(shown[0]); setQ(""); } if (e.key === "Escape") setQ(""); }} />
              {q && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search" onClick={() => setQ("")}><IconX size={16} /></button>}
            </label>
          )}

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
              {shown.length === 0 && <p className="text-small text-muted-foreground col-span-full">Nothing matches “{q}”.</p>}
              {shown.map((it) => {
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

        </section>

        <aside className="border-l bg-card p-5 flex flex-col gap-3 overflow-y-auto">
          <h2 className="font-medium">Sale</h2>
          {held.length > 0 && (
            <div className="rounded-[10px] border bg-muted/40 p-3 grid gap-2">
              <div className="text-caption text-muted-foreground">Held sales ({held.length})</div>
              {held.map((h) => {
                const n = h.lines.length;
                const sum = addKobo(...h.lines.map((l) => { const x = lineNumbers(l); return x.quantity && x.unitPrice !== null ? mulKobo(x.unitPrice, x.quantity) : (0 as Kobo); }));
                return (
                  <div key={h.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left rounded-md px-2 py-1.5 hover:bg-background pressable disabled:opacity-50"
                      disabled={busy || !can("sales.create")}
                      onClick={() => resume(h)}
                      title="Resume this sale"
                    >
                      <div className="flex justify-between gap-2">
                        <span className="font-medium truncate">{h.customer?.name ?? "No name"}</span>
                        <span className="tabular">{formatNaira(sum)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{n} item{n === 1 ? "" : "s"} · {heldAgo(h.heldAt)} · tap to resume</div>
                    </button>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Discard held sale" onClick={() => setDiscardAsk(h)}>
                      <IconTrash size={14} />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {customersOn && <CustomerPicker value={customer} onChange={setCustomer} disabled={busy || !can("sales.create")} />}
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
            {payMode === "required" ? (
              <div className="grid gap-1">
                <Label className="text-caption text-muted-foreground">How did the customer pay?</Label>
                <PaymentTypePicker value={paymentType} onChange={setPaymentType} disabled={busy || cart.length === 0} required />
              </div>
            ) : (
              <details className="text-caption text-muted-foreground">
                <summary className="cursor-pointer select-none">Paid by: <span className="font-semibold text-foreground">{PAYMENT_LABEL[paymentType ?? "cash"]}</span> — change</summary>
                <div className="mt-2"><PaymentTypePicker value={paymentType} onChange={setPaymentType} disabled={busy} /></div>
              </details>
            )}
            <div className="flex justify-between items-baseline">
              <span className="text-subheading">Total</span>
              <span className="figure figure-lg">{formatNaira(total)}</span>
            </div>
            <Button size="xl" className="w-full" disabled={busy || cart.length === 0 || cartProblems.length > 0 || !can("sales.create") || !writable || (payMode === "required" && !paymentType)} onClick={() => void checkout()}>
              {busy ? "Recording…" : payMode === "required" && !paymentType ? "Choose how they paid" : `Record ${PAYMENT_LABEL[paymentType ?? "cash"].toLowerCase()} sale`}
            </Button>
            <Button variant="outline" className="w-full" disabled={busy || cart.length === 0} onClick={holdSale} title="Park this sale and serve the next customer">
              <IconPlayerPause size={16} /> Hold sale
            </Button>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={resumeClash !== null}
        onOpenChange={(o) => !o && setResumeClash(null)}
        title="There's a sale in progress"
        description="Hold the current sale before bringing this one back, or discard what's in the cart?"
        confirmLabel="Hold current, then resume"
        onConfirm={() => applyResume(resumeClash!, true)}
      >
        <Button variant="ghost" className="text-destructive" onClick={() => applyResume(resumeClash!)}>
          Discard current cart and resume
        </Button>
      </ConfirmDialog>

      <ConfirmDialog
        open={discardAsk !== null}
        onOpenChange={(o) => !o && setDiscardAsk(null)}
        title="Discard this held sale?"
        description={discardAsk ? `${discardAsk.customer?.name ?? "No name"} · ${discardAsk.lines.length} item${discardAsk.lines.length === 1 ? "" : "s"}. Nothing was sold, so nothing is reversed — the items just won't come back.` : undefined}
        confirmLabel="Discard"
        destructive
        onConfirm={() => { setHeld((hs) => hs.filter((x) => x.id !== discardAsk!.id)); setDiscardAsk(null); }}
      />

      <AddItemDialog open={showAdd} onOpenChange={setShowAdd} onDone={async (name) => { setShowAdd(false); notifySuccess(`Added “${name}”`); await refresh(); }} />
    </div>
  );
}
