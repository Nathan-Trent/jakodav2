import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import type { ItemRow } from "@zogal/shared";
import { formatNaira, fromKobo, toKobo } from "@zogal/shared";
import { InventoryRepository, addManufacturerBarcode } from "@zogal/inventory-batches";
import { Alert, Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, ItemsScanReview, Label, NumberField, ScanPagesButton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifySuccess, type ItemsReviewResult } from "@zogal/ui";
import { Page, PageHeader } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useDocumentScan } from "@/lib/documentScan";

/**
 * Items on the web dashboard (0029). Built for onboarding from a phone: the
 * owner photographs the stock ledger page by page and the shop's catalogue
 * appears, with opening stock. Adding one item by hand is here too. Costs
 * and stock values only with items.view_cost; everyday selling stays on
 * the terminals.
 */
export function ItemsScreen() {
  const { active, ctx } = useSession();
  const shop = active!.shop;
  const perms = active!.permissions;
  const canAdd = perms.includes("items.create");
  const canPurchase = perms.includes("purchases.create");
  const viewCost = perms.includes("items.view_cost");
  const inventory = useMemo(() => new InventoryRepository(getSupabase()), []);

  const [items, setItems] = useState<ItemRow[]>([]);
  const [stock, setStock] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const scan = useDocumentScan("items");

  const load = useCallback(async () => {
    try {
      const [list, qty] = await Promise.all([inventory.listItems(shop.id), inventory.stockQuantities(shop.id)]);
      setItems(list); setStock(qty);
    } catch (e) { notifyError(e); } finally { setLoading(false); }
  }, [inventory, shop.id]);
  useEffect(() => { void load(); }, [load]);

  // SYNC: the database tells us — a terminal adding an item shows up here without a refresh.
  useEffect(() => {
    const db = getSupabase();
    const ch = db.channel(`items:${shop.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `shop_id=eq.${shop.id}` }, () => void load())
      .subscribe();
    return () => { void db.removeChannel(ch); };
  }, [shop.id, load]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return items.filter((i) => i.is_active && (!n || i.name.toLowerCase().includes(n)));
  }, [items, q]);

  async function addScanned(rows: ItemsReviewResult[]) {
    const created: string[] = [];
    const stockLines: { itemId: string; quantity: number; unitCost: string }[] = [];
    let failed = 0;
    for (const r of rows) {
      try {
        const id = r.existingItemId ?? (await inventory.createItem({ shopId: shop.id, name: r.name, floorPrice: r.floorPrice, suggestedPrice: r.suggestedPrice })).id;
        if (!r.existingItemId) created.push(id);
        if (canPurchase && r.quantity > 0) stockLines.push({ itemId: id, quantity: r.quantity, unitCost: r.unitCost });
      } catch (e) { failed++; notifyError(e, `Couldn't add “${r.name}”`); }
    }
    if (stockLines.length) {
      try { const { purchase } = await inventory.recordPurchase({ shopId: shop.id, deviceId: null, note: "Opening stock (from scanned ledger)", lines: stockLines }); created.push(purchase.id); }
      catch (e) { notifyError(e, "Items were added but the opening stock wasn't"); }
    }
    await scan.finish("confirmed", created);
    notifySuccess(`Added ${rows.length - failed} item${rows.length - failed === 1 ? "" : "s"} from the page${stockLines.length ? " with opening stock" : ""}`);
    await load();
  }

  return (
    <>
      <PageHeader title="Items" description={`${items.filter((i) => i.is_active).length} in ${shop.name}. Setting up? Photograph your stock book page by page.`}
        actions={canAdd && <>
          <ScanPagesButton label="Scan a stock page" parse={scan.parse} onPages={(ps) => scan.setPages((cur) => [...cur, ...ps])} disabled={!scan.enabled} disabledReason={scan.disabledReason} quota={scan.quota} />
          <Button onClick={() => setShowAdd(true)}><IconPlus size={16} /> Add item</Button>
        </>} />
      <Page>
        {!loading && items.length === 0 && (
          <Alert tone="info" title="No items yet">
            {canAdd ? "Fastest way in: scan the pages of your stock book. Every product on them becomes an item, with its stock. Or add items one at a time." : "Ask the shop owner to add items."}
          </Alert>
        )}
        <Card className="py-0">
          <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-title">{shown.length} {shown.length === 1 ? "item" : "items"}</div>
            <label className="relative"><IconSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 pl-8 w-[220px]" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="pl-5">Item</TableHead><TableHead className="text-right">In stock</TableHead><TableHead className="text-right">Floor</TableHead><TableHead className="text-right pr-5">Selling</TableHead></TableRow></TableHeader>
              <TableBody>
                {shown.map((it) => {
                  const on = stock.get(it.id) ?? 0;
                  return (
                    <TableRow key={it.id}>
                      <TableCell className="pl-5 font-semibold">{it.name}</TableCell>
                      <TableCell className="text-right tabular">{on}{on === 0 && <Badge variant="warning" className="ml-2">out</Badge>}</TableCell>
                      <TableCell className="text-right tabular">{formatNaira(toKobo(it.floor_price))}</TableCell>
                      <TableCell className="text-right tabular pr-5">{formatNaira(toKobo(it.suggested_price))}</TableCell>
                    </TableRow>
                  );
                })}
                {!loading && shown.length === 0 && items.length > 0 && <TableRow><TableCell colSpan={4} className="pl-5 text-muted-foreground">No item matches “{q}”.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </Card>
        {!viewCost && <p className="text-caption text-muted-foreground">Cost prices and stock value are shown to people with the “See cost prices” permission.</p>}
      </Page>

      <ItemsScanReview open={scan.pages.length > 0} pages={scan.results} existingItems={items} onClose={() => void scan.finish("discarded")} onConfirm={addScanned} />
      {showAdd && <AddItemDialog inventory={inventory} shopId={shop.id} canPurchase={canPurchase} userId={ctx!.user!.id} onClose={() => setShowAdd(false)} onDone={async (name) => { setShowAdd(false); notifySuccess(`Added “${name}”`); await load(); }} />}
    </>
  );
}

function AddItemDialog({ inventory, shopId, canPurchase, onClose, onDone }: { inventory: InventoryRepository; shopId: string; canPurchase: boolean; userId: string; onClose: () => void; onDone: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [floor, setFloor] = useState("");
  const [suggested, setSuggested] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [barcode, setBarcode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const item = await inventory.createItem({ shopId, name, floorPrice: fromKobo(toKobo(floor)), suggestedPrice: fromKobo(toKobo(suggested)) });
      if (barcode.trim()) { try { await addManufacturerBarcode(getSupabase(), shopId, item.id, barcode.trim()); } catch (err) { notifyError(err, "Item saved, but the barcode wasn't attached"); } }
      if (canPurchase && Number(qty) > 0) {
        await inventory.recordPurchase({ shopId, deviceId: null, note: "Initial stock", lines: [{ itemId: item.id, quantity: Number(qty), unitCost: fromKobo(toKobo(cost || "0")) }] });
      }
      await onDone(item.name);
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New item</DialogTitle><DialogDescription>Selling prices are editable later; the initial cost becomes a frozen batch.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="w-name">Name</Label><Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2"><Label>Floor price (₦)</Label><NumberField prefix="₦" decimals={2} value={floor} onChange={setFloor} required /></div>
            <div className="grid gap-2"><Label>Suggested price (₦)</Label><NumberField prefix="₦" decimals={2} value={suggested} onChange={setSuggested} required /></div>
          </div>
          {canPurchase && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2"><Label>Initial quantity</Label><NumberField decimals={0} value={qty} onChange={setQty} /></div>
              <div className="grid gap-2"><Label>Cost per unit (₦)</Label><NumberField prefix="₦" decimals={2} value={cost} onChange={setCost} /></div>
            </div>
          )}
          <div className="grid gap-2"><Label htmlFor="w-code">Barcode on the pack <span className="text-muted-foreground font-normal">(optional)</span></Label><Input id="w-code" className="font-mono" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Type the number under the barcode" /></div>
          <Button disabled={busy} className="justify-self-end">{busy ? "Saving…" : "Save item"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
