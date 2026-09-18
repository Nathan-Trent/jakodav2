import { useState, type FormEvent } from "react";
import { IconPlus, IconStar, IconTrash } from "@tabler/icons-react";
import { formatNaira, type Kobo } from "@zogal/shared";
import { deletePricingPlan, listPricingPlans, upsertPricingPlan, type PricingPlan } from "@zogal/auth-permissions";
import { Alert, Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, NumberField, notifyError, notifySuccess, cn } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { getSupabase } from "@/lib/supabase";
import { useAsync, money } from "@/lib/useAsync";

const k = (v: number | string | null | undefined): Kobo => Math.round(money(v) * 100) as Kobo;

/**
 * Pricing plans (0015): what business.getzogal.com/doka shows, edited here
 * so a price change never needs a deploy. Hidden plans stay in the table
 * (and in the admin list) but never reach the public site.
 */
export function AdminPricingScreen() {
  const plans = useAsync(() => listPricingPlans(getSupabase(), "doka"), []);
  const [editing, setEditing] = useState<PricingPlan | "new" | null>(null);
  const [toDelete, setToDelete] = useState<PricingPlan | null>(null);

  return (
    <>
      <PageHeader title="Pricing" description="Doka's plans as shown on the marketing site. Changes are live immediately."
        actions={<Button onClick={() => setEditing("new")}><IconPlus size={16} /> New plan</Button>} />
      <Page>
        {plans.error && <Alert tone="warning" title="Couldn't load">{plans.error}</Alert>}
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {(plans.data ?? []).map((p) => (
            <Card key={p.id} className={cn("py-5 gap-0", p.highlight && "border-brand-action", !p.is_visible && "opacity-60")}>
              <CardContent className="px-5 grid gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-title flex items-center gap-2">{p.name}{p.highlight && <IconStar size={14} className="text-brand-action" />}</div>
                    <div className="text-caption text-muted-foreground">{p.tagline ?? "—"}</div>
                  </div>
                  {!p.is_visible && <Badge variant="secondary">Hidden</Badge>}
                </div>
                <div><span className="figure figure-lg">{formatNaira(k(p.price_monthly))}</span><span className="text-caption text-muted-foreground"> / month</span>
                  {p.price_yearly != null && <div className="text-caption text-muted-foreground">{formatNaira(k(p.price_yearly))} / year</div>}</div>
                <ul className="text-small grid gap-1">{p.features.map((f, i) => <li key={i}>· {f}</li>)}</ul>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setToDelete(p)}><IconTrash size={14} /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {(plans.data ?? []).length === 0 && !plans.loading && <p className="text-small text-muted-foreground">No plans yet.</p>}
        </div>
      </Page>
      {editing && <PlanDialog plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await plans.reload(); }} />}
      <ConfirmDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)} title={`Delete “${toDelete?.name}”?`}
        description="Removes it from the site immediately. Existing subscriptions are not affected (they reference the plan by name)." confirmLabel="Delete" destructive
        onConfirm={async () => { if (!toDelete) return; try { await deletePricingPlan(getSupabase(), toDelete.id); setToDelete(null); await plans.reload(); } catch (e) { notifyError(e); } }} />
    </>
  );
}

function PlanDialog({ plan, onClose, onDone }: { plan: PricingPlan | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [key, setKey] = useState(plan?.key ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [tagline, setTagline] = useState(plan?.tagline ?? "");
  const [monthly, setMonthly] = useState(plan ? String(money(plan.price_monthly)) : "");
  const [yearly, setYearly] = useState(plan?.price_yearly != null ? String(money(plan.price_yearly)) : "");
  const [features, setFeatures] = useState((plan?.features ?? []).join("\n"));
  const [terminals, setTerminals] = useState(plan?.limits.terminals != null ? String(plan.limits.terminals) : "");
  const [staff, setStaff] = useState(plan?.limits.staff != null ? String(plan.limits.staff) : "");
  const [highlight, setHighlight] = useState(plan?.highlight ?? false);
  const [visible, setVisible] = useState(plan?.is_visible ?? true);
  const [sort, setSort] = useState(String(plan?.sort_order ?? 0));
  const [busy, setBusy] = useState(false);
  const autoKey = key || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await upsertPricingPlan(getSupabase(), {
        ...(plan ? { id: plan.id } : {}),
        key: autoKey, name: name.trim(), tagline: tagline.trim() || null,
        price_monthly: Number(monthly), price_yearly: yearly ? Number(yearly) : null,
        features: features.split("\n").map((s) => s.trim()).filter(Boolean),
        limits: { terminals: terminals ? Number(terminals) : null, staff: staff ? Number(staff) : null },
        highlight, is_visible: visible, sort_order: Number(sort) || 0,
      });
      notifySuccess(plan ? "Plan updated" : "Plan added");
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg"><form onSubmit={submit} className="grid gap-4">
        <DialogHeader><DialogTitle>{plan ? `Edit ${plan.name}` : "New plan"}</DialogTitle><DialogDescription>One line per feature. Empty limits mean unlimited.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2"><Label htmlFor="pl-name">Name</Label><Input id="pl-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="pl-key">Key</Label><Input id="pl-key" value={autoKey} onChange={(e) => setKey(e.target.value)} placeholder="auto" /></div>
        </div>
        <div className="grid gap-2"><Label htmlFor="pl-tag">Tagline</Label><Input id="pl-tag" value={tagline} onChange={(e) => setTagline(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2"><Label>Price / month (₦)</Label><NumberField prefix="₦" decimals={0} value={monthly} onChange={setMonthly} required /></div>
          <div className="grid gap-2"><Label>Price / year (₦, optional)</Label><NumberField prefix="₦" decimals={0} value={yearly} onChange={setYearly} /></div>
        </div>
        <div className="grid gap-2"><Label htmlFor="pl-feat">Features</Label><textarea id="pl-feat" className="min-h-28 rounded-md border bg-card p-2 text-sm" value={features} onChange={(e) => setFeatures(e.target.value)} /></div>
        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-2"><Label>Terminals</Label><NumberField decimals={0} value={terminals} onChange={setTerminals} /></div>
          <div className="grid gap-2"><Label>Staff</Label><NumberField decimals={0} value={staff} onChange={setStaff} /></div>
          <div className="grid gap-2"><Label>Order</Label><NumberField decimals={0} value={sort} onChange={setSort} /></div>
        </div>
        <div className="flex gap-4 text-small">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} /> Recommended</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Visible on the site</label>
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || !monthly}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  );
}
