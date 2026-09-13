import { useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { formatNaira, type Kobo } from "@zogal/shared";
import { fetchShopDashboard } from "@zogal/inventory-batches";
import { openConflictCount } from "@zogal/sync";
import { Alert, Badge, Button, Card, CardContent, PeriodPicker, describeRange, resolvePreset, type PeriodRange, cn } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useAsync, money } from "@/lib/useAsync";
import type { PageKey } from "@/lib/nav";

const k = (v: number | string | null | undefined): Kobo => Math.round(money(v) * 100) as Kobo;

/** The owner's first screen: the shop at a glance for any period, plus what needs attention. */
export function OverviewScreen({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { active, auth } = useSession();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");
  const [period, setPeriod] = useState<PeriodRange>(() => resolvePreset("today"));

  const dash = useAsync(() => fetchShopDashboard(getSupabase(), shop.id, period.from, period.to), [shop.id, period.from, period.to]);
  const devices = useAsync(() => auth.listDevices(shop.id), [shop.id]);
  const conflicts = useAsync(() => openConflictCount(getSupabase(), shop.id), [shop.id]);

  const d = dash.data;
  const r = d?.range;
  const series = d?.series ?? [];
  const max = Math.max(1, ...series.map((s) => money(s.total)));
  const online = (devices.data ?? []).filter((x) => !x.revoked_at && x.is_online).length;
  const total = (devices.data ?? []).filter((x) => !x.revoked_at).length;

  return (
    <>
      <PageHeader title={shop.name} description={`At a glance · ${describeRange(period)}`}
        actions={<><PeriodPicker value={period} onChange={setPeriod} /><Button variant="outline" onClick={() => void Promise.all([dash.reload(), devices.reload(), conflicts.reload()])}><IconRefresh size={16} /> Refresh</Button></>} />
      <Page>
        {dash.error && <Alert tone="warning" title="Couldn't load figures">{dash.error}</Alert>}
        {(conflicts.data ?? 0) > 0 && (
          <Alert tone="warning" title={`${conflicts.data} sync ${conflicts.data === 1 ? "issue needs" : "issues need"} a look`} action={<Button size="sm" variant="outline" onClick={() => onNavigate("conflicts")}>Open</Button>}>
            Offline sales that didn't match the server's stock. Sales are recorded either way.
          </Alert>
        )}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat label="Takings" value={formatNaira(k(r?.sales_total))} sub={`${r?.sales_count ?? 0} sales · ${r?.units_sold ?? 0} units`} primary />
          {viewCost && <Stat label="Gross profit" value={formatNaira(k(r?.gross_profit))} sub={r?.expenses != null ? `Net ${formatNaira(k(r.net_profit))} after ${formatNaira(k(r.expenses))} expenses` : "Selling price minus batch cost"} />}
          <Stat label="Stock on hand" value={viewCost && d?.stock.value != null ? formatNaira(k(d.stock.value)) : `${d?.stock.units ?? 0} units`} sub={`${d?.stock.items ?? 0} items · ${d?.stock.low_stock ?? 0} low`} tone={(d?.stock.low_stock ?? 0) > 0 ? "warn" : undefined} />
          <Stat label="Terminals" value={`${online} / ${total} online`} sub={total === 0 ? "None activated yet" : "Synced in the last 5 minutes"} onClick={() => onNavigate("devices")} />
        </div>
        <Card className="py-5">
          <CardContent className="px-5 grid gap-3">
            <div className="flex items-baseline justify-between"><div className="text-title">{describeRange(period)}</div><div className="text-caption text-muted-foreground">{d?.bucket === "week" ? "by week" : "by day"}</div></div>
            {series.length === 0 ? <p className="text-small text-muted-foreground">{dash.loading ? "Loading…" : "No sales in this period."}</p> : (
              <div className="flex items-end h-36" style={{ gap: series.length > 14 ? 2 : 8 }}>
                {series.map((s) => (
                  <div key={s.day} className="flex-1 min-w-0 grid content-end h-full gap-1" title={`${new Date(s.day + "T00:00:00").toLocaleDateString()} · ${formatNaira(k(s.total))} · ${s.count} sales`}>
                    <div className="flex items-end h-full"><div className="w-full rounded-[4px] bg-brand-mint" style={{ height: `${Math.max(4, Math.round((money(s.total) / max) * 100))}%` }} /></div>
                    {series.length <= 14 && <div className="text-micro text-center text-muted-foreground truncate">{series.length <= 7 ? new Date(s.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2) : new Date(s.day + "T00:00:00").getDate()}</div>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        {devices.data && devices.data.filter((x) => !x.revoked_at).length > 0 && (
          <Card className="py-4"><CardContent className="px-5 grid gap-2">
            <div className="text-title">Terminals</div>
            <ul className="divide-y">
              {devices.data.filter((x) => !x.revoked_at).map((x) => (
                <li key={x.id} className="flex items-center justify-between py-2 gap-3">
                  <span className="font-medium">{x.name}</span>
                  <span className="flex items-center gap-3 text-caption text-muted-foreground">{x.last_sync_at ? `synced ${new Date(x.last_sync_at).toLocaleString()}` : "never synced"}{x.is_online ? <Badge variant="success">Online</Badge> : <Badge variant="secondary">Offline</Badge>}</span>
                </li>
              ))}
            </ul>
          </CardContent></Card>
        )}
      </Page>
    </>
  );
}

function Stat({ label, value, sub, primary, tone, onClick }: { label: string; value: string; sub?: string; primary?: boolean; tone?: "warn" | undefined; onClick?: (() => void) | undefined }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Card className={cn("py-5 gap-0", onClick && "pressable cursor-pointer text-left", primary && "bg-brand-forest text-white border-transparent")}>
      <CardContent className="px-5">
        <Comp onClick={onClick} className="grid gap-1 text-left w-full">
          <div className={cn("text-micro", primary ? "text-white/60" : "text-muted-foreground")}>{label}</div>
          <div className={cn("figure figure-lg", tone === "warn" && !primary && "text-status-amber")}>{value}</div>
          {sub && <div className={cn("text-caption", primary ? "text-white/60" : "text-muted-foreground")}>{sub}</div>}
        </Comp>
      </CardContent>
    </Card>
  );
}
