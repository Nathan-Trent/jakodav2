import { useCallback, useEffect, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { toast } from "sonner";
import type { DeviceStatusRow } from "@jakoda/auth-permissions";
import { PageHeader } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, useSession } from "@/lib/session";

/** Owner view of activated terminals (TRD §1 device status). */
export function DevicesScreen() {
  const { auth, active, device } = useSession();
  const shop = active!.shop;
  const [rows, setRows] = useState<DeviceStatusRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await auth.listDevices(shop.id)); } catch (e) { toast.error(errorMessage(e)); }
  }, [auth, shop.id]);
  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    if (!confirm("Revoke this terminal? It will need a new activation code to sell again.")) return;
    setBusy(true);
    try { await auth.revokeDevice(id); toast.success("Terminal revoked"); await load(); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const activeRows = rows.filter((r) => !r.revoked_at);
  const revokedRows = rows.filter((r) => r.revoked_at);

  return (
    <>
      <PageHeader title="Terminals" description="Desktop installs bound to this shop. Online = synced in the last 5 minutes."
        actions={<Button variant="outline" onClick={() => void load()}><IconRefresh size={16} /> Refresh</Button>} />
      <div className="px-8 pb-8 grid gap-6">
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
              {activeRows.length === 0 && (
                <TableRow><TableCell colSpan={4} className="pl-5 text-muted-foreground">No active terminals.</TableCell></TableRow>
              )}
              {activeRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5 font-semibold">
                    {r.name}{device?.device_id === r.id && <span className="text-caption text-muted-foreground font-normal"> · this terminal</span>}
                  </TableCell>
                  <TableCell>{r.is_online ? <Badge variant="success">Online</Badge> : <Badge variant="secondary">Offline</Badge>}</TableCell>
                  <TableCell className="text-muted-foreground">{r.last_sync_at ? new Date(r.last_sync_at).toLocaleString() : "Never (sync arrives in stage 5)"}</TableCell>
                  <TableCell className="pr-5 text-right">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(r.id)} className="text-destructive hover:text-destructive">Revoke</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        {revokedRows.length > 0 && (
          <div className="text-caption text-muted-foreground">
            {revokedRows.length} revoked {revokedRows.length === 1 ? "terminal" : "terminals"} hidden.
          </div>
        )}
      </div>
    </>
  );
}
