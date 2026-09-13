import { useEffect, useState, type ReactNode } from "react";
import { IconAlertTriangle, IconArrowRight, IconCloudUpload, IconRefresh } from "@tabler/icons-react";
import { fetchShopDashboard, type ShopDashboard } from "@zogal/inventory-batches";
import { cacheKey, readThrough } from "@zogal/sync";
import { formatNaira, toKobo, type Kobo } from "@zogal/shared";
import { PageHeader } from "@/components/AppShell";
import { StaleNotice } from "@/components/StaleNotice";
import { TerminalFilter, useTerminalName } from "@/components/TerminalFilter";
import { TaxWidget } from "@/components/TaxWidget";
import { PeriodPicker, describeRange, resolvePreset, type PeriodRange, Badge, Button, Card, CardContent, cn } from "@zogal/ui";
import { getSupabase } from "@/lib/supabase";
import { useShopData } from "@/lib/shopData";
import { useSession } from "@/lib/session";
import type { PageKey } from "@/lib/nav";

const money = (v: string | number | null | undefined): Kobo => toKobo(v == null ? 0 : typeof v === "number" ? v : v);

/**
 * Overview. What it shows depends on who's looking:
 *  - Owner/Admin (sales.view_all + items.view_cost): the whole shop — takings,
 *    profit, stock value, low stock, terminals online, staff.
 *  - Salesperson: their own takings today, stock levels, quick path to Sell.
 * All numbers come from shop_dashboard() (0005), which enforces the gating.
 */
export function DashboardScreen({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { ctx, active } = useSession();
  const { data: shopData, refreshing, refresh } = useShopData();
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");
  // "Today" comes from the working set (offline-safe, includes unsent sales).
  // Any other period is fetched for that window and cached, so a period you
  // have looked at before still shows offline — with the usual "as of" note.
  const todayData = shopData.dashboard;
  const [period, setPeriod] = useState<PeriodRange>(() => resolvePreset("today"));
  const [rangeData, setRangeData] = useState<{ d: ShopDashboard; fromCache: boolean } | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const isToday = period.preset === "today";

  useEffect(() => {
    if (isToday) { setRangeData(null); return; }
    let cancelled = false;
    setRangeLoading(true);
    void readThrough<ShopDashboard>(
      cacheKey(shop.id, `dashboard:${period.from}:${period.to}`),
      () => fetchShopDashboard(getSupabase(), shop.id, period.from, period.to),
    ).then((r) => {
      if (cancelled) return;
      setRangeData(r.data ? { d: r.data, fromCache: r.fromCache } : null);
      setRangeLoading(false);
    });
    return () => { cancelled = true; };
  }, [isToday, period.from, period.to, shop.id]);

  const data = isToday ? todayData : (rangeData?.d ?? null);
  const fig = isToday
    ? todayData?.today
    : (rangeData?.d.range ?? null);
  const periodWord = isToday ? "today" : describeRange(period).toLowerCase();
  const [terminal, setTerminal] = useState<string | null>(null);
  const terminalName = useTerminalName();
  const recent = shopData.sales.filter((s) => !terminal || s.device_id === terminal).slice(0, 8);
  const loading = refreshing;
  const load = refresh;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = ctx?.user?.full_name.split(" ")[0] ?? "";
  const mine = data?.scope === "mine";

  return (
    <>
      <PageHeader
        title={`${greeting}, ${firstName}`}
        description={mine ? `Your sales ${periodWord}` : `${shop.name} · ${describeRange(period)}`}
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            <Button variant="outline" onClick={() => void load()} disabled={loading}><IconRefresh size={16} /> Refresh</Button>
            {perms.includes("sales.create") && (
              <Button onClick={() => onNavigate("sell")}>New sale <IconArrowRight size={16} /></Button>
            )}
          </>
        }
      />

      <div className="px-8 pb-8 grid gap-6">
        <StaleNotice />
        {!isToday && rangeData?.fromCache && (
          <p className="text-caption text-muted-foreground">Showing figures for {describeRange(period)} as last downloaded.</p>
        )}
        {!isToday && !rangeData && !rangeLoading && (
          <p className="text-caption text-muted-foreground">Figures for {describeRange(period)} need a connection the first time; they're kept for offline after that.</p>
        )}
        {/* Headline figures */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat label={mine ? `My takings ${periodWord}` : `Takings ${periodWord}`} value={formatNaira(money(fig?.sales_total))}
                sub={`${fig?.sales_count ?? 0} ${plural(fig?.sales_count ?? 0, "sale")} · ${fig?.units_sold ?? 0} ${plural(fig?.units_sold ?? 0, "unit")}${isToday && shopData.pendingSales ? ` · ${shopData.pendingSales} not yet uploaded` : ""}`} primary />
          {viewCost ? (
            <Stat label={`Gross profit ${periodWord}`} value={formatNaira(money(fig?.gross_profit))}
                  sub={!isToday && rangeData?.d.range?.net_profit != null ? `Net ${formatNaira(money(rangeData.d.range.net_profit))} after ${formatNaira(money(rangeData.d.range.expenses))} expenses` : "Selling price minus batch cost"} />
          ) : (
            <Stat label={`Units sold ${periodWord}`} value={String(fig?.units_sold ?? 0)} sub="Across all your sales" />
          )}
          <Stat label="Stock on hand" value={String(data?.stock.units ?? 0)}
                sub={viewCost ? `${data?.stock.items ?? 0} items · worth ${formatNaira(money(data?.stock.value))}` : `${data?.stock.items ?? 0} items`} />
          <Stat label="Low stock" value={String(data?.stock.low_stock ?? 0)}
                sub="Items with 2 or fewer left" tone={(data?.stock.low_stock ?? 0) > 0 ? "warn" : undefined}
                onClick={() => onNavigate("items")} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-6">
          {/* Last 7 days */}
          <Card>
            <CardContent className="grid gap-4">
              <div className="flex items-baseline justify-between">
                <div className="text-title">{isToday ? "Last 7 days" : describeRange(period)}</div>
                <div className="text-caption text-muted-foreground">{mine ? "Your sales" : "Whole shop"}{!isToday && rangeData?.d.bucket === "week" ? " · by week" : ""}</div>
              </div>
              <WeekBars week={isToday ? (data?.week ?? []) : (rangeData?.d.series ?? [])} highlightLast={isToday} />
            </CardContent>
          </Card>

          {/* Shop status (owner) / quick actions (staff) */}
          <Card>
            <CardContent className="grid gap-4">
              <div className="text-title">{mine ? "Quick actions" : "Shop status"}</div>
              {mine ? (
                <div className="grid gap-2">
                  <Button size="lg" onClick={() => onNavigate("sell")}>Start a sale</Button>
                  <Button size="lg" variant="outline" onClick={() => onNavigate("items")}>Check stock</Button>
                </div>
              ) : (
                <div className="grid gap-3">
                  <StatusRow label="Terminals online"
                    value={`${data?.devices.online ?? 0} of ${data?.devices.total ?? 0}`}
                    badge={(data?.devices.online ?? 0) > 0 ? <Badge variant="success">Live</Badge> : <Badge variant="secondary">Idle</Badge>}
                    onClick={perms.includes("shop.settings") ? () => onNavigate("devices") : undefined} />
                  <StatusRow label="Staff" value={`${data?.staff.total ?? 0} ${plural(data?.staff.total ?? 0, "member")}`}
                    onClick={perms.includes("users.manage") ? () => onNavigate("staff") : undefined} />
                  <StatusRow label="Low stock items" value={String(data?.stock.low_stock ?? 0)}
                    badge={(data?.stock.low_stock ?? 0) > 0 ? <Badge variant="warning"><IconAlertTriangle size={12} /> Restock</Badge> : <Badge variant="success">OK</Badge>}
                    onClick={() => onNavigate("items")} />
                  <TaxWidget onNavigate={onNavigate} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent activity */}
        <Card>
          <CardContent className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-title">Recent sales</div>
              <div className="flex items-center gap-3">
                {!mine && <TerminalFilter value={terminal} onChange={setTerminal} />}
                <button className="text-caption text-muted-foreground hover:text-foreground" onClick={() => onNavigate("sales")}>All sales</button>
              </div>
            </div>
            {recent.length === 0 ? (
              <p className="text-small text-muted-foreground">No sales yet{perms.includes("sales.create") ? " — record the first one from Sell." : "."}</p>
            ) : (
              <ul className="divide-y">
                {recent.map((s) => (
                  <li key={s.id} className="flex items-center gap-4 py-2.5">
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <div className="text-caption text-muted-foreground">
                        {new Date(s.sold_at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                        {!mine && !terminal && terminalName(s.device_id) ? ` · ${terminalName(s.device_id)}` : ""}
                      </div>
                      {s.pending && (
                        <Badge variant="warning"><IconCloudUpload size={12} /> Not yet uploaded</Badge>
                      )}
                    </div>
                    <div className="figure text-[15px] tabular">{formatNaira(toKobo(s.total))}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function plural(n: number, word: string) { return n === 1 ? word : `${word}s`; }

function Stat({ label, value, sub, primary, tone, onClick }: { label: string; value: string; sub?: string; primary?: boolean; tone?: "warn" | undefined; onClick?: (() => void) | undefined }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Card className={cn("py-5 gap-0", onClick && "pressable cursor-pointer text-left", primary && "bg-brand-forest text-white border-transparent")}>
      <CardContent className="px-5 grid gap-1">
        <Comp onClick={onClick} className="grid gap-1 text-left w-full">
          <div className={cn("text-micro", primary ? "text-white/60" : "text-muted-foreground")}>{label}</div>
          <div className={cn("figure figure-lg", tone === "warn" && !primary && "text-status-amber")}>{value}</div>
          {sub && <div className={cn("text-caption", primary ? "text-white/60" : "text-muted-foreground")}>{sub}</div>}
        </Comp>
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, value, badge, onClick }: { label: string; value: string; badge?: ReactNode; onClick?: (() => void) | undefined }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp onClick={onClick} className={cn("flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 -mx-3 text-left", onClick && "hover:bg-accent transition-colors")}>
      <div>
        <div className="text-small font-semibold">{label}</div>
        <div className="text-caption text-muted-foreground">{value}</div>
      </div>
      {badge}
    </Comp>
  );
}

/** Seven bars, no chart lib. Height = share of the week's max. */
function WeekBars({ week, highlightLast = true }: { week: ShopDashboard["week"]; highlightLast?: boolean }) {
  const totals = week.map((d) => money(d.total));
  const max = Math.max(1, ...totals);
  const many = week.length > 14;
  return (
    <div className="flex gap-1 items-end h-36" style={{ gap: many ? 2 : 8 }}>
      {week.map((d, i) => {
        const h = Math.max(4, Math.round((totals[i]! / max) * 100));
        const isToday = highlightLast && i === week.length - 1;
        return (
          <div key={d.day} className="grid gap-1.5 content-end h-full flex-1 min-w-0" title={`${new Date(d.day + "T00:00:00").toLocaleDateString()} · ${formatNaira(totals[i]!)} · ${d.count} sales`}>
            <div className="flex items-end h-full">
              <div className={cn("w-full rounded-[4px] transition-[height]", isToday ? "bg-brand-action" : "bg-brand-mint")} style={{ height: `${h}%` }} />
            </div>
            {!many && (
              <div className={cn("text-micro text-center truncate", isToday ? "text-foreground" : "text-muted-foreground")}>
                {week.length <= 7
                  ? new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)
                  : new Date(d.day + "T00:00:00").getDate()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
