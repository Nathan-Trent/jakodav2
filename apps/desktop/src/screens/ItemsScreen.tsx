import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { toast } from "sonner";
import type { ItemRow } from "@jakoda/shared";
import { formatNaira, toKobo, type Kobo } from "@jakoda/shared";
import { PageHeader } from "@/components/AppShell";
import { AddItemDialog } from "@/components/AddItemDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, useSession } from "@/lib/session";

/** Catalogue + stock. Costs/values only with items.view_cost. */
export function ItemsScreen() {
  const { active, inventory } = useSession();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [stock, setStock] = useState<Map<string, number>>(new Map());
  const [values, setValues] = useState<Map<string, Kobo>>(new Map());
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const [i, s, v] = await Promise.all([
        inventory.listItems(shop.id),
        inventory.stockQuantities(shop.id),
        viewCost ? inventory.stockOnHand(shop.id) : Promise.resolve([]),
      ]);
      setItems(i);
      setStock(s);
      setValues(new Map(v.map((r) => [r.item_id, toKobo(r.stock_value)])));
    } catch (e) { toast.error(errorMessage(e)); }
  }, [inventory, shop.id, viewCost]);
  useEffect(() => { void load(); }, [load]);

  const filtered = items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHeader title="Items" description={`${items.length} ${items.length === 1 ? "item" : "items"} in ${shop.name}`}
        actions={perms.includes("items.create") && <Button onClick={() => setShowAdd(true)}><IconPlus size={16} /> Add item</Button>} />
      <div className="px-8 pb-8 grid gap-4">
        <div className="relative max-w-sm">
          <IconSearch size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Item</TableHead>
                <TableHead className="text-right">Floor</TableHead>
                <TableHead className="text-right">Suggested</TableHead>
                <TableHead className="text-right">In stock</TableHead>
                {viewCost && <TableHead className="text-right">Avg cost</TableHead>}
                {viewCost && <TableHead className="text-right pr-5">Stock value</TableHead>}
                {!viewCost && <TableHead className="pr-5"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={6} className="pl-5 text-muted-foreground">{items.length === 0 ? "No items yet." : "No matches."}</TableCell></TableRow>
              )}
              {filtered.map((it) => {
                const onHand = stock.get(it.id) ?? 0;
                const value = values.get(it.id);
                const avg = value !== undefined && onHand > 0 ? (Math.round(value / onHand) as Kobo) : undefined;
                return (
                  <TableRow key={it.id}>
                    <TableCell className="pl-5 font-semibold">{it.name}</TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">{formatNaira(toKobo(it.floor_price))}</TableCell>
                    <TableCell className="text-right tabular font-semibold">{formatNaira(toKobo(it.suggested_price))}</TableCell>
                    <TableCell className="text-right tabular">
                      {onHand === 0 ? <Badge variant="critical">Out</Badge> : onHand <= 2 ? <Badge variant="warning">{onHand} left</Badge> : onHand}
                    </TableCell>
                    {viewCost && <TableCell className="text-right tabular text-muted-foreground">{avg !== undefined ? formatNaira(avg) : "—"}</TableCell>}
                    {viewCost && <TableCell className="text-right tabular pr-5">{value !== undefined ? formatNaira(value) : "—"}</TableCell>}
                    {!viewCost && <TableCell className="pr-5" />}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>
      <AddItemDialog open={showAdd} onOpenChange={setShowAdd} onDone={async (name) => { setShowAdd(false); toast.success(`Added “${name}”`); await load(); }} />
    </>
  );
}
