import { useMemo, useState, type FormEvent } from "react";
import { IconArrowLeft, IconPencil, IconPlus, IconSearch, IconUserOff } from "@tabler/icons-react";
import type { CustomerRow } from "@zogal/shared";
import { createCustomer, normalisePhone, updateCustomer } from "@zogal/inventory-batches";
import { PageHeader } from "@/components/AppShell";
import { Alert, ConfirmDialog, Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notifyError, notifySuccess } from "@zogal/ui";
import { StaleNotice } from "@/components/StaleNotice";
import { useSession } from "@/lib/session";
import { useShopData } from "@/lib/shopData";
import { getSupabase } from "@/lib/supabase";
import { useOnline } from "@/lib/useOnline";
import { SalesScreen } from "@/screens/SalesScreen";

/**
 * Customers (0012): the shop's list of known buyers. A contact record and
 * a purchase history — nothing more. Adding at the till is on the Sell
 * screen; this is where the list is looked after.
 *
 * Adding/editing needs a connection (a phone number must be unique per
 * shop, and that's checked by the database). The list itself is in the
 * working set, so it reads offline.
 */
export function CustomersScreen() {
  const { active } = useSession();
  const { data, refresh } = useShopData();
  const online = useOnline();
  const perms = active!.permissions;
  const canManage = perms.includes("customers.manage");
  const canAdd = canManage || perms.includes("sales.create");

  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<CustomerRow | "new" | null>(null);
  const [toDeactivate, setToDeactivate] = useState<CustomerRow | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = normalisePhone(q);
    return data.customers
      .filter((c) => showInactive || c.is_active)
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (digits.length >= 3 && c.phone?.includes(digits)));
  }, [data.customers, q, showInactive]);

  const open = openId ? data.customers.find((c) => c.id === openId) : null;
  if (open) {
    return (
      <>
        <PageHeader
          title={open.name}
          description={[open.phone, open.note].filter(Boolean).join(" · ") || "No phone or note"}
          actions={
            <>
              <Button variant="outline" onClick={() => setOpenId(null)}><IconArrowLeft size={16} /> All customers</Button>
              {canManage && <Button variant="outline" onClick={() => setEditing(open)} disabled={!online}><IconPencil size={16} /> Edit</Button>}
            </>
          }
        />
        <div className="px-8 pb-8 grid gap-4">
          <StaleNotice />
          {!open.is_active && <Alert tone="info" title="This customer is deactivated">They won't appear at the till. Their history is kept.</Alert>}
          {open.id.startsWith("pending:")
            ? <Alert tone="info" title="Added on this terminal while offline">Their purchases will show here once the sale uploads.</Alert>
            : <SalesScreen customerId={open.id} embedded />}
        </div>
        {editing && editing !== "new" && <CustomerDialog customer={editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await refresh(); }} />}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Customers"
        description="Optional on every sale. Attach a customer at the till to build their history."
        actions={canAdd && <Button onClick={() => setEditing("new")} disabled={!online} title={!online ? "Needs a connection" : undefined}><IconPlus size={16} /> Add customer</Button>}
      />
      <div className="px-8 pb-8 grid gap-4">
        <StaleNotice />
        <Card className="py-0">
          <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-title">{list.length} {list.length === 1 ? "customer" : "customers"}</div>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-small text-muted-foreground">
                <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated
              </label>
              <label className="relative">
                <IconSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-9 pl-8 w-[220px]" placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="pr-5"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 && (
                <TableRow><TableCell colSpan={4} className="pl-5 text-muted-foreground">
                  {data.customers.length === 0 ? "No customers yet. Add one here, or at the till when recording a sale." : `No one matches “${q}”.`}
                </TableCell></TableRow>
              )}
              {list.map((c) => (
                <TableRow key={c.id} className={c.is_active ? "cursor-pointer" : "opacity-60 cursor-pointer"} onClick={() => setOpenId(c.id)}>
                  <TableCell className="pl-5 font-semibold">
                    {c.name}
                    {!c.is_active && <Badge variant="secondary" className="ml-2">Deactivated</Badge>}
                    {c.id.startsWith("pending:") && <Badge variant="warning" className="ml-2">Not yet uploaded</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.phone ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground max-w-[320px] truncate">{c.note ?? "—"}</TableCell>
                  <TableCell className="pr-5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {canManage && !c.id.startsWith("pending:") && (
                      <>
                        <Button variant="ghost" size="sm" disabled={!online} onClick={() => setEditing(c)} title="Edit"><IconPencil size={14} /></Button>
                        {c.is_active && <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={!online} onClick={() => setToDeactivate(c)} title="Deactivate"><IconUserOff size={14} /></Button>}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      {editing && <CustomerDialog customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await refresh(); }} />}

      <ConfirmDialog
        open={!!toDeactivate}
        onOpenChange={(o) => !o && setToDeactivate(null)}
        title={`Deactivate ${toDeactivate?.name ?? "this customer"}?`}
        description="They stop appearing at the till. Nothing is deleted — their purchase history stays, and you can reactivate them by editing."
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => {
          if (!toDeactivate) return;
          try {
            await updateCustomer(getSupabase(), { id: toDeactivate.id, name: toDeactivate.name, phone: toDeactivate.phone, note: toDeactivate.note, isActive: false });
            notifySuccess(`${toDeactivate.name} deactivated`);
            setToDeactivate(null);
            await refresh();
          } catch (e) { notifyError(e); }
        }}
      />
    </>
  );
}

function CustomerDialog({ customer, onClose, onDone }: { customer: CustomerRow | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { ctx, active } = useSession();
  const { data } = useShopData();
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [note, setNote] = useState(customer?.note ?? "");
  const [isActive, setIsActive] = useState(customer?.is_active ?? true);
  const [busy, setBusy] = useState(false);

  const phoneClean = normalisePhone(phone);
  const phoneOk = phoneClean === "" || /^\+?[0-9]{7,15}$/.test(phoneClean);
  const dup = phoneClean ? data.customers.find((c) => c.phone === phoneClean && c.id !== customer?.id) : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ctx?.user || !name.trim() || !phoneOk || dup) return;
    setBusy(true);
    try {
      if (customer) {
        await updateCustomer(getSupabase(), { id: customer.id, name: name.trim(), phone: phoneClean || null, note: note.trim() || null, isActive });
        notifySuccess("Customer updated");
      } else {
        await createCustomer(getSupabase(), { shopId: active!.shop.id, name: name.trim(), phone: phoneClean || null, note: note.trim() || null, createdBy: ctx.user.id });
        notifySuccess(`Added ${name.trim()}`);
      }
      await onDone();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{customer ? `Edit ${customer.name}` : "New customer"}</DialogTitle>
            <DialogDescription>A name is enough. A phone number helps the till find them quickly.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="c-name">Name</Label>
            <Input id="c-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-phone">Phone <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="c-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!phoneOk || !!dup} />
            {!phoneOk && <p className="text-caption text-status-red">Digits only, 7–15 long.</p>}
            {dup && <p className="text-caption text-status-amber">That number already belongs to {dup.name}.</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-note">Note <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="c-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Buys for her shop in Ojuelegba" />
          </div>
          {customer && (
            <label className="inline-flex items-center gap-2 text-small">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active (shows at the till)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim() || !phoneOk || !!dup}>{busy ? "Saving…" : customer ? "Save" : "Add customer"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
