import { useEffect, useMemo, useState } from "react";
import { IconCloudUpload, IconSearch } from "@tabler/icons-react";
import { formatNaira, toKobo, type Kobo } from "@zogal/shared";
import { fetchSalesHistory, summariseLines, type SaleHistoryRow } from "@zogal/inventory-batches";
import { cacheKey, readThrough } from "@zogal/sync";
import { PageHeader } from "@/components/AppShell";
import { StaleNotice } from "@/components/StaleNotice";
import { TerminalFilter, useTerminalName } from "@/components/TerminalFilter";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeRange, resolvePreset, type PeriodRange } from "@/lib/periods";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import { getSupabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/** One sale as this screen shows it — server or still on this terminal. */
export interface SaleView {
  id: string;
  sold_at: string;
  total: Kobo;
  seller: string | null;
  seller_id: string | null;
  device_id: string | null;
  customer_id: string | null;
  customer: string | null;
  note: string | null;
  lines: { name: string; quantity: number; unit_price: Kobo }[];
  /** FIFO cost of the sale; null when the caller can't see costs or it's unsent. */
  cost: Kobo | null;
  pending: boolean;
}

function fromServer(r: SaleHistoryRow, viewCost: boolean): SaleView {
  let cost: number | null = viewCost ? 0 : null;
  const lines = r.sale_lines.map((l) => {
    if (cost !== null) {
      const c = l.sale_line_allocations.reduce((s, a) => s + a.quantity * toKobo(a.unit_cost), 0);
      const covered = l.sale_line_allocations.reduce((s, a) => s + a.quantity, 0);
      cost = covered >= l.quantity ? cost + c : null; // shortfall: don't invent a cost
    }
    return { name: l.items?.name ?? "Item", quantity: l.quantity, unit_price: toKobo(l.unit_price) };
  });
  return {
    id: r.id, sold_at: r.sold_at, total: toKobo(r.total),
    seller: r.users?.full_name ?? null, seller_id: r.sold_by, device_id: r.device_id,
    customer_id: r.customer_id, customer: r.customers?.name ?? null, note: r.note,
    lines, cost: cost as Kobo | null, pending: false,
  };
}

/**
 * Sales history — every sale, with what was in it. The Sell screen no longer
 * shows history; this is where "what did I sell?" is answered (Nathan,
 * 2026-09-12). RLS decides scope: a cashier sees their own, an owner the shop.
 *
 * SYNC: fetched per period and cached (`sales:<from>:<to>`), so a period
 * looked at before still shows offline; unsent sales from this terminal are
 * merged in from the outbox so the list is never behind the till.
 */
export function SalesScreen({ customerId, embedded }: { customerId?: string; embedded?: boolean } = {}) {
  const { active, ctx } = useSession();
  const { data } = useShopData();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewAll = perms.includes("sales.view_all");
  const viewCost = perms.includes("items.view_cost");
  const terminalName = useTerminalName();

  const [period, setPeriod] = useState<PeriodRange>(() => resolvePreset(customerId ? "this_year" : "today"));
  const [terminal, setTerminal] = useState<string | null>(null);
  const [seller, setSeller] = useState<string>("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ list: SaleView[]; fromCache: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [openSale, setOpenSale] = useState<SaleView | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const key = cacheKey(shop.id, `sales:${period.from}:${period.to}${customerId ? `:${customerId}` : ""}`);
    void readThrough<SaleHistoryRow[]>(key, () =>
      fetchSalesHistory(getSupabase(), shop.id, period.from, period.to, customerId ? { customerId } : {}),
    ).then((r) => {
      if (cancelled) return;
      setRows(r.data ? { list: r.data.map((s) => fromServer(s, viewCost)), fromCache: r.fromCache } : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [shop.id, period.from, period.to, customerId, viewCost, data.pendingSales]);

  // Unsent sales from this terminal, in the window, on top.
  const me = ctx?.user ?? null;
  const pendingRows = useMemo<SaleView[]>(() => {
    const fromT = new Date(period.from + "T00:00:00").getTime();
    const toT = new Date(period.to + "T23:59:59.999").getTime();
    return data.sales
      .filter((s) => s.pending && new Date(s.sold_at).getTime() >= fromT && new Date(s.sold_at).getTime() <= toT)
      .filter((s) => !customerId || s.customer_id === customerId)
      .map((s) => ({
        id: s.id, sold_at: s.sold_at, total: toKobo(s.total),
        seller: me && s.sold_by === me.id ? (me.full_name ?? "You") : null, seller_id: s.sold_by,
        device_id: s.device_id, customer_id: s.customer_id, customer: s.customer_name ?? null, note: s.note,
        lines: (s.lines ?? []).map((l) => ({ name: data.items.find((i) => i.id === l.item_id)?.name ?? "Item", quantity: l.quantity, unit_price: toKobo(l.unit_price) })),
        cost: null, pending: true,
      }));
  }, [data.sales, data.items, period.from, period.to, customerId, me]);

  const all = useMemo(() => {
    const server = (rows?.list ?? []).filter((s) => !pendingRows.some((p) => p.id === s.id));
    return [...pendingRows, ...server];
  }, [rows, pendingRows]);

  const sellers = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of all) if (s.seller_id && s.seller) m.set(s.seller_id, s.seller);
    return [...m.entries()];
  }, [all]);

  const needle = q.trim().toLowerCase();
  const shown = all.filter((s) =>
    (!terminal || s.device_id === terminal) &&
    (!seller || s.seller_id === seller) &&
    (!needle || s.customer?.toLowerCase().includes(needle) || s.seller?.toLowerCase().includes(needle) || s.lines.some((l) => l.name.toLowerCase().includes(needle))),
  );

  const takings = shown.reduce((s, x) => s + x.total, 0) as Kobo;
  const units = shown.reduce((s, x) => s + x.lines.reduce((a, l) => a + l.quantity, 0), 0);
  const profitKnown = viewCost && shown.every((s) => s.cost !== null);
  const profit = profitKnown ? (shown.reduce((s, x) => s + (x.total - (x.cost ?? 0)), 0) as Kobo) : null;

  const body = (
    <div className={cn("grid gap-4", !embedded && "px-8 pb-8")}>
      {!embedded && <StaleNotice />}
      {rows?.fromCache && <p className="text-caption text-muted-foreground">Showing {describeRange(period)} as last downloaded.</p>}
      {!rows && !loading && <p className="text-caption text-muted-foreground">Sales for {describeRange(period)} need a connection the first time; they're kept for offline after that.</p>}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Card className="py-5 gap-0 bg-brand-forest text-white border-transparent">
          <CardContent className="px-5 grid gap-1">
            <div className="text-micro text-white/60">{describeRange(period)}</div>
            <div className="figure figure-lg">{formatNaira(takings)}</div>
            <div className="text-caption text-white/60">{shown.length} {shown.length === 1 ? "sale" : "sales"} · {units} {units === 1 ? "unit" : "units"}</div>
          </CardContent>
        </Card>
        <Card className="py-5 gap-0">
          <CardContent className="px-5 grid gap-1">
            <div className="text-micro text-muted-foreground">Average sale</div>
            <div className="figure figure-lg">{formatNaira((shown.length ? Math.round(takings / shown.length) : 0) as Kobo)}</div>
          </CardContent>
        </Card>
        {viewCost && (
          <Card className="py-5 gap-0">
            <CardContent className="px-5 grid gap-1">
              <div className="text-micro text-muted-foreground">Gross profit</div>
              <div className="figure figure-lg">{profit !== null ? formatNaira(profit) : "—"}</div>
              {profit === null && shown.length > 0 && <div className="text-caption text-muted-foreground">Known once unsent sales upload</div>}
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="py-0">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-title">{customerId ? "Purchases" : "Sales"} · {describeRange(period)}</div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="relative">
              <IconSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-9 pl-8 w-[220px]" placeholder="Item, customer, seller" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            {viewAll && sellers.length > 1 && (
              <select className="h-9 rounded-md border bg-card px-2 text-sm text-foreground" value={seller} onChange={(e) => setSeller(e.target.value)} aria-label="Filter by seller">
                <option value="">All sellers</option>
                {sellers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )}
            {viewAll && <TerminalFilter value={terminal} onChange={setTerminal} />}
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">When</TableHead>
              <TableHead>Items</TableHead>
              {!customerId && <TableHead>Customer</TableHead>}
              {viewAll && <TableHead>Seller</TableHead>}
              <TableHead className="text-right pr-5">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow><TableCell colSpan={5} className="pl-5 text-muted-foreground">
                {loading ? "Loading…" : `No sales ${describeRange(period).toLowerCase()}${needle ? ` matching “${q}”` : ""}.`}
              </TableCell></TableRow>
            )}
            {shown.map((s) => (
              <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpenSale(s)}>
                <TableCell className="pl-5 text-muted-foreground whitespace-nowrap">
                  {new Date(s.sold_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {s.pending && <Badge variant="warning" className="ml-2"><IconCloudUpload size={12} /> Not yet uploaded</Badge>}
                </TableCell>
                <TableCell className="max-w-[360px] truncate font-medium">{summariseLines(s.lines)}</TableCell>
                {!customerId && <TableCell className="text-muted-foreground">{s.customer ?? "Walk-in"}</TableCell>}
                {viewAll && <TableCell className="text-muted-foreground">{s.seller ?? "—"}{!terminal && terminalName(s.device_id) ? ` · ${terminalName(s.device_id)}` : ""}</TableCell>}
                <TableCell className="text-right pr-5 tabular font-semibold">{formatNaira(s.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {openSale && <SaleDetailDialog sale={openSale} viewCost={viewCost} onClose={() => setOpenSale(null)} terminal={terminalName(openSale.device_id)} />}
    </div>
  );

  if (embedded) {
    return (
      <div className="grid gap-3">
        <div className="flex justify-end"><PeriodPicker value={period} onChange={setPeriod} /></div>
        {body}
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title="Sales"
        description={viewAll ? `${shop.name} · every sale, with what was in it` : "Your sales, with what was in them"}
        actions={<PeriodPicker value={period} onChange={setPeriod} />}
      />
      {body}
    </>
  );
}

function SaleDetailDialog({ sale, viewCost, terminal, onClose }: { sale: SaleView; viewCost: boolean; terminal: string | null; onClose: () => void }) {
  const profit = sale.cost !== null ? ((sale.total - sale.cost) as Kobo) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sale · {formatNaira(sale.total)}</DialogTitle>
          <DialogDescription>
            {new Date(sale.sold_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            {sale.seller ? ` · ${sale.seller}` : ""}{terminal ? ` · ${terminal}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {sale.pending && <Badge variant="warning" className="w-fit"><IconCloudUpload size={12} /> Recorded on this terminal — uploads when the connection returns</Badge>}
          <div className="text-small"><span className="text-muted-foreground">Customer:</span> {sale.customer ?? "Walk-in"}</div>
          <ul className="divide-y rounded-[10px] border">
            {sale.lines.map((l, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 text-small">
                <span className="flex-1 min-w-0 truncate font-medium">{l.name}</span>
                <span className="text-muted-foreground tabular">{l.quantity} × {formatNaira(l.unit_price)}</span>
                <span className="tabular font-semibold w-28 text-right">{formatNaira((l.quantity * l.unit_price) as Kobo)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between items-baseline">
            <span className="text-subheading">Total</span>
            <span className="figure figure-lg">{formatNaira(sale.total)}</span>
          </div>
          {viewCost && (
            <div className="text-caption text-muted-foreground">
              {profit !== null ? <>Cost {formatNaira(sale.cost!)} · profit <span className={profit < 0 ? "text-status-red" : "text-status-green"}>{formatNaira(profit)}</span></> : sale.pending ? "Cost is worked out when this sale uploads." : "Cost not fully known for this sale (stock shortfall)."}
            </div>
          )}
          {sale.note && <div className="text-caption text-muted-foreground">Note: {sale.note}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
