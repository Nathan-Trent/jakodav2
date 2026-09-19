import { useSyncExternalStore } from "react";

/**
 * What the app knows about the barcode scanner on this terminal (0028).
 * USB/Bluetooth scanners are keyboard-wedge devices — they can't be
 * enumerated, only recognised by how they type. So "detected" means: we've
 * seen a burst that only a scanner produces. Every recognised scan, anywhere
 * in the app, reports here; Settings → Scanner shows it and lets the owner
 * test and, if the scanner is slow, loosen the timing.
 */
export interface ScannerStatus {
  lastScanAt: number | null;
  lastCode: string | null;
  /** Average gap between keystrokes in the last scan (ms). */
  lastGapMs: number | null;
  scansThisSession: number;
}

const GAP_KEY = "doka.scanner.maxGapMs";
export const DEFAULT_MAX_GAP_MS = 35;

let status: ScannerStatus = { lastScanAt: null, lastCode: null, lastGapMs: null, scansThisSession: 0 };
const listeners = new Set<() => void>();

export function noteScan(code: string, avgGapMs: number): void {
  status = { lastScanAt: Date.now(), lastCode: code, lastGapMs: Math.round(avgGapMs), scansThisSession: status.scansThisSession + 1 };
  for (const l of listeners) l();
}

export function useScannerStatus(): ScannerStatus {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => status, () => status);
}

/** Per-terminal timing threshold. Higher = accepts slower scanners, risks catching fast typists. */
export function getMaxGapMs(): number {
  try { const v = Number(localStorage.getItem(GAP_KEY)); return v >= 20 && v <= 120 ? v : DEFAULT_MAX_GAP_MS; } catch { return DEFAULT_MAX_GAP_MS; }
}
export function setMaxGapMs(v: number): void {
  try { localStorage.setItem(GAP_KEY, String(Math.min(120, Math.max(20, Math.round(v))))); } catch { /* ignore */ }
  for (const l of listeners) l();
}
