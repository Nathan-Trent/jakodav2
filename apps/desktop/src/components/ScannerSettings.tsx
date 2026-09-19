import { useEffect, useState } from "react";
import { IconScan } from "@tabler/icons-react";
import { Badge, Button, Card, CardContent, Label } from "@zogal/ui";
import { DEFAULT_MAX_GAP_MS, getMaxGapMs, setMaxGapMs, useScannerStatus } from "@/lib/scannerStatus";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

/**
 * Settings → Scanner (0028). A keyboard-wedge scanner can't be listed like a
 * printer; it is recognised by the way it types. So: a test area, what the
 * last scan looked like, and one dial for slow scanners. Per terminal.
 */
export function ScannerSettings() {
  const st = useScannerStatus();
  const [testCode, setTestCode] = useState<string | null>(null);
  const [gap, setGap] = useState(getMaxGapMs());
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  useBarcodeScanner((code) => setTestCode(code), { minLength: 4 });

  const ago = st.lastScanAt ? Math.round((Date.now() - st.lastScanAt) / 1000) : null;
  const detected = ago !== null;

  return (
    <Card className="py-5 max-w-lg"><CardContent className="px-5 grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-subheading flex items-center gap-2"><IconScan size={16} /> Barcode scanner</h3>
        {detected
          ? <Badge variant="success">Detected · last scan {ago! < 5 ? "just now" : ago! < 60 ? `${ago} s ago` : `${Math.round(ago! / 60)} min ago`}</Badge>
          : <Badge variant="secondary">Not seen yet this session</Badge>}
      </div>
      <p className="text-caption text-muted-foreground">
        USB and Bluetooth scanners work like a very fast keyboard, so there is nothing to pair here: plug it in (or pair it in Windows/macOS Bluetooth settings) and scan the test code below. Doka recognises it anywhere in the app.
      </p>
      <div className="rounded-[10px] border border-dashed p-4 grid gap-2 text-center">
        <div className="text-small font-medium">Scan anything to test</div>
        <div className="font-mono text-[18px] tabular min-h-7">{testCode ?? <span className="text-muted-foreground">waiting…</span>}</div>
        {st.lastGapMs !== null && <div className="text-caption text-muted-foreground">{st.lastGapMs} ms between characters · {st.scansThisSession} scan{st.scansThisSession === 1 ? "" : "s"} this session</div>}
      </div>
      <div className="grid gap-2">
        <Label className="text-small">If scans aren't recognised</Label>
        <p className="text-caption text-muted-foreground">Some older or Bluetooth scanners type slowly and get mistaken for a person. Move this right until the test above reads reliably. Too far right and fast typists start being mistaken for a scanner.</p>
        <div className="flex items-center gap-3">
          <span className="text-caption text-muted-foreground">fast</span>
          <input type="range" min={20} max={120} step={5} value={gap} onChange={(e) => { const v = Number(e.target.value); setGap(v); setMaxGapMs(v); }} className="flex-1" aria-label="Scanner timing" />
          <span className="text-caption text-muted-foreground">slow</span>
          <span className="tabular text-small w-14 text-right">{gap} ms</span>
        </div>
        {gap !== DEFAULT_MAX_GAP_MS && <div><Button variant="ghost" size="sm" onClick={() => { setGap(DEFAULT_MAX_GAP_MS); setMaxGapMs(DEFAULT_MAX_GAP_MS); }}>Back to default</Button></div>}
      </div>
    </CardContent></Card>
  );
}
