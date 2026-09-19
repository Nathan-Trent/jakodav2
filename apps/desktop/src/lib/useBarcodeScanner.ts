import { useEffect, useRef } from "react";
import { getMaxGapMs, noteScan } from "@/lib/scannerStatus";

/**
 * USB/Bluetooth barcode scanners are keyboard-wedge devices: they "type" the
 * code very fast and finish with Enter. We tell a scan apart from a human by
 * timing — a human can't type 8+ characters with <35 ms between keys.
 *
 * Works anywhere on the page, including while an input is focused: when a
 * burst is recognised we swallow the keystrokes so the code doesn't land in
 * whatever field had focus. Human typing is untouched.
 */
export function useBarcodeScanner(onScan: (code: string) => void, opts: { enabled?: boolean; minLength?: number; maxGapMs?: number } = {}) {
  // Threshold is per terminal (Settings → Scanner) unless a caller pins it.
  const { enabled = true, minLength = 6, maxGapMs = getMaxGapMs() } = opts;
  const buf = useRef("");
  const last = useRef(0);
  const gaps = useRef<number[]>([]);
  const timer = useRef<number | null>(null);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const reset = () => { buf.current = ""; gaps.current = []; };
    const onKey = (e: KeyboardEvent) => {
      const now = performance.now();
      const gap = now - last.current;
      last.current = now;

      if (e.key === "Enter") {
        if (buf.current.length >= minLength && gap <= maxGapMs * 3) {
          const code = buf.current;
          const avg = gaps.current.length ? gaps.current.reduce((a, b) => a + b, 0) / gaps.current.length : 0;
          reset();
          e.preventDefault();
          e.stopPropagation();
          noteScan(code, avg);   // Settings → Scanner: "detected, last scan 2 s ago"
          cb.current(code);
        } else {
          reset();
        }
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;

      // Too slow since the last key → a human is typing; start over.
      if (gap > maxGapMs && buf.current.length > 0) reset();
      if (buf.current.length > 0) gaps.current.push(gap);
      buf.current += e.key;

      // Once the burst clearly looks like a scanner, keep it out of inputs.
      if (buf.current.length >= 3 && gap <= maxGapMs) {
        e.preventDefault();
      }
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(reset, maxGapMs * 6);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, minLength, maxGapMs]);
}
