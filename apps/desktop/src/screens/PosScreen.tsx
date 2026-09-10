import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { ItemRow, SaleRow } from "@jakodav/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@jakodav/shared";
import { errorMessage, useSession } from "../lib/session.js";

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

  const [items, setItems] = useState<ItemRow[]>([]);
  const [stock, setStock] = useState<Map<string, number>>(new Map());
  /** Weighted cost of remaining stock per item — only fetched with items.view_cost. */
  const [costs, setCosts] = useState<Map<string, Kobo>>(new Map());
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const viewCost = perms.includes("items.view_cost");

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
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  // Success banner clears itself.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

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
    setError(null);
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
      setNotice(`Sale recorded — ${formatNaira(toKobo(sale.total))}`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid grid-rows-[auto_1fr]">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="font-semibold">{shop.name}</h1>
          <p className="text-xs text-muted-foreground">
            {ctx?.user?.full_name} · {active!.role.name}
            {device ? " · terminal activated" : " · terminal not activated"}
          </p>
        </div>
        <div className="flex gap-2">
          {can("items.create") && (
            <button className="btn-secondary" onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? "Close" : "Add item"}
            </button>
          )}
          <button className="btn-ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      <div className="grid grid-cols-[1fr_380px] min-h-0">
        {/* Items */}
        <section className="overflow-y-auto p-5 space-y-4">
          {error && <div className="alert-error">{error}</div>}
          {notice && <div className="rounded-md bg-status-green/10 text-status-green px-3 py-2 text-sm">{notice}</div>}

          {showAdd && can("items.create") && (
            <AddItemForm
              onDone={async (name) => {
                setShowAdd(false);
                setNotice(`Added “${name}”`);
                await load();
              }}
              onError={setError}
            />
          )}

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items yet.{can("items.create") ? " Add your first item to start selling." : ""}</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {items.map((it) => {
                const onHand = stock.get(it.id) ?? 0;
                const cost = costs.get(it.id);
                const suggested = toKobo(it.suggested_price);
                const margin = cost !== undefined ? ((suggested - cost) as Kobo) : undefined;
                return (
                  <button
                    key={it.id}
                    disabled={!can("sales.create") || onHand === 0}
                    onClick={() => addToCart(it)}
                    className="card text-left hover:border-primary disabled:opacity-50 transition-colors"
                  >
                    <div className="font-medium truncate">{it.name}</div>
                    <div className="text-sm">{formatNaira(toKobo(it.suggested_price))}</div>
                    <div className="text-xs text-muted-foreground">
                      floor {formatNaira(toKobo(it.floor_price))} · {onHand} in stock
                    </div>
                    {/* Cost + margin: Owner/Admin only (items.view_cost); salespeople never see this */}
                    {viewCost && cost !== undefined && margin !== undefined && (
                      <div className="text-xs text-muted-foreground mt-1">
                        cost {formatNaira(cost)} · margin{" "}
                        <span className={margin < 0 ? "text-status-red" : "text-status-green"}>
                          {formatNaira(margin)} ({suggested > 0 ? Math.round((margin / suggested) * 100) : 0}%)
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {sales.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-2">Recent sales</h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {sales.map((s) => (
                  <li key={s.id} className="flex justify-between px-4 py-2 text-sm">
                    <span className="text-muted-foreground">{new Date(s.sold_at).toLocaleString()}</span>
                    <span className="font-medium">{formatNaira(toKobo(s.total))}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Cart */}
        <aside className="border-l border-border p-5 flex flex-col gap-3 overflow-y-auto">
          <h2 className="font-medium">Sale</h2>
          {cart.length === 0 && <p className="text-sm text-muted-foreground">Tap an item to add it.</p>}
          {cart.map((l) => {
            const floor = toKobo(l.item.floor_price);
            const below = l.unitPrice < floor;
            return (
              <div key={l.item.id} className="card space-y-2 p-3">
                <div className="flex justify-between gap-2">
                  <span className="font-medium truncate">{l.item.name}</span>
                  <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setCart((c) => c.filter((x) => x !== l))}>
                    remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label">Qty</label>
                    <input type="number" min={1} className="input" value={l.quantity}
                      onChange={(e) => updateLine(l.item.id, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                  </div>
                  <div>
                    <label className="label">Price (₦)</label>
                    <input type="number" min={0} step="0.01" className={`input ${below ? "border-destructive" : ""}`}
                      value={fromKobo(l.unitPrice)}
                      onChange={(e) => { try { updateLine(l.item.id, { unitPrice: toKobo(e.target.value || "0") }); } catch { /* ignore partial input */ } }} />
                  </div>
                </div>
                {below && <p className="text-xs text-destructive">Below floor price {formatNaira(floor)}</p>}
              </div>
            );
          })}
          <div className="mt-auto space-y-2">
            {cartProblems.length > 0 && <div className="alert-error">{cartProblems[0]}</div>}
            <div className="flex justify-between text-lg font-semibold">
              <span>Total</span>
              <span>{formatNaira(total)}</span>
            </div>
            <button className="btn-primary w-full py-3 text-base" disabled={busy || cart.length === 0 || cartProblems.length > 0 || !can("sales.create")} onClick={() => void checkout()}>
              {busy ? "Recording…" : "Record sale"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Add item + initial stock. Cost is only asked for if the user may see/record it. */
function AddItemForm({ onDone, onError }: { onDone: (name: string) => Promise<void>; onError: (m: string) => void }) {
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
      await onDone(item.name);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h2 className="font-medium">New item</h2>
      <div>
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Floor price (₦)</label>
          <input type="number" min={0} step="0.01" className="input" value={floor} onChange={(e) => setFloor(e.target.value)} required />
        </div>
        <div>
          <label className="label">Suggested price (₦)</label>
          <input type="number" min={0} step="0.01" className="input" value={suggested} onChange={(e) => setSuggested(e.target.value)} required />
        </div>
      </div>
      {canPurchase && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Initial quantity</label>
            <input type="number" min={0} step={1} className="input" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div>
            <label className="label">Cost per unit (₦)</label>
            <input type="number" min={0} step="0.01" className="input" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
        </div>
      )}
      <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save item"}</button>
    </form>
  );
}
