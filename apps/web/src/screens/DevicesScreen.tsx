import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
import type { DeviceStatusRow } from "@zogal/auth-permissions";
import { PageHeader } from "@/components/Shell";
import { Alert, ConfirmDialog, Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifySuccess } from "@zogal/ui";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

/** Owner view of activated terminals (TRD §1 device status). */
export function DevicesScreen() {
  const { auth, active } = useSession();
  const shop = active!.shop;
  const [rows, setRows] = useState<DeviceStatusRow[]>([]);
  const [toRevoke, setToRevoke] = useState<DeviceStatusRow | null>(null);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);

  const [renaming, setRenaming] = useState<DeviceStatusRow | null>(null);
  const [newName, setNewName] = useState("");
  async function saveName() {
    const name = newName.trim();
    if (!renaming || !name) return;
    try {
      const { error } = await getSupabase().from("devices").update({ name }).eq("id", renaming.id);
      if (error) throw error;
      setRenaming(null);
      await load();
    } catch (e) { notifyError(e); }
  }

  /** TRD §1: a short-lived one-time code, shown once, typed into the desktop on install. */
  async function newCode() {
    try { setCode(await auth.createActivationCode(shop.id)); } catch (e) { notifyError(e); }
  }

  const load = useCallback(async () => {
    try { setRows(await auth.listDevices(shop.id)); } catch (e) { notifyError(e); }
  }, [auth, shop.id]);
  useEffect(() => { void load(); }, [load]);

  async function revoke(r: DeviceStatusRow) {
    try {
      await auth.revokeDevice(r.id);
      notifySuccess(`“${r.name}” revoked`, { description: "It can't record sales until it's activated again." });
      await load();
    } catch (e) { notifyError(e); }
  }

  const activeRows = rows.filter((r) => !r.revoked_at);
  const revokedRows = rows.filter((r) => r.revoked_at);

  return (
    <>
      <PageHeader title="Terminals" description="Desktop installs bound to this shop. Online = synced in the last 5 minutes."
        actions={<><Button variant="outline" onClick={() => void load()}><IconRefresh size={16} /> Refresh</Button><Button onClick={() => void newCode()}><IconPlus size={16} /> Activation code</Button></>} />
      <div className="px-8 pb-8 grid gap-6">
        {activeRows.length === 0 ? (
          <Alert tone="info" title="No active terminals" action={<Button size="sm" onClick={() => void newCode()}>Get a code</Button>}>Install the desktop app on the shop computer, generate a code here, and type it in on the setup screen.</Alert>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Terminal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead className="pr-5 text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-5 font-semibold">
                      <button className="text-left hover:underline" title="Rename" onClick={() => { setRenaming(r); setNewName(r.name); }}>{r.name}</button>
                    </TableCell>
                    <TableCell>{r.is_online ? <Badge variant="success">Online</Badge> : <Badge variant="secondary">Offline</Badge>}</TableCell>
                    <TableCell className="text-muted-foreground">{r.last_sync_at ? new Date(r.last_sync_at).toLocaleString() : "Never"}</TableCell>
                    <TableCell className="pr-5 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setToRevoke(r)} className="text-destructive hover:text-destructive">Revoke</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        {revokedRows.length > 0 && (
          <div className="text-caption text-muted-foreground">
            {revokedRows.length} revoked {revokedRows.length === 1 ? "terminal" : "terminals"} hidden.
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!toRevoke}
        onOpenChange={(o) => !o && setToRevoke(null)}
        title={`Revoke “${toRevoke?.name}”?`}
        description="It will stop being able to record sales until someone activates it again with a new code. Past sales are kept."
        confirmLabel="Revoke terminal"
        destructive
        onConfirm={() => toRevoke ? revoke(toRevoke) : undefined}
      />
      {renaming && (
        <Dialog open onOpenChange={(o) => !o && setRenaming(null)}>
          <DialogContent>
            <form onSubmit={(e) => { e.preventDefault(); void saveName(); }} className="grid gap-4">
              <DialogHeader><DialogTitle>Name this terminal</DialogTitle><DialogDescription>Where it sits, so sales and stock can be told apart — "Front counter", "Back office".</DialogDescription></DialogHeader>
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} />
              <DialogFooter><Button type="button" variant="outline" onClick={() => setRenaming(null)}>Cancel</Button><Button type="submit" disabled={!newName.trim()}>Save</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {code && (
        <Dialog open onOpenChange={(o) => !o && setCode(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Activation code</DialogTitle><DialogDescription>Type this on the desktop app's setup screen. It works once and expires in 10 minutes.</DialogDescription></DialogHeader>
            <div className="figure text-[40px] tracking-[0.25em] text-center py-4 font-mono">{code.code}</div>
            <p className="text-caption text-muted-foreground text-center">Expires {new Date(code.expires_at).toLocaleTimeString()}</p>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
