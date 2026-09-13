import { useState, type FormEvent } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { formatNaira, type Kobo } from "@zogal/shared";
import { adminListShops, adminSetSubscription, type AdminShop } from "@zogal/auth-permissions";
import { Alert, Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifySuccess } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { getSupabase } from "@/lib/supabase";
import { useAsync, money } from "@/lib/useAsync";

/** Zogal back office: every shop, its subscription, and whether it is alive. Platform admins only (Postgres enforces). */
export function AdminShopsScreen() {
  const shops = useAsync(() => adminListShops(getSupabase()), []);
  const [editing, setEditing] = useState<AdminShop | null>(null);
  const list = shops.data ?? [];
  const daysLeft = (iso: string | null) => (iso ? Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000) : null);

  return (
    <>
      <PageHeader title="Shops" description={`${list.length} on the platform`} actions={<Button variant="outline" onClick={() => void shops.reload()}><IconRefresh size={16} /> Refresh</Button>} />
      <Page>
        {shops.error && <Alert tone="warning" title="Couldn't load">{shops.error}</Alert>}
        <Card className="py-0"><div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead className="pl-5">Shop</TableHead><TableHead>Subscription</TableHead><TableHead>Activity</TableHead><TableHead className="text-right">30-day sales</TableHead><TableHead className="pr-5"></TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((s) => {
                const d = daysLeft(s.subscription?.expires_at ?? null);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="pl-5"><div className="font-semibold">{s.name}</div><div className="text-caption text-muted-foreground">{s.owner ? `${s.owner.name} · ${s.owner.email}` : "no owner"} · since {new Date(s.created_at).toLocaleDateString()}</div></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={s.subscription?.status === "active" ? "success" : "warning"} className="capitalize">{s.subscription?.status ?? "none"}</Badge>
                        <span className="text-caption text-muted-foreground">{s.subscription?.plan}{s.subscription?.expires_at ? ` · ${d! >= 0 ? `${d} days left` : `expired ${-d!}d ago`}` : " · no expiry"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-caption text-muted-foreground">
                      {s.members} staff · {s.devices_online}/{s.devices} terminals online · {s.scans_this_month} scans this month
                      {s.open_conflicts > 0 && <Badge variant="warning" className="ml-2">{s.open_conflicts} sync issues</Badge>}
                      <div>{s.last_sale_at ? `last sale ${new Date(s.last_sale_at).toLocaleString()}` : "no sales yet"}</div>
                    </TableCell>
                    <TableCell className="text-right tabular font-semibold">{formatNaira(Math.round(money(s.sales_30d) * 100) as Kobo)}</TableCell>
                    <TableCell className="pr-5 text-right"><Button variant="outline" size="sm" onClick={() => setEditing(s)}>Subscription</Button></TableCell>
                  </TableRow>
                );
              })}
              {list.length === 0 && !shops.loading && <TableRow><TableCell colSpan={5} className="pl-5 text-muted-foreground">No shops.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div></Card>
      </Page>
      {editing && <SubscriptionDialog shop={editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await shops.reload(); }} />}
    </>
  );
}

function SubscriptionDialog({ shop, onClose, onDone }: { shop: AdminShop; onClose: () => void; onDone: () => Promise<void> }) {
  const [status, setStatus] = useState<"active" | "past_due" | "cancelled">(shop.subscription?.status ?? "active");
  const [plan, setPlan] = useState(shop.subscription?.plan ?? "standard");
  const [expires, setExpires] = useState(shop.subscription?.expires_at ? shop.subscription.expires_at.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const extend = (days: number) => {
    const base = expires && Date.parse(expires) > Date.now() ? new Date(expires) : new Date();
    base.setDate(base.getDate() + days);
    setExpires(base.toISOString().slice(0, 10));
  };
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await adminSetSubscription(getSupabase(), { shopId: shop.id, status, plan, expiresAt: expires ? new Date(expires + "T23:59:59").toISOString() : null });
      notifySuccess(`${shop.name}: subscription updated`, { description: "Terminals pick it up at their next sync." });
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent><form onSubmit={submit} className="grid gap-4">
        <DialogHeader><DialogTitle>{shop.name} — subscription</DialogTitle><DialogDescription>Sets what the terminals enforce offline. An empty expiry means no expiry.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2"><Label>Status</Label>
            <select className="h-9 rounded-md border bg-card px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="active">Active</option><option value="past_due">Past due</option><option value="cancelled">Cancelled</option>
            </select></div>
          <div className="grid gap-2"><Label htmlFor="sub-plan">Plan</Label><Input id="sub-plan" value={plan} onChange={(e) => setPlan(e.target.value)} /></div>
        </div>
        <div className="grid gap-2"><Label htmlFor="sub-exp">Expires</Label><Input id="sub-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          <div className="flex gap-2 flex-wrap">
            <Button type="button" size="sm" variant="outline" onClick={() => extend(30)}>+30 days</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => extend(90)}>+90 days</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => extend(365)}>+1 year</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpires("")}>No expiry</Button>
          </div></div>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  );
}
