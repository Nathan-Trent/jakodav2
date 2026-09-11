import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconBarcode, IconPencil, IconTrash, IconTruckDelivery } from "@tabler/icons-react";
import type { BatchRow, ItemRow } from "@zogal/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@zogal/shared";
import { announceStockChange, lookupBarcode, setItemPrices, stockChannel } from "@zogal/inventory-batches";
import { PageHeader } from "@/components/AppShell";
import { CostCorrectionDialog } from "@/components/CostCorrectionDialog";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notifyError, notifyInfo, notifySuccess } from "@/lib/feedback";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";
import { cn } from "@/lib/utils";

interface RestockLine {
  item: ItemRow;
  quantity: number;
  unitCost: Kobo;
  /** Cost of the newest existing batch, for change detection (PRD §6.3). */
  lastCost: Kobo | null;
}

/**
 * Restock: scan or pick items, enter quantity + cost. Every line becomes a
 * new immutable batch — a different cost NEVER edits an old batch (PRD §6.3).
 * After saving, if any cost changed vs the last batch, the owner is asked
 * whether to update that item's selling prices — a deliberate, logged step.
 */
export function PurchasesScreen() {
  const { active, inventory, device } = useSession();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");

  const [items, setItems] = useState<ItemRow[]>([]);
  const [latestBatch, setLatestBatch] = useState<Map<string, BatchRow>>(new Map());
  const [recent, setRecent] = useState<BatchRow[]>([]);
  const [lines, setLines] = useState<RestockLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [priceReview, setPriceReview] = useState<RestockLine[] | null>(null);
  const [correcting, setCorrecting] = useState<BatchRow | null>(null);
  const canCorrect = perms.includes("purchases.correct_cost");
  const channelRef = useRef<ReturnType<typeof stockChannel> | null>(null);

  const load = useCallback(async () => {
    try {
      const db = getSupabase();
      const [i, b] = await Promise.all([
        inventory.listItems(shop.id),
        viewCost
          ? db.from("batches").select<"*", BatchRow>().eq("shop_id", shop.id).order("purchased_at", { ascending: false }).limit(200).then((r) => { if (r.error) throw r.error; return r.data; })
          : Promise.resolve([] as BatchRow[]),
      ]);
      setItems(i);
      setRecent(b.slice(0, 25));
      const latest = new Map<string, BatchRow>();
      for (const row of b) if (!latest.has(row.item_id)) latest.set(row.item_id, row);
      setLatestBatch(latest);
    } catch (e) { notifyError(e); }
  }, [inventory, shop.id, viewCost]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const db = getSupabase();
    const ch = stockChannel(db, shop.id);
    ch.subscribe();
    channelRef.current = ch;
    return () => { void db.removeChannel(ch); channelRef.current = null; };
  }, [shop.id]);

  function addLine(item: ItemRow) {
    setLines((ls) => {
      if (ls.some((l) => l.item.id === item.id)) return ls.map((l) => (l.item.id === item.id ? { ...l, quantity: l.quantity + 1 } : l));
      const last = latestBatch.get(item.id);
      const lastCost = last ? toKobo(last.unit_cost) : null;
      return [...ls, { item, quantity: 1, unitCost: lastCost ?? (0 as Kobo), lastCost }];
    });
  }

  useBarcodeScanner(async (code) => {
    try {
      const hit = await lookupBarcode(getSupabase(), shop.id, code);
      const item = hit && items.find((i) => i.id === hit.item_id);
      if (!item) { notifyInfo("Barcode not recognised", `${code} isn't attached to any item here.`); return; }
      addLine(item);
    } catch (e) { notifyError(e); }
  }, { enabled: !priceReview });

  const total = useMemo(() => addKobo(...lines.map((l) => mulKobo(l.unitCost, l.quantity))), [lines]);
  const problems = lines.filter((l) => l.quantity < 1 || l.unitCost < 0);
  const filtered = items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12);

  async function save() {
    if (lines.length === 0 || problems.length) return;
    setBusy(true);
    try {
      await inventory.recordPurchase({
        shopId: shop.id,
        supplierName: supplier.trim() || undefined,
        lines: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, unitCost: fromKobo(l.unitCost) })),
      });
      notifySuccess("Stock received", { description: `${lines.reduce((s, l) => s + l.quantity, 0)} units across ${lines.length} item(s) — each at its own batch cost.` });
      if (channelRef.current) void announceStockChange(channelRef.current, device?.device_id ?? null);
      const changed = lines.filter((l) => l.lastCost !== null && l.lastCost !== l.unitCost);
      setLines([]);
      setSupplier("");
      await load();
      if (changed.length && perms.includes("items.edit")) setPriceReview(changed);
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Purchases" description="Receive stock. Each line becomes a new batch at its own cost — old batches are never changed." />
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
              <div className="px-5 pt-4 pb-2 text-title">Recent batches</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Received</TableHead>
                    <TableHead>Item</TableHead>
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
              const changed = l.lastCost !== null && l.lastCost !== l.unitCost;
              return (
                <div key={l.item.id} className="rounded-[10px] border p-3 grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold truncate">{l.item.name}</span>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Remove" onClick={() => setLines((ls) => ls.filter((x) => x !== l))}><IconTrash size={14} /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <Label className="text-caption text-muted-foreground">Quantity</Label>
                      <Input type="number" min={1} value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => x === l ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x))} />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-caption text-muted-foreground">Cost per unit (₦)</Label>
                      <Input type="number" min={0} step="0.01" value={fromKobo(l.unitCost)}
                        className={cn(changed && "border-status-amber")}
                        onChange={(e) => { try { setLines((ls) => ls.map((x) => x === l ? { ...x, unitCost: toKobo(e.target.value || "0") } : x)); } catch { /* partial input */ } }} />
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

      <PriceReviewDialog lines={priceReview} onClose={() => setPriceReview(null)} onDone={load} />
      <CostCorrectionDialog batch={correcting} itemName={correcting ? items.find((i) => i.id === correcting.item_id)?.name ?? "item" : ""} onClose={() => setCorrecting(null)} onDone={load} />
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
        if (d.floor === fromKobo(toKobo(l.item.floor_price)) && d.suggested === fromKobo(toKobo(l.item.suggested_price))) continue;
        await setItemPrices(db, { itemId: l.item.id, floorPrice: fromKobo(toKobo(d.floor)), suggestedPrice: fromKobo(toKobo(d.suggested)), reason: `Cost changed ${formatNaira(l.lastCost!)} → ${formatNaira(l.unitCost)} on restock` });
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
            const margin = toKobo(d.suggested || "0") - l.unitCost;
            return (
              <div key={l.item.id} className="rounded-[10px] border p-3 grid gap-2">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-semibold">{l.item.name}</span>
                  <span className="text-caption text-muted-foreground">cost {formatNaira(l.lastCost!)} → <b className="text-foreground">{formatNaira(l.unitCost)}</b></span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label className="text-caption text-muted-foreground">Floor (₦)</Label>
                    <Input type="number" min={0} step="0.01" value={d.floor} onChange={(e) => setDrafts((x) => ({ ...x, [l.item.id]: { ...d, floor: e.target.value } }))} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-caption text-muted-foreground">Suggested (₦)</Label>
                    <Input type="number" min={0} step="0.01" value={d.suggested} onChange={(e) => setDrafts((x) => ({ ...x, [l.item.id]: { ...d, suggested: e.target.value } }))} />
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
