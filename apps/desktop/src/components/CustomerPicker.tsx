import { useEffect, useMemo, useState } from "react";
import { IconUser, IconUserPlus, IconX } from "@tabler/icons-react";
import { normalisePhone } from "@zogal/inventory-batches";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, cn } from "@zogal/ui";
import { useShopData } from "@/lib/shopData";
import type { OfflineCustomerRef } from "@/lib/shopView";

/**
 * "Who is this sale for?" — optional, one tap, never in the way of selling.
 *
 * Shows "Walk-in" until changed. The picker searches the cached customer
 * list by name or phone (works offline) and offers "Add new" with two
 * fields. The choice is returned as a reference the checkout resolves:
 * {id, name} for a known customer, {name, phone} for one added right now
 * (SYNC: created on the server at checkout when online, or carried in the
 * queued sale and created on replay when offline — see 0012).
 */
export function CustomerPicker({ value, onChange, disabled }: {
  value: OfflineCustomerRef | null;
  onChange: (v: OfflineCustomerRef | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2 rounded-[10px] border px-3 py-2">
        <IconUser size={16} className="text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-micro text-muted-foreground">Customer</div>
          <div className={cn("text-small font-medium truncate", !value && "text-muted-foreground font-normal")}>
            {value ? value.name : "Walk-in"}
          </div>
        </div>
        {value && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Remove customer" disabled={disabled} onClick={() => onChange(null)}>
            <IconX size={14} />
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>{value ? "Change" : "Add"}</Button>
      </div>
      {open && <CustomerSearchDialog onClose={() => setOpen(false)} onPick={(c) => { onChange(c); setOpen(false); }} />}
    </>
  );
}

export function CustomerSearchDialog({ onClose, onPick }: { onClose: () => void; onPick: (c: OfflineCustomerRef) => void }) {
  const { data } = useShopData();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = normalisePhone(q);
    const list = data.customers.filter((c) => c.is_active);
    if (!needle) return list.slice(0, 8);
    return list
      .filter((c) => c.name.toLowerCase().includes(needle) || (digits.length >= 3 && c.phone?.includes(digits)))
      .slice(0, 8);
  }, [q, data.customers]);

  // Typing a name with no match → "Add" pre-fills from the search box.
  useEffect(() => { if (adding && !name) setName(/\d{3,}/.test(q) ? "" : q.trim()); }, [adding, name, q]);
  useEffect(() => { if (adding && !phone && /\d{3,}/.test(q)) setPhone(normalisePhone(q)); }, [adding, phone, q]);

  const phoneClean = normalisePhone(phone);
  const phoneOk = phoneClean === "" || /^\+?[0-9]{7,15}$/.test(phoneClean);
  const dupPhone = phoneClean && data.customers.find((c) => c.phone === phoneClean);

  function pickExisting(c: (typeof data.customers)[number]) {
    // A customer added offline on this terminal has no server id yet;
    // carry name+phone so replay resolves it to the same record.
    if (c.id.startsWith("pending:")) onPick({ name: c.name, phone: c.phone });
    else onPick({ id: c.id, name: c.name });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Customer</DialogTitle>
          <DialogDescription>Optional. Attach a customer so their purchases can be looked up later.</DialogDescription>
        </DialogHeader>
        {!adding ? (
          <div className="grid gap-3">
            <Input autoFocus placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
            <ul className="divide-y rounded-[10px] border max-h-64 overflow-y-auto">
              {matches.map((c) => (
                <li key={c.id}>
                  <button type="button" className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-3" onClick={() => pickExisting(c)}>
                    <span className="flex-1 min-w-0">
                      <span className="block text-small font-medium truncate">{c.name}</span>
                      {c.phone && <span className="block text-caption text-muted-foreground">{c.phone}</span>}
                    </span>
                    {c.id.startsWith("pending:") && <span className="text-micro text-status-amber">not yet uploaded</span>}
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="px-3 py-3 text-small text-muted-foreground">
                  {data.customers.length === 0 ? "No customers yet." : `No one matches “${q}”.`}
                </li>
              )}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="button" onClick={() => setAdding(true)}><IconUserPlus size={16} /> Add new customer</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && phoneOk && !dupPhone) onPick({ name: name.trim(), phone: phoneClean || null }); }}>
            <div className="grid gap-2">
              <Label htmlFor="cp-name">Name</Label>
              <Input id="cp-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cp-phone">Phone <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="cp-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!phoneOk || !!dupPhone} />
              {!phoneOk && <p className="text-caption text-status-red">Digits only, 7–15 long.</p>}
              {dupPhone && (
                <p className="text-caption text-status-amber">
                  That number belongs to {dupPhone.name}.{" "}
                  <button type="button" className="underline" onClick={() => pickExisting(dupPhone)}>Use them</button>
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>Back</Button>
              <Button type="submit" disabled={!name.trim() || !phoneOk || !!dupPhone}>Use this customer</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
