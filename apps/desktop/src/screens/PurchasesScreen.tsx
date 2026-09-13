import { useEffect, useMemo, useState } from "react";
import { IconBarcode, IconPencil, IconTrash, IconTruckDelivery } from "@tabler/icons-react";
import type { BatchRow, ItemRow } from "@zogal/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@zogal/shared";
import { announceStockChange, lookupBarcode, setItemPrices, stockChannel } from "@zogal/inventory-batches";
import { PageHeader } from "@/components/AppShell";
import { StaleNotice } from "@/components/StaleNotice";
import { TerminalFilter, useTerminalName } from "@/components/TerminalFilter";
import { useShopData } from "@/lib/shopData";
import { CostCorrectionDialog } from "@/components/CostCorrectionDialog";
import { Alert, Badge, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, NumberField, Label, Separator, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifyInfo, notifySuccess, cn } from "@zogal/ui";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

interface RestockLine {
  item: ItemRow;
  /** Kept as typed so the boxes can be empty mid-edit; parsed where used. */
  qtyText: string;
  costText: string;
  /** Cost of the newest existing batch, for change detection (PRD §6.3). */
  lastCost: Kobo | null;
}

function lineNumbers(l: RestockLine): { quantity: number | null; unitCost: Kobo | null } {
  const q = l.qtyText === "" ? null : Math.floor(Number(l.qtyText));
  let c: Kobo | null = null;
  try { c = l.costText === "" ? null : toKobo(l.costText); } catch { c = null; }
  return { quantity: q !== null && q > 0 ? q : null, unitCost: c };
}

/**
 * Restock: scan or pick items, enter quantity + cost. Every line becomes a
 * new immutable batch — a different cost NEVER edits an old batch (PRD §6.3).
 * After saving, if any cost changed vs the last batch, the owner is asked
 * whether to update that item's selling prices — a deliberate, logged step.
 */
export function PurchasesScreen() {
  const { active, inventory, device } = useSession();
  const { data, refresh } = useShopData();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");

  const [lines, setLines] = useState<RestockLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [priceReview, setPriceReview] = useState<RestockLine[] | null>(null);
  const [correcting, setCorrecting] = useState<BatchRow | null>(null);
  const canCorrect = perms.includes("purchases.correct_cost");

  const items = data.items;
  // Newest batch per item, from the working set — available offline too.
  const latestBatch = useMemo(() => {
    const m = new Map<string, BatchRow>();
    for (const b of data.batches) if (!m.has(b.item_id)) m.set(b.item_id, b);
    return m;
  }, [data.batches]);
  const [terminal, setTerminal] = useState<string | null>(null);
  const terminalName = useTerminalName();
  const purchaseDevice = useMemo(() => new Map(data.purchases.map((p) => [p.id, p.device_id])), [data.purchases]);
  const recent = data.batches
    .filter((b) => !terminal || (b.purchase_id && purchaseDevice.get(b.purchase_id) === terminal))
    .slice(0, 25);

  function addLine(item: ItemRow) {
    setLines((ls) => {
      if (ls.some((l) => l.item.id === item.id)) return ls.map((l) => (l.item.id === item.id ? { ...l, qtyText: String((lineNumbers(l).quantity ?? 0) + 1) } : l));
      const last = latestBatch.get(item.id);
      const lastCost = last ? toKobo(last.unit_cost) : null;
      return [...ls, { item, qtyText: "1", costText: lastCost !== null ? fromKobo(lastCost) : "", lastCost }];
    });
  }

  // Cache first, so scanning a delivery works with no connection.
  useBarcodeScanner(async (code) => {
    const trimmed = code.trim();
    let itemId = data.barcodes.find((b) => b.code === trimmed)?.item_id ?? null;
    if (!itemId && navigator.onLine) {
      try { itemId = (await lookupBarcode(getSupabase(), shop.id, trimmed))?.item_id ?? null; } catch { /* cache is enough */ }
    }
    const item = itemId ? items.find((i) => i.id === itemId) : undefined;
    if (!item) { notifyInfo("Barcode not recognised", `${trimmed} isn't attached to any item here.`); return; }
    addLine(item);
  }, { enabled: !priceReview });

  const total = useMemo(
    () => addKobo(...lines.map((l) => { const n = lineNumbers(l); return n.quantity && n.unitCost !== null ? mulKobo(n.unitCost, n.quantity) : (0 as Kobo); })),
    [lines],
  );
  const problems = lines.filter((l) => { const n = lineNumbers(l); return n.quantity === null || n.unitCost === null; });
  const filtered = items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12);

  async function save() {
    if (lines.length === 0 || problems.length) return;
    // Receiving stock creates immutable batches and can shift selling prices,
    // so unlike a sale it is NOT queued offline — doing so would let two
    // terminals invent conflicting batch histories for the same delivery.
    if (!navigator.onLine) {
      notifyInfo("Can't receive stock while offline", "Deliveries need a connection so batch costs stay consistent across terminals. Your list is kept — try again when you're back online.");
      return;
    }
    setBusy(true);
    try {
      await inventory.recordPurchase({
        shopId: shop.id,
        deviceId: device?.device_id ?? null,
        supplierName: supplier.trim() || undefined,
        lines: lines.map((l) => { const n = lineNumbers(l); return { itemId: l.item.id, quantity: n.quantity!, unitCost: fromKobo(n.unitCost!) }; }),
      });
      notifySuccess("Stock received", { description: `${lines.reduce((s, l) => s + (lineNumbers(l).quantity ?? 0), 0)} units across ${lines.length} item(s) — each at its own batch cost.` });
      void announceStockChange(stockChannel(getSupabase(), shop.id), device?.device_id ?? null);
      const changed = lines.filter((l) => l.lastCost !== null && l.lastCost !== lineNumbers(l).unitCost);
      setLines([]);
      setSupplier("");
      await refresh();
      if (changed.length && perms.includes("items.edit")) setPriceReview(changed);
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Purchases" description="Receive stock. Each line becomes a new batch at its own cost — old batches are never changed." />
      <div className="px-8 pb-2"><StaleNotice /></div>
      <div className="px-8 pb-8 grid grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        {/* Left: pick items + history */}
        <div className="grid gap-6">
          <Card>
            <CardContent className="grid gap-3">
              <div className="flex items-center justify-between">
                <div className="text-title">Add items to this delivery</div>
                <span className="text-caption text-muted-foreground flex items-center gap-1"><IconBarcode size={14} /> or scan</span>
              </div>
              <Input placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} />
              {items.length === 0 ? (
                <Alert tone="info" title="No items yet">Add items under Items first, then receive stock here.</Alert>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
                  {filtered.map((it) => {
                    const last = latestBatch.get(it.id);
                    return (
                      <button key={it.id} onClick={() => addLine(it)} className="text-left rounded-[10px] border px-3 py-2 hover:border-brand-action transition-colors pressable">
                        <div className="text-small font-semibold truncate">{it.name}</div>
                        <div className="text-caption text-muted-foreground">{last ? `last cost ${formatNaira(toKobo(last.unit_cost))}` : "no batches yet"}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {viewCost && recent.length > 0 && (
            <Card className="py-0">
              <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
                <div className="text-title">Recent batches</div>
                <TerminalFilter value={terminal} onChange={setTerminal} />
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Received</TableHead>
                    <TableHead>Item</TableHead>
                    {!terminal && <TableHead>Terminal</TableHead>}
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Left</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="pr-5"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="pl-5 text-muted-foreground">{new Date(b.purchased_at).toLocaleDateString()}</TableCell>
                      <TableCell className="font-semibold">{items.find((i) => i.id === b.item_id)?.name ?? "—"}</TableCell>
                      {!terminal && <TableCell className="text-muted-foreground">{(b.purchase_id && terminalName(purchaseDevice.get(b.purchase_id) ?? null)) || "—"}</TableCell>}
                      <TableCell className="text-right tabular">{b.quantity_received}</TableCell>
                      <TableCell className="text-right tabular">{b.quantity_remaining === 0 ? <Badge variant="secondary">Sold out</Badge> : b.quantity_remaining}</TableCell>
                      <TableCell className="text-right tabular">{formatNaira(toKobo(b.unit_cost))}</TableCell>
                      <TableCell className="pr-5 text-right">
                        {canCorrect && (
                          <Button variant="ghost" size="sm" onClick={() => setCorrecting(b)} title="Correct a mistyped cost (logged)">
                            <IconPencil size={14} /> Correct
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>

        {/* Right: the delivery */}
        <Card className="sticky top-6">
          <CardContent className="grid gap-3">
            <div className="text-title flex items-center gap-2"><IconTruckDelivery size={18} /> This delivery</div>
            <div className="grid gap-1.5">
              <Label htmlFor="supplier" className="text-caption text-muted-foreground">Supplier (optional)</Label>
              <Input id="supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={200} />
            </div>
            {lines.length === 0 && <p className="text-small text-muted-foreground">Scan or pick items to receive.</p>}
            {lines.map((l) => {
              const { unitCost } = lineNumbers(l);
              const changed = l.lastCost !== null && unitCost !== null && l.lastCost !== unitCost;
              return (
                <div key={l.item.id} className="rounded-[10px] border p-3 grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold truncate">{l.item.name}</span>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Remove" onClick={() => setLines((ls) => ls.filter((x) => x !== l))}><IconTrash size={14} /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <Label className="text-caption text-muted-foreground">Quantity</Label>
                      <NumberField decimals={0} min={1} value={l.qtyText} onChange={(v) => setLines((ls) => ls.map((x) => x === l ? { ...x, qtyText: v } : x))} />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-caption text-muted-foreground">Cost per unit</Label>
                      <NumberField prefix="₦" decimals={2} value={l.costText} className={cn(changed && "[&_input]:border-status-amber")}
                        onChange={(v) => setLines((ls) => ls.map((x) => x === l ? { ...x, costText: v } : x))} />
                    </div>
                  </div>
                  {changed && <p className="text-caption text-status-amber">Cost changed from {formatNaira(l.lastCost!)}. A new batch will be created; you'll be asked about selling prices after saving.</p>}
                </div>
              );
            })}
            <Separator />
            <div className="flex justify-between items-baseline">
              <span className="text-subheading">Total cost</span>
              <span className="figure figure-lg">{formatNaira(total)}</span>
            </div>
            <Button size="xl" disabled={busy || lines.length === 0 || problems.length > 0} onClick={() => void save()}>
              {busy ? "Saving…" : "Receive stock"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <PriceReviewDialog lines={priceReview} onClose={() => setPriceReview(null)} onDone={refresh} />
      <CostCorrectionDialog batch={correcting} itemName={correcting ? items.find((i) => i.id === correcting.item_id)?.name ?? "item" : ""} onClose={() => setCorrecting(null)} onDone={refresh} />
    </>
  );
}

/**
 * PRD §6.3: on cost change, ask the owner whether to apply a new selling
 * price to all stock (old + new batches). Cost is untouched either way.
 */
function PriceReviewDialog({ lines, onClose, onDone }: { lines: RestockLine[] | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, { floor: string; suggested: string }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!lines) return;
    setDrafts(Object.fromEntries(lines.map((l) => [l.item.id, { floor: fromKobo(toKobo(l.item.floor_price)), suggested: fromKobo(toKobo(l.item.suggested_price)) }])));
  }, [lines]);
  if (!lines) return null;

  async function apply() {
    setBusy(true);
    try {
      const db = getSupabase();
      let n = 0;
      for (const l of lines!) {
        const d = drafts[l.item.id]!;
        if (!d.floor || !d.suggested) continue; // left blank: keep as is
        if (d.floor === fromKobo(toKobo(l.item.floor_price)) && d.suggested === fromKobo(toKobo(l.item.suggested_price))) continue;
        await setItemPrices(db, { itemId: l.item.id, floorPrice: fromKobo(toKobo(d.floor)), suggestedPrice: fromKobo(toKobo(d.suggested)), reason: `Cost changed ${formatNaira(l.lastCost!)} → ${formatNaira(lineNumbers(l).unitCost!)} on restock` });
        n++;
      }
      notifySuccess(n ? `Selling prices updated for ${n} item(s)` : "Selling prices left unchanged", { description: "Applies to all stock, old and new. Cost prices untouched." });
      onClose();
      await onDone();
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Cost changed — update selling prices?</DialogTitle>
          <DialogDescription>
            The new stock was saved at its new cost. Any selling price you set here applies to all units, old and new, and is logged. Cost prices are never changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {lines.map((l) => {
            const d = drafts[l.item.id] ?? { floor: "", suggested: "" };
            const newCost = lineNumbers(l).unitCost ?? (0 as Kobo);
            const margin = toKobo(d.suggested || "0") - newCost;
            return (
              <div key={l.item.id} className="rounded-[10px] border p-3 grid gap-2">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-semibold">{l.item.name}</span>
                  <span className="text-caption text-muted-foreground">cost {formatNaira(l.lastCost!)} → <b className="text-foreground">{formatNaira(newCost)}</b></span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label className="text-caption text-muted-foreground">Floor (₦)</Label>
                    <NumberField prefix="₦" decimals={2} value={d.floor} onChange={(v) => setDrafts((x) => ({ ...x, [l.item.id]: { ...d, floor: v } }))} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-caption text-muted-foreground">Suggested (₦)</Label>
                    <NumberField prefix="₦" decimals={2} value={d.suggested} onChange={(v) => setDrafts((x) => ({ ...x, [l.item.id]: { ...d, suggested: v } }))} />
                  </div>
                </div>
                <p className={cn("text-caption", margin < 0 ? "text-status-red" : "text-muted-foreground")}>
                  Margin at suggested: {formatNaira(margin as Kobo)}{margin < 0 ? " — selling below the new cost" : ""}
                </p>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Keep prices as they are</Button>
          <Button onClick={() => void apply()} disabled={busy}>{busy ? "Saving…" : "Apply new prices"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
