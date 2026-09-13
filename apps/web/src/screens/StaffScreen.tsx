import { useMemo, useState, type FormEvent } from "react";
import { IconKey, IconMailForward, IconPlus, IconUserOff, IconUserCheck } from "@tabler/icons-react";
import { PERMISSIONS, SYSTEM_ROLE_IDS, listInvitations, listPermissionOverrides, listRolePermissions, listStaff, type Permission, type StaffRow } from "@zogal/auth-permissions";
import { Alert, Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifySuccess } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useAsync } from "@/lib/useAsync";

/** Plain-language names for the fixed permission list (TRD §5). */
const PERM_LABEL: Record<Permission, string> = {
  "sales.create": "Record sales", "sales.void": "Void a sale", "sales.view_all": "See everyone's sales",
  "customers.manage": "Edit customers",
  "items.create": "Add items", "items.edit": "Edit items and suggested price", "items.edit_floor_price": "Change floor prices",
  "items.view_cost": "See cost prices", "items.view_margin": "See profit and margin",
  "purchases.create": "Record stock received", "purchases.correct_cost": "Correct a batch cost",
  "expenses.create": "Record expenses", "expenses.view": "See expenses",
  "reports.view": "See reports", "reports.view_staff_perf": "See per-person performance",
  "tax.view": "See tax figures", "tax.mark_filed": "Mark tax periods filed",
  "users.manage": "Manage staff", "roles.manage": "Create roles", "shop.settings": "Shop settings",
  "overrides.approve": "Approve manager overrides",
};

/**
 * Staff: who works here, what they may do. Roles carry the bulk; per-person
 * overrides (PRD §4) grant or revoke one permission without a new role.
 * Invitations are by email — the person signs up (or in) with that address
 * and joins automatically (accept_my_invitations, Stage 2).
 */
export function StaffScreen() {
  const { ctx, active, auth } = useSession();
  const shop = active!.shop;
  const canRoles = active!.permissions.includes("roles.manage");
  const db = getSupabase();

  const staff = useAsync(() => listStaff(db, shop.id), [shop.id]);
  const invites = useAsync(() => listInvitations(db, shop.id), [shop.id]);
  const roles = useAsync(() => auth.listRoles(shop.id), [shop.id]);
  const overrides = useAsync(() => listPermissionOverrides(db, shop.id), [shop.id]);
  const rolePerms = useAsync(async () => listRolePermissions(db, (roles.data ?? []).map((r) => r.id)), [roles.data]);

  const [showInvite, setShowInvite] = useState(false);
  const [showRole, setShowRole] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [toggle, setToggle] = useState<StaffRow | null>(null);
  const [pin, setPin] = useState<{ pin: string; expires_at: string } | null>(null);

  const reloadAll = () => Promise.all([staff.reload(), invites.reload(), roles.reload(), overrides.reload()]);
  const roleName = (id: string) => roles.data?.find((r) => r.id === id)?.name ?? "—";
  const ownerCount = (staff.data ?? []).filter((s) => s.is_active && s.role_id === SYSTEM_ROLE_IDS.owner).length;

  async function showMyPin() {
    try { setPin(await auth.getMyManagerPin(shop.id)); } catch (e) { notifyError(e); }
  }

  return (
    <>
      <PageHeader title="Staff" description="Who works here and what each person may do."
        actions={<>
          {(active!.role.id === SYSTEM_ROLE_IDS.owner || active!.role.id === SYSTEM_ROLE_IDS.manager) && <Button variant="outline" onClick={() => void showMyPin()}><IconKey size={16} /> My manager PIN</Button>}
          {canRoles && <Button variant="outline" onClick={() => setShowRole(true)}>New role</Button>}
          <Button onClick={() => setShowInvite(true)}><IconPlus size={16} /> Invite</Button>
        </>} />
      <Page>
        {staff.error && <Alert tone="warning" title="Couldn't load staff">{staff.error}</Alert>}
        <Card className="py-0">
          <div className="px-5 pt-4 pb-2 text-title">{(staff.data ?? []).filter((s) => s.is_active).length} people</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="pl-5">Name</TableHead><TableHead>Role</TableHead><TableHead>Extras</TableHead><TableHead className="pr-5"></TableHead></TableRow></TableHeader>
              <TableBody>
                {(staff.data ?? []).map((s) => {
                  const ov = (overrides.data ?? []).filter((o) => o.user_id === s.user_id);
                  const me = s.user_id === ctx?.user?.id;
                  const lastOwner = s.role_id === SYSTEM_ROLE_IDS.owner && ownerCount <= 1;
                  return (
                    <TableRow key={s.user_id} className={s.is_active ? undefined : "opacity-60"}>
                      <TableCell className="pl-5">
                        <div className="font-semibold">{s.users?.full_name ?? "—"}{me && <span className="text-caption text-muted-foreground font-normal"> · you</span>}</div>
                        <div className="text-caption text-muted-foreground">{s.users?.email}</div>
                      </TableCell>
                      <TableCell>
                        <select className="h-9 rounded-md border bg-card px-2 text-sm" value={s.role_id} disabled={!s.is_active || lastOwner}
                          title={lastOwner ? "The last owner can't be changed" : undefined}
                          onChange={async (e) => { try { await auth.setMemberRole(shop.id, s.user_id, e.target.value); notifySuccess(`${s.users?.full_name} is now ${roleName(e.target.value)}`); await reloadAll(); } catch (err) { notifyError(err); } }}>
                          {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                        {!s.is_active && <Badge variant="secondary" className="ml-2">Deactivated</Badge>}
                      </TableCell>
                      <TableCell className="text-caption text-muted-foreground">
                        {ov.length === 0 ? "—" : ov.map((o) => <Badge key={o.permission_key} variant={o.allowed ? "success" : "warning"} className="mr-1">{o.allowed ? "+" : "−"} {PERM_LABEL[o.permission_key]}</Badge>)}
                      </TableCell>
                      <TableCell className="pr-5 text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(s)} disabled={!s.is_active}>Permissions</Button>
                        {!me && !lastOwner && (
                          <Button variant="ghost" size="sm" className={s.is_active ? "text-muted-foreground hover:text-destructive" : ""} onClick={() => setToggle(s)} title={s.is_active ? "Deactivate" : "Reactivate"}>
                            {s.is_active ? <IconUserOff size={14} /> : <IconUserCheck size={14} />}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>

        {(invites.data ?? []).length > 0 && (
          <Card className="py-4"><CardContent className="px-5 grid gap-2">
            <div className="text-title">Waiting to join</div>
            <ul className="divide-y">
              {invites.data!.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                  <span><span className="font-medium">{i.email}</span> <span className="text-caption text-muted-foreground">as {roleName(i.role_id)} · expires {new Date(i.expires_at).toLocaleDateString()}</span></span>
                  <Button variant="ghost" size="sm" onClick={async () => { try { await auth.revokeInvitation(i.id); await invites.reload(); } catch (e) { notifyError(e); } }}>Cancel</Button>
                </li>
              ))}
            </ul>
            <p className="text-caption text-muted-foreground flex items-center gap-1"><IconMailForward size={14} /> They sign up at the desktop app or here with this email and join automatically.</p>
          </CardContent></Card>
        )}

        {roles.data && (
          <Card className="py-4"><CardContent className="px-5 grid gap-2">
            <div className="text-title">Roles</div>
            <ul className="divide-y">
              {roles.data.map((r) => (
                <li key={r.id} className="py-2 grid gap-1">
                  <div className="flex items-center gap-2"><span className="font-medium">{r.name}</span>{r.is_system && <Badge variant="outline">built in</Badge>}</div>
                  <div className="text-caption text-muted-foreground">{(rolePerms.data?.[r.id] ?? []).map((p) => PERM_LABEL[p]).join(" · ") || (r.is_system && r.id === SYSTEM_ROLE_IDS.owner ? "Everything" : "—")}</div>
                </li>
              ))}
            </ul>
          </CardContent></Card>
        )}
      </Page>

      {showInvite && <InviteDialog roles={roles.data ?? []} onClose={() => setShowInvite(false)} onDone={async () => { setShowInvite(false); await invites.reload(); }} />}
      {showRole && <RoleDialog onClose={() => setShowRole(false)} onDone={async () => { setShowRole(false); await roles.reload(); }} />}
      {editing && (
        <PermissionsDialog member={editing} rolePerms={rolePerms.data?.[editing.role_id] ?? []} overrides={(overrides.data ?? []).filter((o) => o.user_id === editing.user_id)}
          onClose={() => setEditing(null)} onChanged={() => overrides.reload()} />
      )}
      <ConfirmDialog open={!!toggle} onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.is_active ? `Deactivate ${toggle.users?.full_name}?` : `Reactivate ${toggle?.users?.full_name}?`}
        description={toggle?.is_active ? "They can no longer sign in to this shop. Their sales history stays." : "They can sign in again with the same role."}
        confirmLabel={toggle?.is_active ? "Deactivate" : "Reactivate"} destructive={!!toggle?.is_active}
        onConfirm={async () => { if (!toggle) return; try { await auth.setMemberActive(shop.id, toggle.user_id, !toggle.is_active); notifySuccess("Done"); setToggle(null); await staff.reload(); } catch (e) { notifyError(e); } }} />
      {pin && (
        <Dialog open onOpenChange={(o) => !o && setPin(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Your manager PIN</DialogTitle><DialogDescription>For approving overrides at the till. It rotates automatically; only you can see it.</DialogDescription></DialogHeader>
            <div className="figure text-[40px] tracking-[0.3em] text-center py-4 tabular">{pin.pin}</div>
            <p className="text-caption text-muted-foreground text-center">Valid until {new Date(pin.expires_at).toLocaleString()}</p>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function InviteDialog({ roles, onClose, onDone }: { roles: { id: string; name: string }[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { ctx, active, auth } = useSession();
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(SYSTEM_ROLE_IDS.salesperson as string);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!ctx?.user) return; setBusy(true);
    try { await auth.invite({ shopId: active!.shop.id, email, roleId, invitedBy: ctx.user.id }); notifySuccess(`Invited ${email}`, { description: "They join when they sign up or sign in with that email." }); await onDone(); }
    catch (err) { notifyError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent><form onSubmit={submit} className="grid gap-4">
        <DialogHeader><DialogTitle>Invite someone</DialogTitle><DialogDescription>They get the role you pick; you can adjust permissions after they join.</DialogDescription></DialogHeader>
        <div className="grid gap-2"><Label htmlFor="inv-email">Email</Label><Input id="inv-email" type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="grid gap-2"><Label htmlFor="inv-role">Role</Label>
          <select id="inv-role" className="h-9 rounded-md border bg-card px-2 text-sm" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !email}>{busy ? "Sending…" : "Invite"}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  );
}

function RoleDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { active, auth } = useSession();
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Set<Permission>>(new Set(["sales.create"]));
  const [busy, setBusy] = useState(false);
  const key = useMemo(() => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "role", [name]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await auth.createCustomRole({ shopId: active!.shop.id, key: /^[a-z]/.test(key) ? key : `r_${key}`, name: name.trim(), permissions: [...perms] }); notifySuccess(`Role “${name.trim()}” created`); await onDone(); }
    catch (err) { notifyError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg"><form onSubmit={submit} className="grid gap-4">
        <DialogHeader><DialogTitle>New role</DialogTitle><DialogDescription>Pick from the fixed list of permissions. Built-in roles can't be changed; make a new one instead.</DialogDescription></DialogHeader>
        <div className="grid gap-2"><Label htmlFor="role-name">Name</Label><Input id="role-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Senior cashier" /></div>
        <div className="grid sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto">
          {PERMISSIONS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-small"><input type="checkbox" checked={perms.has(p)} onChange={(e) => setPerms((s) => { const n = new Set(s); if (e.target.checked) n.add(p); else n.delete(p); return n; })} />{PERM_LABEL[p]}</label>
          ))}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || perms.size === 0}>{busy ? "Saving…" : "Create role"}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  );
}

function PermissionsDialog({ member, rolePerms, overrides, onClose, onChanged }: {
  member: StaffRow; rolePerms: Permission[]; overrides: { permission_key: Permission; allowed: boolean }[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { active, auth } = useSession();
  const [busy, setBusy] = useState<Permission | null>(null);
  const isOwner = member.role_id === SYSTEM_ROLE_IDS.owner;
  const state = (p: Permission): "role" | "granted" | "revoked" | "no" => {
    const o = overrides.find((x) => x.permission_key === p);
    if (o) return o.allowed ? "granted" : "revoked";
    return rolePerms.includes(p) || isOwner ? "role" : "no";
  };
  async function set(p: Permission, allowed: boolean | null) {
    setBusy(p);
    try { await auth.setPermissionOverride(active!.shop.id, member.user_id, p, allowed); await onChanged(); }
    catch (e) { notifyError(e); } finally { setBusy(null); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{member.users?.full_name} — permissions</DialogTitle><DialogDescription>Their role ({member.roles?.name}) sets the defaults. Add or remove one thing here without changing the role.</DialogDescription></DialogHeader>
        <ul className="divide-y max-h-[60vh] overflow-y-auto">
          {PERMISSIONS.map((p) => {
            const s = state(p);
            const has = s === "role" || s === "granted";
            return (
              <li key={p} className="flex items-center justify-between gap-3 py-2">
                <span className="text-small">{PERM_LABEL[p]}{s === "granted" && <Badge variant="success" className="ml-2">added</Badge>}{s === "revoked" && <Badge variant="warning" className="ml-2">removed</Badge>}</span>
                <span className="flex gap-1">
                  {(s === "granted" || s === "revoked") && <Button size="sm" variant="ghost" disabled={busy === p} onClick={() => void set(p, null)}>Use role</Button>}
                  <Button size="sm" variant={has ? "outline" : "default"} disabled={busy === p || isOwner} onClick={() => void set(p, !has)}>{has ? "Remove" : "Add"}</Button>
                </span>
              </li>
            );
          })}
        </ul>
        {isOwner && <p className="text-caption text-muted-foreground">Owners have everything; nothing to adjust.</p>}
      </DialogContent>
    </Dialog>
  );
}
