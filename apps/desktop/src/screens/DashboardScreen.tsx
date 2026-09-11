import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconAlertTriangle, IconArrowRight, IconRefresh } from "@tabler/icons-react";
import { toast } from "sonner";
import { fetchRecentSales, fetchShopDashboard, type RecentSale, type ShopDashboard } from "@jakoda/inventory-batches";
import { formatNaira, toKobo, type Kobo } from "@jakoda/shared";
import { PageHeader } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { errorMessage, useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import type { PageKey } from "@/lib/nav";
import { cn } from "@/lib/utils";

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
  const shop = active!.shop;
  const perms = active!.permissions;
  const viewCost = perms.includes("items.view_cost");
  const [data, setData] = useState<ShopDashboard | null>(null);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const db = getSupabase();
      const [d, r] = await Promise.all([fetchShopDashboard(db, shop.id), fetchRecentSales(db, shop.id, 8)]);
      setData(d);
      setRecent(r);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [shop.id]);

  useEffect(() => { void load(); }, [load]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = ctx?.user?.full_name.split(" ")[0] ?? "";
  const mine = data?.scope === "mine";

  return (
    <>
      <PageHeader
        title={`${greeting}, ${firstName}`}
        description={mine ? "Your sales today" : `${shop.name} · today at a glance`}
        actions={
          <>
            <Button variant="outline" onClick={() => void load()} disabled={loading}><IconRefresh size={16} /> Refresh</Button>
            {perms.includes("sales.create") && (
              <Button onClick={() => onNavigate("sell")}>New sale <IconArrowRight size={16} /></Button>
            )}
          </>
        }
      />

      <div className="px-8 pb-8 grid gap-6">
        {/* Headline figures */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat label={mine ? "My takings today" : "Takings today"} value={formatNaira(money(data?.today.sales_total))}
                sub={`${data?.today.sales_count ?? 0} ${plural(data?.today.sales_count ?? 0, "sale")} · ${data?.today.units_sold ?? 0} ${plural(data?.today.units_sold ?? 0, "unit")}`} primary />
          {viewCost ? (
            <Stat label="Gross profit today" value={formatNaira(money(data?.today.gross_profit))} sub="Selling price minus batch cost" />
          ) : (
            <Stat label="Units sold today" value={String(data?.today.units_sold ?? 0)} sub="Across all your sales" />
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
                <div className="text-title">Last 7 days</div>
                <div className="text-caption text-muted-foreground">{mine ? "Your sales" : "Whole shop"}</div>
              </div>
              <WeekBars week={data?.week ?? []} />
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
                  <StatusRow label="Tax" value="Not set up" badge={<Badge variant="secondary">Stage 6</Badge>} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent activity */}
        <Card>
          <CardContent className="grid gap-3">
            <div className="flex items-baseline justify-between">
              <div className="text-title">Recent sales</div>
              <button className="text-caption text-muted-foreground hover:text-foreground" onClick={() => onNavigate("reports")}>All sales</button>
            </div>
            {recent.length === 0 ? (
              <p className="text-small text-muted-foreground">No sales yet{perms.includes("sales.create") ? " — record the first one from Sell." : "."}</p>
            ) : (
              <ul className="divide-y">
                {recent.map((s) => (
                  <li key={s.id} className="flex items-center gap-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-small font-semibold truncate">
                        {s.sale_lines.map((l) => `${l.quantity} × ${l.items?.name ?? "item"}`).join(", ")}
                      </div>
                      <div className="text-caption text-muted-foreground">
                        {new Date(s.sold_at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                        {!mine && s.users ? ` · ${s.users.full_name}` : ""}
                      </div>
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
function WeekBars({ week }: { week: ShopDashboard["week"] }) {
  const totals = week.map((d) => money(d.total));
  const max = Math.max(1, ...totals);
  return (
    <div className="grid grid-cols-7 gap-2 items-end h-36">
      {week.map((d, i) => {
        const h = Math.max(4, Math.round((totals[i]! / max) * 100));
        const isToday = i === week.length - 1;
        return (
          <div key={d.day} className="grid gap-1.5 content-end h-full" title={`${formatNaira(totals[i]!)} · ${d.count} sales`}>
            <div className="flex items-end h-full">
              <div className={cn("w-full rounded-[6px] transition-[height]", isToday ? "bg-brand-action" : "bg-brand-mint")} style={{ height: `${h}%` }} />
            </div>
            <div className={cn("text-micro text-center", isToday ? "text-foreground" : "text-muted-foreground")}>
              {new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
