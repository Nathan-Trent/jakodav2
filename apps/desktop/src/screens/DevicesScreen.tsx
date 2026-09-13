import { useCallback, useEffect, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import type { DeviceStatusRow } from "@zogal/auth-permissions";
import { PageHeader } from "@/components/AppShell";
import { Alert, ConfirmDialog, Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifySuccess } from "@zogal/ui";
import { useSession } from "@/lib/session";

/** Owner view of activated terminals (TRD §1 device status). */
export function DevicesScreen() {
  const { auth, active, device } = useSession();
  const shop = active!.shop;
  const [rows, setRows] = useState<DeviceStatusRow[]>([]);
  const [toRevoke, setToRevoke] = useState<DeviceStatusRow | null>(null);

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
        actions={<Button variant="outline" onClick={() => void load()}><IconRefresh size={16} /> Refresh</Button>} />
      <div className="px-8 pb-8 grid gap-6">
        {activeRows.length === 0 ? (
          <Alert tone="info" title="No active terminals">Activate a terminal from its setup screen, or generate an activation code from the dashboard (stage 8).</Alert>
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
                      {r.name}{device?.device_id === r.id && <span className="text-caption text-muted-foreground font-normal"> · this terminal</span>}
                    </TableCell>
                    <TableCell>{r.is_online ? <Badge variant="success">Online</Badge> : <Badge variant="secondary">Offline</Badge>}</TableCell>
                    <TableCell className="text-muted-foreground">{r.last_sync_at ? new Date(r.last_sync_at).toLocaleString() : "Never (sync arrives in stage 5)"}</TableCell>
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
        description={
          toRevoke && device?.device_id === toRevoke.id
            ? "This is the terminal you're using now. It will be signed out of selling and need a new activation code."
            : "It will stop being able to record sales until someone activates it again with a new code. Past sales are kept."
        }
        confirmLabel="Revoke terminal"
        destructive
        onConfirm={() => toRevoke ? revoke(toRevoke) : undefined}
      />
    </>
  );
}
