import { useCallback, useEffect, useMemo, useState } from "react";
import { IconTrash, IconTruckDelivery } from "@tabler/icons-react";
import type { ItemRow } from "@zogal/shared";
import { addKobo, formatNaira, fromKobo, mulKobo, toKobo, type Kobo } from "@zogal/shared";
import { InventoryRepository } from "@zogal/inventory-batches";
import { Alert, Button, Card, CardContent, Input, Label, NumberField, PurchaseScanReview, ScanPagesButton, Separator, notifyError, notifySuccess } from "@zogal/ui";
import { Page, PageHeader } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useDocumentScan } from "@/lib/documentScan";

interface Line { item: ItemRow; qtyText: string; costText: string }
const nums = (l: Line) => {
  const q = l.qtyText === "" ? null : Math.floor(Number(l.qtyText));
  let c: Kobo | null = null; try { c = l.costText === "" ? null : toKobo(l.costText); } catch { c = null; }
  return { quantity: q !== null && q > 0 ? q : null, unitCost: c };
};

/**
 * Receive stock from the web dashboard (0029). Same rules as the terminal:
 * each line is a new immutable batch at its own cost. Built so a supplier
 * invoice can be photographed on a phone and become the delivery's lines.
 */
export function PurchasesScreen() {
  const { active } = useSession();
  const shop = active!.shop;
  const inventory = useMemo(() => new InventoryRepository(getSupabase()), []);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [supplier, setSupplier] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const scan = useDocumentScan("purchase");

  const load = useCallback(async () => {
    try { setItems((await inventory.listItems(shop.id)).filter((i) => i.is_active)); } catch (e) { notifyError(e); }
  }, [inventory, shop.id]);
  useEffect(() => { void load(); }, [load]);

  const filtered = items.filter((i) => q.trim() && i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  function addLine(item: ItemRow, qty = 1, cost = "") {
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.item.id === item.id);
      if (idx >= 0) return ls.map((l, i) => (i === idx ? { ...l, qtyText: String((nums(l).quantity ?? 0) + qty), costText: cost || l.costText } : l));
      return [...ls, { item, qtyText: String(qty), costText: cost }];
    });
    setQ("");
  }
  const total = addKobo(...lines.map((l) => { const n = nums(l); return n.quantity && n.unitCost !== null ? mulKobo(n.unitCost, n.quantity) : (0 as Kobo); }));
  const problems = lines.filter((l) => { const n = nums(l); return n.quantity === null || n.unitCost === null; });

  async function save() {
    if (lines.length === 0 || problems.length) return;
    setBusy(true);
    try {
      await inventory.recordPurchase({
        shopId: shop.id, deviceId: null, supplierName: supplier.trim() || undefined,
        lines: lines.map((l) => { const n = nums(l); return { itemId: l.item.id, quantity: n.quantity!, unitCost: fromKobo(n.unitCost!) }; }),
      });
      notifySuccess("Stock received", { description: `${lines.reduce((s, l) => s + (nums(l).quantity ?? 0), 0)} units across ${lines.length} item(s). Terminals see it at their next sync.` });
      setLines([]); setSupplier("");
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Add stock" description="Each line becomes a new batch at its own cost — old batches are never changed."
        actions={<ScanPagesButton label="Scan an invoice" parse={scan.parse} onPages={(ps) => scan.setPages((cur) => [...cur, ...ps])} disabled={!scan.enabled} disabledReason={scan.disabledReason} quota={scan.quota} />} />
      <Page>
        {items.length === 0 && <Alert tone="info" title="No items yet">Add items first — under Items, or by scanning your stock book.</Alert>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="py-5"><CardContent className="px-5 grid gap-3">
            <div className="grid gap-1">
              <Label className="text-caption text-muted-foreground">Find an item</Label>
              <Input placeholder="Type a name" value={q} onChange={(e) => setQ(e.target.value)} />
              {filtered.length > 0 && (
                <ul className="rounded-[10px] border divide-y">
                  {filtered.map((i) => <li key={i.id}><button type="button" className="w-full text-left px-3 py-2 hover:bg-muted text-small" onClick={() => addLine(i)}>{i.name}</button></li>)}
                </ul>
              )}
            </div>
            {lines.length === 0 ? (
              <p className="text-small text-muted-foreground flex items-center gap-2"><IconTruckDelivery size={16} /> Find an item above, or scan the supplier's invoice.</p>
            ) : lines.map((l) => (
              <div key={l.item.id} className="rounded-[10px] border p-3 grid gap-2">
                <div className="flex justify-between gap-2"><span className="font-medium truncate">{l.item.name}</span>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Remove" onClick={() => setLines((ls) => ls.filter((x) => x !== l))}><IconTrash size={14} /></Button></div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1"><Label className="text-caption text-muted-foreground">Qty</Label><NumberField decimals={0} min={1} value={l.qtyText} onChange={(v) => setLines((ls) => ls.map((x) => (x === l ? { ...x, qtyText: v } : x)))} /></div>
                  <div className="grid gap-1"><Label className="text-caption text-muted-foreground">Cost each</Label><NumberField prefix="₦" decimals={2} value={l.costText} onChange={(v) => setLines((ls) => ls.map((x) => (x === l ? { ...x, costText: v } : x)))} /></div>
                </div>
              </div>
            ))}
          </CardContent></Card>
          <Card className="py-5 h-fit"><CardContent className="px-5 grid gap-3">
            <div className="grid gap-1"><Label htmlFor="w-supplier" className="text-caption text-muted-foreground">Supplier (optional)</Label><Input id="w-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={200} /></div>
            <Separator />
            <div className="flex justify-between items-baseline"><span className="text-subheading">Total cost</span><span className="figure figure-lg">{formatNaira(total)}</span></div>
            {problems.length > 0 && <p className="text-small text-destructive">Every line needs a quantity and a cost.</p>}
            <Button size="lg" disabled={busy || lines.length === 0 || problems.length > 0} onClick={() => void save()}>{busy ? "Saving…" : "Save delivery"}</Button>
          </CardContent></Card>
        </div>
      </Page>

      <PurchaseScanReview open={scan.pages.length > 0} pages={scan.results} items={items} onClose={() => void scan.finish("discarded")}
        onCreateItem={async (input) => { const it = await inventory.createItem({ shopId: shop.id, name: input.name, floorPrice: input.floorPrice, suggestedPrice: input.suggestedPrice }); await load(); return it; }}
        onConfirm={(scanned, meta) => {
          const byId = new Map(items.map((i) => [i.id, i]));
          for (const s of scanned) { const it = byId.get(s.itemId); if (it) addLine(it, s.quantity, s.unitCost); }
          if (meta.supplier && !supplier) setSupplier(meta.supplier);
          void scan.finish("confirmed");
          notifySuccess(`${scanned.length} line${scanned.length === 1 ? "" : "s"} added from the page`, { description: "Check them, then save the delivery." });
        }} />
    </>
  );
}
