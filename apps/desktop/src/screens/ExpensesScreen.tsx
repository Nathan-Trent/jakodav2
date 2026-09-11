import { useMemo, useState, type FormEvent } from "react";
import { IconCash, IconPlus, IconTrash } from "@tabler/icons-react";
import { formatNaira, fromKobo, toKobo, type Kobo } from "@zogal/shared";
import { findFiledPeriodId, openAmendment, recordExpense, voidExpense, type ExpenseRow } from "@zogal/tax-engine";
import { PageHeader } from "@/components/AppShell";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StaleNotice } from "@/components/StaleNotice";
import { TerminalFilter, useTerminalName } from "@/components/TerminalFilter";
import { PeriodPicker } from "@/components/PeriodPicker";
import { describeRange, resolvePreset, type PeriodRange } from "@/lib/periods";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberField } from "@/components/ui/number-field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import { useSync } from "@/lib/sync";
import { getSupabase } from "@/lib/supabase";
import { useOnline } from "@/lib/useOnline";

const CATEGORIES: { key: string; name: string }[] = [
  { key: "rent", name: "Rent" }, { key: "transport", name: "Transport" }, { key: "staff", name: "Staff" },
  { key: "utilities", name: "Utilities" }, { key: "other", name: "Other" },
];

/**
 * Expenses (PRD §6.4): what the shop spends, by category, so net profit —
 * and therefore income tax — is true rather than gross.
 *
 * Expenses are never edited. A mistake is VOIDED with a reason and re-entered,
 * so the record of what was claimed is never rewritten. An expense dated into
 * a period the owner has already FILED is refused by the database unless it is
 * recorded as an amendment (PRD §5.7) — the dialog walks through that.
 *
 * Online only: a wrongly-dated expense against a filed period is exactly the
 * kind of thing that must be checked against the server at the moment it's
 * entered, not discovered days later on sync.
 */
export function ExpensesScreen() {
  const { ctx, active } = useSession();
  const { data, loading, refresh } = useShopData();
  const { writable } = useSync();
  const online = useOnline();
  const perms = active!.permissions;
  const canRecord = perms.includes("expenses.create");
  const terminalName = useTerminalName();

  const [showAdd, setShowAdd] = useState(false);
  const [toVoid, setToVoid] = useState<ExpenseRow | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodRange>(() => resolvePreset("this_month"));

  // The cached list is the last ~200 expenses; a long period may be
  // incomplete offline, and the notice says so.
  const inPeriod = (e: ExpenseRow) => e.incurred_on >= period.from && e.incurred_on <= period.to;
  const rows = data.expenses.filter((e) => (!terminal || e.device_id === terminal) && inPeriod(e));
  const live = rows.filter((e) => !e.voided_at);
  const periodTotal = useMemo(() => live.reduce((s, e) => s + toKobo(e.amount), 0) as Kobo, [live]);
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of live) m.set(e.category_key, (m.get(e.category_key) ?? 0) + toKobo(e.amount));
    return m;
  }, [live]);
  const periodWord = describeRange(period).toLowerCase();

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Rent, transport, staff and the rest — what turns gross profit into real profit."
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            {canRecord && <Button onClick={() => setShowAdd(true)} disabled={!writable || !online} title={!online ? "Needs a connection" : undefined}><IconPlus size={16} /> Record expense</Button>}
          </>
        }
      />
      <div className="px-8 pb-8 grid gap-4">
        <StaleNotice />
        {!online && canRecord && (
          <Alert tone="info" title="Recording expenses needs a connection">
            Expenses are checked against filed tax periods as you enter them. Your list is still here to read.
          </Alert>
        )}

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Card className="py-5 gap-0 bg-brand-forest text-white border-transparent">
            <CardContent className="px-5 grid gap-1">
              <div className="text-micro text-white/60">{describeRange(period)}</div>
              <div className="figure figure-lg">{formatNaira(periodTotal)}</div>
              <div className="text-caption text-white/60">{live.length} {live.length === 1 ? "expense" : "expenses"}</div>
            </CardContent>
          </Card>
          {CATEGORIES.slice(0, 3).map((c) => (
            <Card key={c.key} className="py-5 gap-0">
              <CardContent className="px-5 grid gap-1">
                <div className="text-micro text-muted-foreground">{c.name} · {periodWord}</div>
                <div className="figure figure-lg">{formatNaira((byCategory.get(c.key) ?? 0) as Kobo)}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="py-0">
          <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
            <div className="text-title">Expenses · {describeRange(period)}</div>
            <TerminalFilter value={terminal} onChange={setTerminal} />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Note</TableHead>
                {!terminal && <TableHead>Terminal</TableHead>}
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="pr-5"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={6} className="pl-5 text-muted-foreground">
                  {loading ? "Loading…" : data.expenses.length === 0 && canRecord ? "No expenses yet. Record rent, transport and staff costs so profit is true." : `No expenses ${periodWord}.`}
                </TableCell></TableRow>
              )}
              {rows.map((e) => (
                <TableRow key={e.id} className={e.voided_at ? "opacity-50" : undefined}>
                  <TableCell className="pl-5 text-muted-foreground">{new Date(e.incurred_on + "T00:00:00").toLocaleDateString()}</TableCell>
                  <TableCell className="font-semibold">{CATEGORIES.find((c) => c.key === e.category_key)?.name ?? e.category_key}</TableCell>
                  <TableCell className="text-muted-foreground max-w-[280px] truncate">
                    {e.note ?? "—"}
                    {e.amendment_id && <Badge variant="warning" className="ml-2">Amendment</Badge>}
                    {e.voided_at && <Badge variant="secondary" className="ml-2" title={e.void_reason ?? undefined}>Voided</Badge>}
                  </TableCell>
                  {!terminal && <TableCell className="text-muted-foreground">{terminalName(e.device_id) ?? "—"}</TableCell>}
                  <TableCell className={`text-right tabular ${e.voided_at ? "line-through" : "font-semibold"}`}>{formatNaira(toKobo(e.amount))}</TableCell>
                  <TableCell className="pr-5 text-right">
                    {canRecord && !e.voided_at && online && (
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setToVoid(e)} title="Void (with a reason)">
                        <IconTrash size={14} />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      {showAdd && (
        <RecordExpenseDialog
          onClose={() => setShowAdd(false)}
          onDone={async () => { setShowAdd(false); await refresh(); }}
        />
      )}

      <ConfirmDialog
        open={!!toVoid}
        onOpenChange={(o) => !o && setToVoid(null)}
        title={`Void this ${formatNaira(toKobo(toVoid?.amount ?? "0"))} expense?`}
        description="It stays in the record marked as voided — nothing is deleted. Re-enter the correct amount afterwards if needed."
        confirmLabel="Void expense"
        destructive
        onConfirm={async () => {
          if (!toVoid || !ctx?.user) return;
          try {
            await voidExpense(getSupabase(), toVoid.id, ctx.user.id, "Voided by " + (ctx.user.full_name ?? "user"));
            notifySuccess("Expense voided");
            await refresh();
          } catch (e) { notifyError(e); }
        }}
      />
    </>
  );
}

function RecordExpenseDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { ctx, active, device } = useSession();
  const shop = active!.shop;
  const canFile = active!.permissions.includes("tax.mark_filed");
  const [category, setCategory] = useState("rent");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState<{ periodId: string; taxTypeKey: string; periodStart: string; periodEnd: string } | null>(null);
  const [amendReason, setAmendReason] = useState("");

  const amt = amount ? toKobo(amount) : null;
  const ok = amt !== null && amt > 0 && !!date;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || !ctx?.user || amt === null) return;
    setBusy(true);
    try {
      const db = getSupabase();
      // Before writing, check whether this date sits in a filed period, so we
      // can explain and offer the amendment path rather than bounce an error.
      if (!locked) {
        const filed = await findFiledPeriodId(db, shop.id, date);
        if (filed) { setLocked({ periodId: filed.id, taxTypeKey: filed.taxTypeKey, periodStart: filed.periodStart, periodEnd: filed.periodEnd }); setBusy(false); return; }
      }
      let amendmentId: string | null = null;
      if (locked) {
        if (!canFile) { notifyError(new Error("permission denied: tax.mark_filed")); setBusy(false); return; }
        amendmentId = await openAmendment(db, { shopId: shop.id, periodId: locked.periodId, reason: amendReason.trim(), createdBy: ctx.user.id });
      }
      await recordExpense(db, {
        shopId: shop.id, categoryKey: category, amount: fromKobo(amt), incurredOn: date,
        note: note.trim() || null, recordedBy: ctx.user.id, deviceId: device?.device_id ?? null, amendmentId,
      });
      notifySuccess(`Recorded ${formatNaira(amt)} ${CATEGORIES.find((c) => c.key === category)?.name.toLowerCase()}`,
        amendmentId ? { description: "Recorded as an amendment to the filed period." } : undefined);
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><IconCash size={18} /> Record an expense</DialogTitle>
            <DialogDescription>Counted against profit for the month it was incurred.</DialogDescription>
          </DialogHeader>

          {locked && (
            <Alert tone="warning" title="That date is in a period you've already filed">
              {locked.periodStart} – {locked.periodEnd} was marked as filed. This expense can still be recorded, but as a visible
              <b> amendment</b> to that period — say why, and it stays on the record.
              {!canFile && " Only an owner can record amendments."}
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ex-cat">Category</Label>
              <select id="ex-cat" className="h-9 rounded-md border bg-card px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-amt">Amount</Label>
              <NumberField id="ex-amt" prefix="₦" decimals={2} value={amount} onChange={setAmount} autoFocus required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ex-date">Date</Label>
              <Input id="ex-date" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => { setDate(e.target.value); setLocked(null); }} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-note">Note <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="ex-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. September rent" maxLength={500} />
            </div>
          </div>
          {locked && canFile && (
            <div className="grid gap-2">
              <Label htmlFor="ex-amend">Reason for the amendment</Label>
              <Input id="ex-amend" value={amendReason} onChange={(e) => setAmendReason(e.target.value)} placeholder="e.g. receipt found after filing" maxLength={300} required />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !ok || (!!locked && (!canFile || amendReason.trim().length < 5))}>
              {busy ? "Saving…" : locked ? "Record as amendment" : "Record expense"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
