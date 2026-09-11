import { useState } from "react";
import { IconBarcode, IconPackageImport, IconPlus, IconSearch } from "@tabler/icons-react";
import type { ItemRow } from "@zogal/shared";
import { formatNaira, toKobo, type Kobo } from "@zogal/shared";
import { StaleNotice } from "@/components/StaleNotice";
import { useShopData } from "@/lib/shopData";
import { PageHeader } from "@/components/AppShell";
import { AddItemDialog } from "@/components/AddItemDialog";
import { ItemDialog } from "@/components/ItemDialog";
import { AddStockDialog } from "@/components/AddStockDialog";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { notifySuccess } from "@/lib/feedback";

/** Catalogue + stock. Costs/values only with items.view_cost. */
export function ItemsScreen() {
  const { active } = useSession();
  const { data, loading, refresh, stockFor, costPerUnit } = useShopData();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<ItemRow | null>(null);
  const [restocking, setRestocking] = useState<ItemRow | null>(null);
  const canRestock = perms.includes("purchases.create");

  const items = data.items;
  const codesByItem = new Map<string, string[]>();
  for (const b of data.barcodes) codesByItem.set(b.item_id, [...(codesByItem.get(b.item_id) ?? []), b.code]);

  const filtered = items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHeader title="Items" description={`${items.length} ${items.length === 1 ? "item" : "items"} in ${shop.name} · click an item for barcodes and prices`}
        actions={perms.includes("items.create") && <Button onClick={() => setShowAdd(true)}><IconPlus size={16} /> Add item</Button>} />
      <div className="px-8 pb-8 grid gap-4">
        <StaleNotice />
        <div className="relative max-w-sm">
          <IconSearch size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {items.length > 0 && items.some((i) => (codesByItem.get(i.id)?.length ?? 0) === 0) && perms.includes("items.create") && (
          <Alert tone="info" title={`${items.filter((i) => (codesByItem.get(i.id)?.length ?? 0) === 0).length} item(s) have no barcode`}>
            Click an item to generate one and print a label — scanning at the till is faster than tapping.
          </Alert>
        )}
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Item</TableHead>
                <TableHead>Barcode</TableHead>
                <TableHead className="text-right">Floor</TableHead>
                <TableHead className="text-right">Suggested</TableHead>
                <TableHead className="text-right">In stock</TableHead>
                {viewCost && <TableHead className="text-right">Avg cost</TableHead>}
                {viewCost && <TableHead className="text-right">Stock value</TableHead>}
                <TableHead className="pr-5"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={8} className="pl-5 text-muted-foreground">{loading ? "Loading…" : items.length === 0 ? "No items yet." : "No matches."}</TableCell></TableRow>
              )}
              {filtered.map((it) => {
                const onHand = stockFor(it.id);
                const avg = costPerUnit(it.id);
                const value = avg !== undefined ? ((avg * onHand) as Kobo) : undefined;
                return (
                  <TableRow key={it.id} className="cursor-pointer" onClick={() => setSelected(it)}>
                    <TableCell className="pl-5 font-semibold">{it.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {(codesByItem.get(it.id)?.length ?? 0) === 0
                        ? <Badge variant="warning"><IconBarcode size={12} /> None</Badge>
                        : <span className="font-mono text-caption">{codesByItem.get(it.id)![0]}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">{formatNaira(toKobo(it.floor_price))}</TableCell>
                    <TableCell className="text-right tabular font-semibold">{formatNaira(toKobo(it.suggested_price))}</TableCell>
                    <TableCell className="text-right tabular">
                      {onHand === 0 ? <Badge variant="critical">Out</Badge> : onHand <= 2 ? <Badge variant="warning">{onHand} left</Badge> : onHand}
                    </TableCell>
                    {viewCost && <TableCell className="text-right tabular text-muted-foreground">{avg !== undefined ? formatNaira(avg) : "—"}</TableCell>}
                    {viewCost && <TableCell className="text-right tabular">{value !== undefined ? formatNaira(value) : "—"}</TableCell>}
                    <TableCell className="pr-5 text-right">
                      {canRestock && (
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setRestocking(it); }} title="Receive more of this item">
                          <IconPackageImport size={14} /> Add stock
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>
      <ItemDialog item={selected} onOpenChange={(o) => !o && setSelected(null)} onChanged={refresh} />
      <AddStockDialog item={restocking} onClose={() => setRestocking(null)} onDone={refresh} />
      <AddItemDialog open={showAdd} onOpenChange={setShowAdd} onDone={async (name) => { setShowAdd(false); notifySuccess(`Added “${name}”`); await refresh(); }} />
    </>
  );
}
