import { useMemo, useState, type FormEvent } from "react";
import { IconAlertTriangle, IconCalendarCheck, IconCircleCheck, IconClock, IconFileCheck, IconInfoCircle, IconReceiptTax } from "@tabler/icons-react";
import { formatNaira, type Kobo } from "@zogal/shared";
import {
  computeObligations, declareTaxProfile, markPeriodFiled, periodStatuses,
  type BusinessCategory, type PeriodStatus, type TaxObligation,
} from "@zogal/tax-engine";
import { PageHeader } from "@/components/AppShell";
import { Alert, Badge, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, notifyError, notifySuccess, cn } from "@zogal/ui";
import { StaleNotice } from "@/components/StaleNotice";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import { useSync } from "@/lib/sync";
import { getSupabase } from "@/lib/supabase";
import { useOnline } from "@/lib/useOnline";

const naira = (n: number) => formatNaira(Math.round(n * 100) as Kobo);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Tax (TRD §8, PRD §6.7). Three parts, top to bottom:
 *   1. What applies — from the owner's own declaration, never inferred.
 *   2. Where you stand — live figures per tax, computed by the engine from
 *      the cached ledger (works offline), labelled DRAFT until the rules are
 *      confirmed by an accountant (TRD §8.1).
 *   3. What's due — outstanding vs filed periods; filing locks a period.
 *
 * Nothing here calculates a number; the engine does, deterministically.
 */
export function TaxScreen() {
  const { active } = useSession();
  const { data, loading, refresh } = useShopData();
  const { financialsVisible } = useSync();
  const canFile = active!.permissions.includes("tax.mark_filed");
  const canDeclare = active!.permissions.includes("shop.settings");

  const tax = data.tax;
  const asOf = today();

  const obligations = useMemo<TaxObligation[]>(() => {
    if (!tax?.profile) return [];
    const category = tax.categories.find((c) => c.key === tax.profile!.categoryKey);
    if (!category) return [];
    // Fold unsent sales into the ledger so the live figure is honest offline.
    const year = { ...tax.year, turnover: tax.year.turnover + data.pendingTurnover, netProfit: tax.year.netProfit + (data.pendingProfit ?? 0) };
    const month = { ...tax.month, turnover: tax.month.turnover + data.pendingTurnover, netProfit: tax.month.netProfit + (data.pendingProfit ?? 0) };
    return computeObligations({ asOf, profile: tax.profile, category, taxTypes: tax.taxTypes, rules: tax.rules, year, month });
  }, [tax, data.pendingTurnover, data.pendingProfit, asOf]);

  const statuses = useMemo<PeriodStatus[]>(() => {
    if (!tax?.profile) return [];
    const category = tax.categories.find((c) => c.key === tax.profile!.categoryKey);
    if (!category) return [];
    return periodStatuses({
      asOf, declaredOn: tax.profile.declaredAt.slice(0, 10), profile: tax.profile, category,
      taxTypes: tax.taxTypes, rules: tax.rules, filed: tax.filed,
    });
  }, [tax, asOf]);

  const [filing, setFiling] = useState<PeriodStatus | null>(null);

  if (!financialsVisible) {
    return (
      <>
        <PageHeader title="Tax" />
        <div className="px-8"><Alert tone="warning" title="Tax figures are hidden while this terminal is read-only">Sync to restore them.</Alert></div>
      </>
    );
  }

  if (loading && !tax) {
    return <><PageHeader title="Tax" /><p className="px-8 text-small text-muted-foreground">Loading…</p></>;
  }

  if (!tax) {
    return (
      <>
        <PageHeader title="Tax" />
        <div className="px-8"><Alert tone="info" title="Tax data isn't available yet">The tax tables may not be set up on the server, or this terminal hasn't synced them.</Alert></div>
      </>
    );
  }

  // --- 1. Not declared yet -------------------------------------------------
  if (!tax.profile) {
    return (
      <>
        <PageHeader title="Tax" description="Tell the system what kind of business this is. It never guesses from your sales." />
        <div className="px-8 pb-8">
          <StaleNotice className="mb-4" />
          {canDeclare
            ? <DeclareCategory categories={tax.categories} onDone={refresh} />
            : <Alert tone="info" title="Not set up yet">Ask the shop owner to declare the business category under Tax.</Alert>}
        </div>
      </>
    );
  }

  const profile = tax.profile;
  const category = tax.categories.find((c) => c.key === profile.categoryKey);
  const anyDraft = obligations.some((o) => !o.verified);
  const outstanding = statuses.filter((s) => s.status === "due" || s.status === "overdue");

  return (
    <>
      <PageHeader
        title="Tax"
        description={`${category?.name ?? profile.categoryKey}${profile.tin ? ` · TIN ${profile.tin}` : ""}`}
        actions={canDeclare && <ChangeCategoryButton current={profile.categoryKey} vatRegistered={profile.vatRegistered} tin={profile.tin} categories={tax.categories} onDone={refresh} />}
      />
      <div className="px-8 pb-8 grid gap-5">
        <StaleNotice />

        {anyDraft && (
          <Alert tone="warning" title="These are draft estimates">
            The rates and thresholds have been entered but not yet confirmed by an accountant. Use them to see where you stand — not to file. They'll be marked confirmed once checked.
          </Alert>
        )}

        {/* --- 2. Where you stand -------------------------------------- */}
        <div className="grid gap-4 xl:grid-cols-2">
          {obligations.map((o) => <ObligationCard key={o.taxType.key} o={o} />)}
        </div>

        {/* --- 3. What's due --------------------------------------------- */}
        <Card>
          <CardContent className="grid gap-3">
            <div className="flex items-center justify-between">
              <div className="text-title flex items-center gap-2"><IconCalendarCheck size={18} /> Filing</div>
              {outstanding.length > 0
                ? <Badge variant={outstanding.some((s) => s.status === "overdue") ? "critical" : "warning"}>{outstanding.length} to file</Badge>
                : <Badge variant="success"><IconCircleCheck size={12} /> Nothing outstanding</Badge>}
            </div>
            <p className="text-small text-muted-foreground">
              Filing happens on the FIRS / State IRS portal, not here. When you've filed, mark the period with the reference number they give you — that locks it so nothing inside it changes silently.
            </p>
            <ul className="divide-y">
              {statuses.slice(0, 24).map((s) => {
                const tt = tax.taxTypes.find((t) => t.key === s.taxTypeKey);
                return (
                  <li key={`${s.taxTypeKey}-${s.periodStart}`} className="flex items-center gap-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-small font-semibold">{tt?.name ?? s.taxTypeKey} · {periodLabel(s)}</div>
                      <div className="text-caption text-muted-foreground">
                        {s.filed ? `Filed ${new Date(s.filed.filedAt).toLocaleDateString()} · ref ${s.filed.reference}`
                          : s.dueDate ? `Due ${new Date(s.dueDate + "T00:00:00").toLocaleDateString()}` : "Due date not configured"}
                      </div>
                    </div>
                    <StatusBadge status={s.status} />
                    {canFile && (s.status === "due" || s.status === "overdue") && (
                      <Button size="sm" variant="outline" onClick={() => setFiling(s)}><IconFileCheck size={14} /> Mark filed</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {/* Reliefs: data model present, calculation off (TRD §8) */}
        <Card className="border-dashed">
          <CardContent className="flex items-start gap-3">
            <IconInfoCircle size={18} className="text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-small text-muted-foreground">
              <b className="text-foreground">Reliefs and refunds</b> — charitable donations, pension contributions and withholding-tax credits can reduce what you owe. The system can record them, but won't apply them to the figures above until the relief rules are sourced and confirmed.
            </div>
          </CardContent>
        </Card>
      </div>

      {filing && (
        <MarkFiledDialog
          period={filing}
          taxTypeName={tax.taxTypes.find((t) => t.key === filing.taxTypeKey)?.name ?? filing.taxTypeKey}
          figures={obligations.find((o) => o.taxType.key === filing.taxTypeKey) ?? null}
          onClose={() => setFiling(null)}
          onDone={async () => { setFiling(null); await refresh(); }}
        />
      )}
    </>
  );
}

function periodLabel(s: PeriodStatus): string {
  const a = new Date(s.periodStart + "T00:00:00");
  const isMonth = s.periodStart.slice(0, 7) === s.periodEnd.slice(0, 7);
  return isMonth ? a.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : `Year ${a.getFullYear()}`;
}

function StatusBadge({ status }: { status: PeriodStatus["status"] }) {
  switch (status) {
    case "filed": return <Badge variant="success"><IconCircleCheck size={12} /> Filed</Badge>;
    case "overdue": return <Badge variant="critical"><IconAlertTriangle size={12} /> Overdue</Badge>;
    case "due": return <Badge variant="warning"><IconClock size={12} /> To file</Badge>;
    default: return <Badge variant="secondary">In progress</Badge>;
  }
}

function ObligationCard({ o }: { o: TaxObligation }) {
  const pct = o.threshold ? Math.min(100, Math.round((o.threshold.current / o.threshold.amount) * 100)) : null;
  return (
    <Card className={cn("gap-0", !o.liable && "opacity-90")}>
      <CardContent className="grid gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-title flex items-center gap-2"><IconReceiptTax size={18} /> {o.taxType.name}</div>
            <div className="text-caption text-muted-foreground">{o.taxType.authority} · {o.taxType.period === "monthly" ? "monthly" : "yearly"}</div>
          </div>
          {o.liable ? <Badge variant="warning">Applies</Badge> : <Badge variant="secondary">Not yet</Badge>}
          {!o.verified && <Badge variant="outline" className="border-status-amber text-status-amber">Draft</Badge>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-micro text-muted-foreground">{o.basisLabel || "Basis"}</div>
            <div className="figure figure-lg">{naira(o.basisAmount)}</div>
          </div>
          <div>
            <div className="text-micro text-muted-foreground">Estimated {o.taxType.period === "monthly" ? "this month" : "this year"}</div>
            <div className={cn("figure figure-lg", o.estimate === null && "text-muted-foreground")}>{o.estimate === null ? "—" : naira(o.estimate)}</div>
            {o.rate !== null && o.liable && <div className="text-caption text-muted-foreground">at {Math.round(o.rate * 100)}%{o.effectiveRate !== null && o.effectiveRate !== o.rate ? ` (effective ${(o.effectiveRate * 100).toFixed(1)}%)` : ""}</div>}
          </div>
        </div>

        {o.threshold && (
          <div className="grid gap-1">
            <div className="flex justify-between text-caption text-muted-foreground">
              <span>{naira(o.threshold.current)} of the {naira(o.threshold.amount)} yearly threshold</span>
              <span>{o.threshold.above ? "Crossed" : `${naira(o.threshold.remaining)} to go`}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div className={cn("h-full rounded-full", o.threshold.above ? "bg-status-amber" : "bg-brand-action")} style={{ width: `${pct ?? 0}%` }} />
            </div>
          </div>
        )}

        {o.nextDue && (
          <div className="text-caption text-muted-foreground">
            Next filing: <b className="text-foreground">{new Date(o.nextDue.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</b> for {periodLabel({ periodStart: o.nextDue.periodStart, periodEnd: o.nextDue.periodEnd } as PeriodStatus)}
          </div>
        )}
        {o.notes.length > 0 && (
          <ul className="text-caption text-muted-foreground grid gap-0.5">
            {o.notes.map((n, i) => <li key={i}>· {n}</li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Declaration -----------------------------------------------------------

function DeclareCategory({ categories, onDone, current, vatRegistered: vr0, tin: tin0, onCancel }: {
  categories: BusinessCategory[]; onDone: () => Promise<void>;
  current?: string; vatRegistered?: boolean; tin?: string | null; onCancel?: () => void;
}) {
  const { ctx, active } = useSession();
  const online = useOnline();
  const [key, setKey] = useState(current ?? categories[0]?.key ?? "");
  const [vat, setVat] = useState(vr0 ?? false);
  const [tin, setTin] = useState(tin0 ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ctx?.user) return;
    setBusy(true);
    try {
      await declareTaxProfile(getSupabase(), { shopId: active!.shop.id, categoryKey: key, vatRegistered: vat, tin: tin.trim() || null, declaredBy: ctx.user.id });
      notifySuccess("Business category saved", { description: "The tax view is built from this declaration." });
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 max-w-xl">
      {!online && <Alert tone="info" title="Saving needs a connection">You can pick now; it saves when you're back online.</Alert>}
      <div className="grid gap-2">
        {categories.map((c) => (
          <label key={c.key} className={cn("flex items-start gap-3 rounded-[12px] border p-4 cursor-pointer transition-colors", key === c.key ? "border-brand-action bg-brand-action/5" : "hover:border-foreground/30")}>
            <input type="radio" name="cat" className="mt-1" checked={key === c.key} onChange={() => setKey(c.key)} />
            <div>
              <div className="text-subheading">{c.name}</div>
              <div className="text-small text-muted-foreground">{c.description}</div>
              <div className="text-caption text-muted-foreground mt-1">Applies: {c.taxTypes.map((t) => t.toUpperCase().replace("_", " ")).join(", ")}</div>
            </div>
          </label>
        ))}
      </div>
      <label className="flex items-center gap-3 text-small">
        <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
        Already registered for VAT (it applies even below the threshold)
      </label>
      <div className="grid gap-2 max-w-xs">
        <Label htmlFor="tin">Tax Identification Number <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input id="tin" value={tin} onChange={(e) => setTin(e.target.value)} maxLength={30} placeholder="e.g. 12345678-0001" />
      </div>
      <div className="flex gap-2">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button type="submit" disabled={busy || !key || !online}>{busy ? "Saving…" : "Save declaration"}</Button>
      </div>
    </form>
  );
}

function ChangeCategoryButton({ current, vatRegistered, tin, categories, onDone }: { current: string; vatRegistered: boolean; tin: string | null; categories: BusinessCategory[]; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>Change category</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Business category</DialogTitle>
            <DialogDescription>Changing this changes which taxes apply. Filed periods are unaffected.</DialogDescription>
          </DialogHeader>
          <DeclareCategory categories={categories} current={current} vatRegistered={vatRegistered} tin={tin} onCancel={() => setOpen(false)} onDone={async () => { setOpen(false); await onDone(); }} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---- Mark as filed (PRD §5.7) --------------------------------------------

function MarkFiledDialog({ period, taxTypeName, figures, onClose, onDone }: {
  period: PeriodStatus; taxTypeName: string; figures: TaxObligation | null; onClose: () => void; onDone: () => Promise<void>;
}) {
  const { ctx, active } = useSession();
  const online = useOnline();
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = reference.trim().length >= 4 && online;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || !ctx?.user) return;
    setBusy(true);
    try {
      await markPeriodFiled(getSupabase(), {
        shopId: active!.shop.id, taxTypeKey: period.taxTypeKey, periodStart: period.periodStart, periodEnd: period.periodEnd,
        reference, evidenceNote: note.trim() || null, filedBy: ctx.user.id,
        figures: figures ? { basisAmount: figures.basisAmount, estimate: figures.estimate, verified: figures.verified, computedAt: new Date().toISOString() } : {},
      });
      notifySuccess(`${taxTypeName} · ${periodLabel(period)} marked as filed`, { description: "That period is now locked. Corrections go through amendments." });
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Mark {taxTypeName} · {periodLabel(period)} as filed</DialogTitle>
            <DialogDescription>
              Enter the reference the portal gave you when you submitted. This locks the period: no sale, purchase or expense inside it can change without a visible amendment.
            </DialogDescription>
          </DialogHeader>
          {figures && (
            <div className="rounded-[10px] bg-muted p-3 text-small grid gap-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">{figures.basisLabel}</span><b className="tabular">{naira(figures.basisAmount)}</b></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Estimated {taxTypeName}</span><b className="tabular">{figures.estimate === null ? "—" : naira(figures.estimate)}</b></div>
              {!figures.verified && <div className="text-caption text-status-amber pt-1">Draft rules — the figures above are stored with the filing as estimates.</div>}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="ref">Reference number (DIN or receipt)</Label>
            <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. DIN-2026-000123" autoFocus required className="font-mono" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ev">Evidence note <span className="text-muted-foreground font-normal">(optional — where the screenshot/receipt is kept)</span></Label>
            <Input id="ev" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </div>
          {!online && <Alert tone="info" title="Needs a connection">Marking a period as filed locks it on the server, so it waits until you're online.</Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !ok}>{busy ? "Saving…" : "Mark as filed & lock"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
