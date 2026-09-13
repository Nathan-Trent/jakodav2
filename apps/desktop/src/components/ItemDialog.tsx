import { useCallback, useEffect, useState, type FormEvent } from "react";
import { IconBarcode, IconPrinter, IconSparkles, IconTrash } from "@tabler/icons-react";
import type { BarcodeRow, ItemRow } from "@zogal/shared";
import { formatNaira, fromKobo, toKobo } from "@zogal/shared";
import { addManufacturerBarcode, generateBarcode, isValidEan13, removeBarcode, setItemPrices } from "@zogal/inventory-batches";
import { Alert, ConfirmDialog, Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, NumberField, Label, Separator, notifyError, notifySuccess } from "@zogal/ui";
import { printLabels, type LabelLayout } from "@/lib/labels";
import { useSession } from "@/lib/session";
import { useOnline } from "@/lib/useOnline";
import { getSupabase } from "@/lib/supabase";

/**
 * Item detail: barcodes (generate / attach / remove / print) and selling
 * prices (logged change). Cost price is never edited here — batches are
 * immutable; corrections live under Purchases.
 */
export function ItemDialog({ item, onOpenChange, onChanged }: { item: ItemRow | null; onOpenChange: (o: boolean) => void; onChanged: () => Promise<void> }) {
  const { active } = useSession();
  const online = useOnline();
  const perms = active!.permissions;
  const canEditItems = perms.includes("items.create");
  const canEditPrices = perms.includes("items.edit");
  const canEditFloor = perms.includes("items.edit_floor_price");

  const [codes, setCodes] = useState<BarcodeRow[]>([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [toRemove, setToRemove] = useState<BarcodeRow | null>(null);
  const [floor, setFloor] = useState("");
  const [suggested, setSuggested] = useState("");
  const [reason, setReason] = useState("");
  const [copies, setCopies] = useState("1");
  const [layout, setLayout] = useState<LabelLayout>("sheet");

  const loadCodes = useCallback(async () => {
    if (!item) return;
    const { data, error } = await getSupabase().from("barcodes").select<"*", BarcodeRow>().eq("item_id", item.id).order("created_at");
    if (error) { notifyError(error); return; }
    setCodes(data);
  }, [item]);

  useEffect(() => {
    if (!item) return;
    setFloor(fromKobo(toKobo(item.floor_price)));
    setSuggested(fromKobo(toKobo(item.suggested_price)));
    setReason("");
    setManual("");
    void loadCodes();
  }, [item, loadCodes]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  if (!item) return null;
  const db = getSupabase();
  const shop = active!.shop;
  const manualOk = manual.trim().length >= 4;
  const manualLooksEan = /^\d{13}$/.test(manual.trim());
  const manualEanBad = manualLooksEan && !isValidEan13(manual.trim());
  const primaryCode = codes[0];
  const hasCode = !!primaryCode;

  return (
    <>
      <Dialog open={!!item} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{item.name}</DialogTitle>
            <DialogDescription>Barcodes are unique within {shop.name} only. Cost prices live under Purchases and are never edited here.</DialogDescription>
          </DialogHeader>

          {/* Barcodes */}
          <section className="grid gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-subheading flex items-center gap-2"><IconBarcode size={16} /> Barcodes</h3>
              {canEditItems && (
                <Button size="sm" variant="outline" disabled={busy || hasCode || !online}
                  title={hasCode
                    ? "This item already has a barcode — remove it first to generate a new one"
                    : !online ? "Generating a barcode needs a connection (it must be unique across the shop). Scanning existing codes works offline." : undefined}
                  onClick={() => run(async () => {
                  const row = await generateBarcode(db, item.id);
                  notifySuccess("Barcode generated", { description: `${row.code} — print a label and stick it on the item.` });
                  await loadCodes();
                })}>
                  <IconSparkles size={14} /> Generate
                </Button>
              )}
            </div>
            {codes.length === 0 ? (
              <Alert tone="info" title="No barcode yet">
                Generate one, or type the manufacturer's code from the packaging below.
              </Alert>
            ) : (
              <ul className="grid gap-1.5">
                {codes.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 rounded-[10px] border px-3 py-2">
                    <span className="font-mono text-small flex-1">{c.code}</span>
                    <Badge variant="secondary">{c.source === "generated" ? "Generated" : "Manufacturer"}</Badge>
                    {canEditItems && (
                      <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Remove barcode" onClick={() => setToRemove(c)}>
                        <IconTrash size={14} />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEditItems && hasCode && (
              <p className="text-caption text-muted-foreground">
                An item carries exactly one barcode, so labels never disagree. To change it, remove the current code first — then you can generate or attach another.
              </p>
            )}
            {canEditItems && !hasCode && !online && (
              <p className="text-caption text-muted-foreground">
                You're offline. Generating or attaching a barcode needs a connection so it can be checked for uniqueness — scanning existing codes still works.
              </p>
            )}
            {canEditItems && !hasCode && online && (
              <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(async () => {
                await addManufacturerBarcode(db, shop.id, item.id, manual);
                notifySuccess("Barcode attached");
                setManual("");
                await loadCodes();
              }); }}>
                <Input className="font-mono" placeholder="Scan or type the code on the packaging" value={manual} onChange={(e) => setManual(e.target.value)} aria-invalid={manualEanBad} />
                <Button type="submit" variant="secondary" disabled={busy || !manualOk || manualEanBad}>Attach</Button>
              </form>
            )}
            {!hasCode && manualEanBad && <p className="text-caption text-destructive">That 13-digit code fails its check digit — probably a typo.</p>}

            {primaryCode && (
              <div className="flex items-end gap-2 pt-1">
                <div className="grid gap-1">
                  <Label className="text-caption text-muted-foreground">Copies</Label>
                  <NumberField decimals={0} min={1} className="w-20" value={copies} onChange={setCopies} />
                </div>
                <div className="grid gap-1">
                  <Label className="text-caption text-muted-foreground">Layout</Label>
                  <select className="h-9 rounded-md border bg-card px-2 text-sm" value={layout} onChange={(e) => setLayout(e.target.value as LabelLayout)}>
                    <option value="sheet">A4 sheet (38×21 mm, 65 per page)</option>
                    <option value="roll">Label roll (50×30 mm)</option>
                  </select>
                </div>
                <Button variant="outline" onClick={() => printLabels([{ code: primaryCode.code, name: item.name, price: formatNaira(toKobo(item.suggested_price)), copies: Math.max(1, Number(copies) || 1) }], layout, shop.name)}>
                  <IconPrinter size={16} /> Print labels
                </Button>
              </div>
            )}
          </section>

          {canEditPrices && (
            <>
              <Separator />
              <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(async () => {
                await setItemPrices(db, { itemId: item.id, floorPrice: fromKobo(toKobo(floor)), suggestedPrice: fromKobo(toKobo(suggested)), reason: reason.trim() || undefined });
                notifySuccess("Prices updated", { description: "Logged in the price history." });
                await onChanged();
              }); }}>
                <h3 className="text-subheading">Selling prices</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="ed-floor">Floor price (₦)</Label>
                    <NumberField id="ed-floor" prefix="₦" decimals={2} value={floor} onChange={setFloor} disabled={!canEditFloor} />
                    {!canEditFloor && <p className="text-caption text-muted-foreground">Only owners can change the floor.</p>}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="ed-suggested">Suggested price (₦)</Label>
                    <NumberField id="ed-suggested" prefix="₦" decimals={2} value={suggested} onChange={setSuggested} />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ed-reason">Reason <span className="text-muted-foreground font-normal">(optional, kept in history)</span></Label>
                  <Input id="ed-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. supplier price went up" maxLength={200} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy || (floor === fromKobo(toKobo(item.floor_price)) && suggested === fromKobo(toKobo(item.suggested_price)))}>Save prices</Button>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!toRemove}
        onOpenChange={(o) => !o && setToRemove(null)}
        title={`Remove barcode ${toRemove?.code}?`}
        description="Scanning this code will stop finding the item. You can attach it again later."
        confirmLabel="Remove barcode"
        destructive
        onConfirm={async () => { if (!toRemove) return; await removeBarcode(db, toRemove.id); notifySuccess("Barcode removed"); await loadCodes(); }}
      />
    </>
  );
}
