import { useEffect, useMemo, useRef, useState } from "react";
import { IconCamera, IconPhoto, IconTrash } from "@tabler/icons-react";
import { formatNaira, fromKobo, toKobo, type Kobo } from "@zogal/shared";
import { announceStockChange, closeScan, fetchScanQuota, parseNotebookPage, ScanError, stockChannel, type ParsedPage, type ScanQuota } from "@zogal/inventory-batches";
import { PageHeader } from "@/components/AppShell";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LoadingMark } from "@/components/brand/LoadingMark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";

interface DraftRow {
  key: number;
  itemText: string;
  itemId: string;
  qtyText: string;
  priceText: string;
  confidence: "high" | "medium" | "low";
  note: string | null;
}

/**
 * Notebook photo capture (Stage 7, PRD §5.6): for the shop still writing
 * sales by hand. Photo → the model reads it into DRAFT rows → the cashier
 * checks every row → each confirmed row becomes an ordinary sale through
 * record_sale. Nothing is recorded until "Record". The photo is not kept.
 *
 * Online only, and metered: a monthly free-scan allowance set by Zogal's
 * back office (platform_settings), checked in Postgres before the model is
 * called. The screen always shows how many scans are left (Nielsen #1).
 */
export function NotebookScreen() {
  const { ctx, active, device, inventory } = useSession();
  const { data, stockFor, refresh } = useShopData();
  const { writable } = useSync();
  const online = useOnline();
  const shop = active!.shop;

  const [quota, setQuota] = useState<ScanQuota | null>(null);
  const [phase, setPhase] = useState<"idle" | "parsing" | "review" | "recording">("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [page, setPage] = useState<ParsedPage | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [askDiscard, setAskDiscard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!online) return;
    fetchScanQuota(getSupabase(), shop.id).then(setQuota).catch(() => setQuota(null));
  }, [shop.id, online, phase]);

  async function choose(file: File) {
    if (!online || !writable) return;
    setPhase("parsing");
    try {
      const { base64, dataUrl } = await downscale(file);
      setPreview(dataUrl);
      const { scanId: id, result } = await parseNotebookPage(getSupabase(), {
        shopId: shop.id, deviceId: device?.device_id ?? null, imageBase64: base64, mediaType: "image/jpeg",
      });
      setScanId(id);
      setPage(result);
      setRows(result.rows.map((r, i) => ({
        key: i,
        itemText: r.item_text,
        itemId: r.item_id ?? "",
        qtyText: r.quantity != null ? String(Math.max(1, Math.round(r.quantity))) : "",
        priceText: r.unit_price != null ? fromKobo(Math.round(r.unit_price * 100) as Kobo) : (r.item_id ? fromKobo(toKobo(data.items.find((i) => i.id === r.item_id)?.suggested_price ?? "0")) : ""),
        confidence: r.confidence,
        note: r.note,
      })));
      if (result.page_date && /^\d{4}-\d{2}-\d{2}$/.test(result.page_date)) setDate(result.page_date);
      setPhase("review");
    } catch (e) {
      setPhase("idle");
      setPreview(null);
      if (e instanceof ScanError && e.status === 402) notifyError(new Error("This month's free scans are used up. Zogal can raise the allowance for your shop."));
      else notifyError(e);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function update(key: number, patch: Partial<DraftRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  // Per-row problems, in the cashier's words.
  const problems = useMemo(() => rows.map((r) => {
    if (!r.itemId) return "Choose the item";
    const item = data.items.find((i) => i.id === r.itemId);
    if (!item) return "Item not found";
    const q = Math.floor(Number(r.qtyText));
    if (!r.qtyText || !(q > 0)) return "Quantity?";
    let p: Kobo;
    try { p = toKobo(r.priceText); } catch { return "Price?"; }
    if (!r.priceText) return "Price?";
    if (p < toKobo(item.floor_price)) return `Below floor ${formatNaira(toKobo(item.floor_price))}`;
    if (q > stockFor(item.id)) return `Only ${stockFor(item.id)} in stock`;
    return null;
  }), [rows, data.items, stockFor]);
  const blocking = problems.filter(Boolean).length;
  const total = rows.reduce((s, r, i) => {
    if (problems[i]) return s;
    try { return s + toKobo(r.priceText) * Math.floor(Number(r.qtyText)); } catch { return s; }
  }, 0) as Kobo;

  async function record() {
    if (!ctx?.user || !scanId || blocking || rows.length === 0) return;
    setPhase("recording");
    const soldAt = new Date(date + "T12:00:00").toISOString();
    const ids: string[] = [];
    try {
      for (const r of rows) {
        const sale = await inventory.recordSale({
          shopId: shop.id, clientRef: crypto.randomUUID(), soldBy: ctx.user.id,
          deviceId: device?.device_id ?? null, soldAt, note: `From notebook page${page?.page_date ? ` dated ${page.page_date}` : ""}`,
          lines: [{ item_id: r.itemId, quantity: Math.floor(Number(r.qtyText)), unit_price: fromKobo(toKobo(r.priceText)) }],
        });
        ids.push(sale.id);
        setRows((rs) => rs.filter((x) => x.key !== r.key));
      }
      await closeScan(getSupabase(), scanId, "confirmed", ids);
      void announceStockChange(stockChannel(getSupabase(), shop.id), device?.device_id ?? null);
      notifySuccess(`Recorded ${ids.length} ${ids.length === 1 ? "sale" : "sales"} — ${formatNaira(total)}`, { description: "They now appear under Sales like any other sale." });
      reset();
      await refresh();
    } catch (e) {
      // Rows already recorded stay recorded; the rest are still on screen.
      notifyError(e);
      setPhase("review");
      if (ids.length) notifySuccess(`${ids.length} recorded so far`, { description: "Fix the row that failed and record the rest." });
    }
  }

  function reset() {
    setPhase("idle"); setPreview(null); setScanId(null); setPage(null); setRows([]);
  }

  const remaining = quota?.remaining ?? null;
  const canScan = online && writable && (quota?.enabled ?? false) && (remaining ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Scan a page"
        description="Photograph a handwritten sales page. Check what was read, then record."
        actions={quota && (
          <Badge variant={remaining === 0 ? "warning" : "secondary"} className="text-small">
            {remaining} of {quota.allowance} free scans left this month
          </Badge>
        )}
      />
      <div className="px-8 pb-8 grid gap-4">
        {!online && <Alert tone="info" title="Scanning needs a connection">Reading a page uses an online service. Everything else keeps working.</Alert>}
        {quota && !quota.enabled && <Alert tone="info" title="Notebook capture is switched off">Zogal has this feature turned off at the moment.</Alert>}
        {quota && quota.enabled && remaining === 0 && (
          <Alert tone="warning" title="This month's free scans are used up">
            {quota.used} of {quota.allowance} used. The allowance resets next month; contact Zogal to raise it for your shop.
          </Alert>
        )}

        {phase === "idle" && (
          <Card className="py-10">
            <CardContent className="grid place-items-center gap-4 text-center">
              <div className="size-16 rounded-full bg-brand-mint/40 grid place-items-center text-brand-forest"><IconCamera size={28} /></div>
              <div className="grid gap-1">
                <div className="text-title">Choose a photo of the page</div>
                <p className="text-small text-muted-foreground max-w-md">
                  One page at a time. Good light, the whole page in frame, columns readable. Each line becomes one sale you can correct before it is recorded.
                </p>
              </div>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
              <Button size="lg" disabled={!canScan} onClick={() => fileRef.current?.click()} title={!online ? "Needs a connection" : undefined}>
                <IconPhoto size={18} /> Choose photo
              </Button>
              <p className="text-caption text-muted-foreground">The photo is read once and not kept.</p>
            </CardContent>
          </Card>
        )}

        {phase === "parsing" && <LoadingMark label="Reading the page…" />}

        {(phase === "review" || phase === "recording") && page && (
          <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-4 items-start">
            <Card className="py-3 sticky top-4">
              <CardContent className="px-3 grid gap-2">
                {preview && <img src={preview} alt="The scanned page" className="rounded-[8px] w-full" />}
                <div className="grid gap-2">
                  <Label htmlFor="nb-date">Date of these sales</Label>
                  <Input id="nb-date" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
                  <p className="text-caption text-muted-foreground">{page.page_date ? `Read from the page: ${page.page_date}.` : "No date found on the page — today is assumed."} Applies to every row.</p>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4">
              {page.warnings.length > 0 && (
                <Alert tone="warning" title="Check this page">
                  <ul className="list-disc pl-4">{page.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </Alert>
              )}
              <Card className="py-0">
                <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
                  <div className="text-title">{rows.length} {rows.length === 1 ? "row" : "rows"} read</div>
                  <div className="text-caption text-muted-foreground">Every row is a draft until you record it.</div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">As written</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="w-24">Qty</TableHead>
                      <TableHead className="w-36">Price (₦)</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="pr-5"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 && <TableRow><TableCell colSpan={6} className="pl-5 text-muted-foreground">Nothing readable on this page.</TableCell></TableRow>}
                    {rows.map((r, i) => {
                      const problem = problems[i];
                      let lineTotal: Kobo | null = null;
                      try { lineTotal = r.qtyText && r.priceText ? (toKobo(r.priceText) * Math.floor(Number(r.qtyText))) as Kobo : null; } catch { lineTotal = null; }
                      return (
                        <TableRow key={r.key} className={cn(problem && "bg-status-amber/5")}>
                          <TableCell className="pl-5 align-top">
                            <div className="font-medium">{r.itemText || "—"}</div>
                            <div className="flex items-center gap-1.5 mt-1">
                              <Badge variant={r.confidence === "high" ? "secondary" : "warning"}>{r.confidence === "high" ? "Clear" : r.confidence === "medium" ? "Check" : "Unclear"}</Badge>
                              {r.note && <span className="text-caption text-muted-foreground">{r.note}</span>}
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <select className={cn("h-9 rounded-md border bg-card px-2 text-sm w-[220px]", !r.itemId && "border-status-amber")} value={r.itemId}
                              onChange={(e) => {
                                const it = data.items.find((x) => x.id === e.target.value);
                                update(r.key, { itemId: e.target.value, priceText: r.priceText || (it ? fromKobo(toKobo(it.suggested_price)) : "") });
                              }}>
                              <option value="">— choose item —</option>
                              {data.items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                            </select>
                            {problem && <div className="text-caption text-status-amber mt-1">{problem}</div>}
                          </TableCell>
                          <TableCell className="align-top"><NumberField decimals={0} min={1} value={r.qtyText} onChange={(v) => update(r.key, { qtyText: v })} /></TableCell>
                          <TableCell className="align-top"><NumberField prefix="₦" decimals={2} value={r.priceText} onChange={(v) => update(r.key, { priceText: v })} /></TableCell>
                          <TableCell className="align-top text-right tabular font-semibold">{lineTotal !== null ? formatNaira(lineTotal) : "—"}</TableCell>
                          <TableCell className="align-top pr-5 text-right">
                            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><IconTrash size={14} /></Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="px-5 py-4 border-t flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-micro text-muted-foreground">Will be recorded</div>
                    <div className="figure figure-lg">{formatNaira(total)}</div>
                    {blocking > 0 && <div className="text-caption text-status-amber">{blocking} {blocking === 1 ? "row needs" : "rows need"} attention before recording</div>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={phase === "recording"} onClick={() => setAskDiscard(true)}>Discard page</Button>
                    <Button size="lg" disabled={phase === "recording" || blocking > 0 || rows.length === 0 || !online || !writable} onClick={() => void record()}>
                      {phase === "recording" ? "Recording…" : `Record ${rows.length} ${rows.length === 1 ? "sale" : "sales"}`}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={askDiscard}
        onOpenChange={setAskDiscard}
        title="Discard this page?"
        description="Nothing from it will be recorded. The scan still counts towards this month's allowance."
        confirmLabel="Discard"
        destructive
        onConfirm={async () => {
          setAskDiscard(false);
          if (scanId) { try { await closeScan(getSupabase(), scanId, "discarded"); } catch { /* best effort */ } }
          reset();
        }}
      />
    </>
  );
}

/** Shrink to ≤1600px on the long side, JPEG — enough to read handwriting, small enough to send. */
function downscale(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const g = canvas.getContext("2d");
      if (!g) { reject(new Error("Could not read the image")); return; }
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(url);
      resolve({ base64: dataUrl.split(",")[1] ?? "", dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image we can read")); };
    img.src = url;
  });
}
