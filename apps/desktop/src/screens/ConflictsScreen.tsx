import { useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconCheck, IconRefresh } from "@tabler/icons-react";
import { listConflicts, resolveConflict, type SyncConflictRow } from "@zogal/sync";
import { PageHeader } from "@/components/AppShell";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

/**
 * SYNC: conflicts raised when offline work met a different reality on the
 * server (TRD §7 — surfaced, never silently resolved).
 *
 * Nothing here changes data. The sale already happened and is recorded; this
 * is where the owner sees what didn't add up and says what they did about it.
 */
export function ConflictsScreen() {
  const { ctx, active } = useSession();
  const shop = active!.shop;
  const [rows, setRows] = useState<SyncConflictRow[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState<SyncConflictRow | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await listConflicts(getSupabase(), shop.id, showResolved)); }
    catch (e) { notifyError(e); }
    finally { setLoading(false); }
  }, [shop.id, showResolved]);
  useEffect(() => { void load(); }, [load]);

  const open = rows.filter((r) => !r.resolved_at);

  return (
    <>
      <PageHeader
        title="Sync issues"
        description="Where offline work met a different reality on the server. The sales are recorded either way."
        actions={
          <>
            <Button variant="outline" onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? "Hide resolved" : "Show resolved"}
            </Button>
            <Button variant="outline" onClick={() => void load()}><IconRefresh size={16} /> Refresh</Button>
          </>
        }
      />
      <div className="px-8 pb-8 grid gap-4">
        {!loading && open.length === 0 && !showResolved && (
          <Alert tone="success" title="Nothing to resolve">
            Every sale recorded offline matched the server's stock when it synced.
          </Alert>
        )}
        {rows.map((r) => (
          <Card key={r.id} className={r.resolved_at ? "opacity-60" : undefined}>
            <CardContent className="grid gap-2">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="size-9 shrink-0 rounded-full bg-status-amber/10 text-status-amber grid place-items-center">
                    <IconAlertTriangle size={18} />
                  </div>
                  <div className="grid gap-0.5">
                    <div className="text-subheading">{headline(r)}</div>
                    <div className="text-small text-muted-foreground">{explain(r)}</div>
                    <div className="text-caption text-muted-foreground">
                      Happened {new Date(r.occurred_at).toLocaleString()} · found on sync {new Date(r.detected_at).toLocaleString()}
                    </div>
                  </div>
                </div>
                {r.resolved_at ? (
                  <Badge variant="success"><IconCheck size={12} /> Resolved</Badge>
                ) : (
                  <Button size="sm" onClick={() => setResolving(r)}>Mark resolved</Button>
                )}
              </div>
              {r.resolution && <p className="text-caption text-muted-foreground border-t pt-2">“{r.resolution}”</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!resolving} onOpenChange={(o) => !o && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as resolved</DialogTitle>
            <DialogDescription>
              This records what you did — it doesn't change any sale or stock figure.
              If stock was never entered, add the missing purchase under Purchases first.
            </DialogDescription>
          </DialogHeader>
          <ResolveForm
            onSubmit={async (note) => {
              if (!resolving || !ctx?.user) return;
              try {
                await resolveConflict(getSupabase(), resolving.id, ctx.user.id, note);
                notifySuccess("Marked resolved");
                setResolving(null);
                await load();
              } catch (e) { notifyError(e); }
            }}
            onCancel={() => setResolving(null)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResolveForm({ onSubmit, onCancel }: { onSubmit: (note: string) => Promise<void>; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = note.trim().length >= 4;
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSubmit(note.trim()); } finally { setBusy(false); } }}
    >
      <div className="grid gap-2">
        <Label htmlFor="res">What did you do?</Label>
        <Input id="res" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. added the missing delivery from Monday" maxLength={300} autoFocus />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || !ok}>Save</Button>
      </DialogFooter>
    </form>
  );
}

function headline(r: SyncConflictRow): string {
  const name = (r.detail.item_name as string) ?? "An item";
  switch (r.kind) {
    case "stock_shortfall": return `${name} sold without enough stock on record`;
    case "below_floor": return `${name} sold below its floor price`;
    case "duplicate_sale": return "The same sale arrived twice";
    default: return "Sync issue";
  }
}

function explain(r: SyncConflictRow): string {
  switch (r.kind) {
    case "stock_shortfall": {
      const sold = r.detail.quantity_sold as number;
      const un = r.detail.unattributed as number;
      return `${sold} sold, but ${un} had no batch left to cost against — another terminal may have sold the same stock offline, or a delivery was never entered. The sale is recorded; profit for those ${un} is unknown until you add the missing purchase.`;
    }
    case "below_floor":
      return `Sold at ₦${r.detail.unit_price} when the floor was ₦${r.detail.floor_at_sale}. The sale stands as it happened.`;
    case "duplicate_sale":
      return "The terminal sent the same sale twice; only one was kept.";
    default:
      return JSON.stringify(r.detail);
  }
}
