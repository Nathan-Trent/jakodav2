import { useState } from "react";
import { IconDownload } from "@tabler/icons-react";
import { formatNaira, type Kobo } from "@zogal/shared";
import { fetchShopReport, type ShopReport } from "@zogal/inventory-batches";
import { Alert, Button, Card, CardContent, PeriodPicker, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, describeRange, resolvePreset, type PeriodRange } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useAsync, money } from "@/lib/useAsync";

const k = (v: number | string | null | undefined): Kobo => Math.round(money(v) * 100) as Kobo;
type Tab = "items" | "sellers" | "terminals" | "customers" | "expenses";

/** Reports (PRD §6.7 reporting): what sold, who sold it, where, and what it cost — for any period. */
export function ReportsScreen() {
  const { active } = useSession();
  const shop = active!.shop;
  const viewCost = active!.permissions.includes("items.view_cost");
  const [period, setPeriod] = useState<PeriodRange>(() => resolvePreset("this_month"));
  const [tab, setTab] = useState<Tab>("items");
  const rep = useAsync(() => fetchShopReport(getSupabase(), shop.id, period.from, period.to), [shop.id, period.from, period.to]);
  const r = rep.data;

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: "items", label: "Items", show: true },
    { key: "sellers", label: "Sellers", show: active!.permissions.includes("reports.view_staff_perf") },
    { key: "terminals", label: "Terminals", show: true },
    { key: "customers", label: "Customers", show: true },
    { key: "expenses", label: "Expenses", show: viewCost },
  ];

  return (
    <>
      <PageHeader title="Reports" description={`${shop.name} · ${describeRange(period)}`}
        actions={<><PeriodPicker value={period} onChange={setPeriod} />{r && <Button variant="outline" onClick={() => downloadCsv(r, tab, shop.name)}><IconDownload size={16} /> CSV</Button>}</>} />
      <Page>
        {rep.error && <Alert tone="warning" title="Couldn't load the report">{rep.error}</Alert>}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Tile label="Revenue" value={formatNaira(k(r?.totals.revenue))} sub={`${r?.totals.sales_count ?? 0} sales · ${r?.totals.units ?? 0} units`} primary />
          {viewCost && <Tile label="Gross profit" value={formatNaira(k(r?.totals.gross_profit))} sub={r ? `${money(r.totals.revenue) > 0 ? Math.round((money(r.totals.gross_profit) / money(r.totals.revenue)) * 100) : 0}% margin` : ""} />}
          {viewCost && <Tile label="Expenses" value={formatNaira(k(r?.totals.expenses))} />}
          {viewCost && <Tile label="Net profit" value={formatNaira((k(r?.totals.gross_profit) - k(r?.totals.expenses)) as Kobo)} sub="Gross profit minus expenses" />}
        </div>
        <Card className="py-0">
          <div className="px-5 pt-3 flex gap-1 border-b overflow-x-auto">
            {tabs.filter((t) => t.show).map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={`px-3 py-2 text-small font-semibold border-b-2 -mb-px whitespace-nowrap ${tab === t.key ? "border-brand-action text-foreground" : "border-transparent text-muted-foreground"}`}>{t.label}</button>
            ))}
          </div>
          <div className="overflow-x-auto">
            {!r ? <p className="px-5 py-4 text-small text-muted-foreground">{rep.loading ? "Loading…" : "No data."}</p> : (
              tab === "items" ? (
                <Table><TableHeader><TableRow><TableHead className="pl-5">Item</TableHead><TableHead className="text-right">Units</TableHead><TableHead className="text-right">Revenue</TableHead>{viewCost && <TableHead className="text-right">Profit</TableHead>}<TableHead className="text-right pr-5">On hand</TableHead></TableRow></TableHeader>
                  <TableBody>{r.by_item.length === 0 && <Empty cols={5} />}{r.by_item.map((x) => (
                    <TableRow key={x.item_id}><TableCell className="pl-5 font-semibold">{x.name}</TableCell><TableCell className="text-right tabular">{x.units}</TableCell><TableCell className="text-right tabular font-semibold">{formatNaira(k(x.revenue))}</TableCell>{viewCost && <TableCell className={`text-right tabular ${money(x.gross_profit) < 0 ? "text-status-red" : ""}`}>{formatNaira(k(x.gross_profit))}</TableCell>}<TableCell className={`text-right pr-5 tabular ${x.on_hand <= 2 ? "text-status-amber" : "text-muted-foreground"}`}>{x.on_hand}</TableCell></TableRow>
                  ))}</TableBody></Table>
              ) : tab === "sellers" ? (
                <Table><TableHeader><TableRow><TableHead className="pl-5">Seller</TableHead><TableHead className="text-right">Sales</TableHead><TableHead className="text-right">Units</TableHead><TableHead className="text-right">Revenue</TableHead>{viewCost && <TableHead className="text-right pr-5">Profit</TableHead>}</TableRow></TableHeader>
                  <TableBody>{r.by_seller.length === 0 && <Empty cols={5} />}{r.by_seller.map((x) => (
                    <TableRow key={x.user_id}><TableCell className="pl-5 font-semibold">{x.name}</TableCell><TableCell className="text-right tabular">{x.sales_count}</TableCell><TableCell className="text-right tabular">{x.units}</TableCell><TableCell className="text-right tabular font-semibold">{formatNaira(k(x.revenue))}</TableCell>{viewCost && <TableCell className="text-right pr-5 tabular">{formatNaira(k(x.gross_profit))}</TableCell>}</TableRow>
                  ))}</TableBody></Table>
              ) : tab === "terminals" ? (
                <Table><TableHeader><TableRow><TableHead className="pl-5">Terminal</TableHead><TableHead className="text-right">Sales</TableHead><TableHead className="text-right pr-5">Revenue</TableHead></TableRow></TableHeader>
                  <TableBody>{r.by_terminal.length === 0 && <Empty cols={3} />}{r.by_terminal.map((x) => (
                    <TableRow key={x.device_id}><TableCell className="pl-5 font-semibold">{x.name}</TableCell><TableCell className="text-right tabular">{x.sales_count}</TableCell><TableCell className="text-right pr-5 tabular font-semibold">{formatNaira(k(x.revenue))}</TableCell></TableRow>
                  ))}</TableBody></Table>
              ) : tab === "customers" ? (
                <Table><TableHeader><TableRow><TableHead className="pl-5">Customer</TableHead><TableHead className="text-right">Sales</TableHead><TableHead className="text-right pr-5">Revenue</TableHead></TableRow></TableHeader>
                  <TableBody>{r.by_customer.length === 0 && <Empty cols={3} text="No sales were attached to a customer in this period." />}{r.by_customer.map((x) => (
                    <TableRow key={x.customer_id}><TableCell className="pl-5 font-semibold">{x.name}</TableCell><TableCell className="text-right tabular">{x.sales_count}</TableCell><TableCell className="text-right pr-5 tabular font-semibold">{formatNaira(k(x.revenue))}</TableCell></TableRow>
                  ))}</TableBody></Table>
              ) : (
                <Table><TableHeader><TableRow><TableHead className="pl-5">Category</TableHead><TableHead className="text-right pr-5">Amount</TableHead></TableRow></TableHeader>
                  <TableBody>{r.expenses_by_category.length === 0 && <Empty cols={2} />}{r.expenses_by_category.map((x) => (
                    <TableRow key={x.category}><TableCell className="pl-5 font-semibold capitalize">{x.category}</TableCell><TableCell className="text-right pr-5 tabular font-semibold">{formatNaira(k(x.amount))}</TableCell></TableRow>
                  ))}</TableBody></Table>
              )
            )}
          </div>
        </Card>
      </Page>
    </>
  );
}

function Empty({ cols, text = "Nothing in this period." }: { cols: number; text?: string }) {
  return <TableRow><TableCell colSpan={cols} className="pl-5 text-muted-foreground">{text}</TableCell></TableRow>;
}

function Tile({ label, value, sub, primary }: { label: string; value: string; sub?: string; primary?: boolean }) {
  return (
    <Card className={`py-5 gap-0 ${primary ? "bg-brand-forest text-white border-transparent" : ""}`}>
      <CardContent className="px-5 grid gap-1">
        <div className={`text-micro ${primary ? "text-white/60" : "text-muted-foreground"}`}>{label}</div>
        <div className="figure figure-lg">{value}</div>
        {sub && <div className={`text-caption ${primary ? "text-white/60" : "text-muted-foreground"}`}>{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** Plain CSV of the visible table — the owner's accountant asks for this. */
function downloadCsv(r: ShopReport, tab: Tab, shopName: string) {
  const rows: (string | number)[][] =
    tab === "items" ? [["Item", "Units", "Revenue", "Gross profit", "On hand"], ...r.by_item.map((x) => [x.name, x.units, money(x.revenue), money(x.gross_profit), x.on_hand])]
    : tab === "sellers" ? [["Seller", "Sales", "Units", "Revenue", "Gross profit"], ...r.by_seller.map((x) => [x.name, x.sales_count, x.units, money(x.revenue), money(x.gross_profit)])]
    : tab === "terminals" ? [["Terminal", "Sales", "Revenue"], ...r.by_terminal.map((x) => [x.name, x.sales_count, money(x.revenue)])]
    : tab === "customers" ? [["Customer", "Sales", "Revenue"], ...r.by_customer.map((x) => [x.name, x.sales_count, money(x.revenue)])]
    : [["Category", "Amount"], ...r.expenses_by_category.map((x) => [x.category, money(x.amount)])];
  const csv = rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${shopName} ${tab} ${r.from} to ${r.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
