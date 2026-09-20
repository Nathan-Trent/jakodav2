import { useRef, useState, type ReactNode } from "react";
import { IconCamera } from "@tabler/icons-react";
import { Button } from "../ui/button.js";
import { downscaleImage } from "../../lib/image.js";
import { notifyError, notifyInfo } from "../../lib/feedback.js";

/**
 * "Scan a page" as an entry type (0029): a button on the form you're already
 * on. Picks one or many photos (phone camera on mobile, file picker on a
 * laptop), shrinks each, hands it to `parse` one at a time, and returns the
 * pages that were read. What the pages MEAN is the host screen's business —
 * this component never knows the kind.
 */
export interface ScanQuotaView { remaining: number | null; allowance: number | null; period: string }

export function ScanPagesButton<T>({ label = "Scan a page", parse, onPages, disabled, disabledReason, quota, variant = "outline", size = "default", children }: {
  label?: string;
  parse: (base64: string) => Promise<T>;
  onPages: (pages: T[]) => void;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  quota?: ScanQuotaView | null | undefined;
  variant?: "outline" | "secondary" | "default" | "ghost";
  size?: "sm" | "default" | "lg";
  children?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const quotaOut = quota ? quota.remaining !== null && quota.remaining <= 0 : false;
  const off = disabled || busy !== null || quotaOut;
  const title = disabled ? disabledReason
    : quotaOut ? `You've used all ${quota?.allowance} scans this ${quota?.period}.`
    : quota && quota.remaining !== null ? `${quota.remaining} of ${quota.allowance} scans left this ${quota.period}` : undefined;

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const out: T[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        setBusy(list.length > 1 ? `Reading page ${i + 1} of ${list.length}…` : "Reading the page…");
        const { base64 } = await downscaleImage(list[i]!);
        out.push(await parse(base64));
      }
    } catch (e) {
      notifyError(e, "Couldn't read the page");
      if (out.length) notifyInfo(`${out.length} page${out.length === 1 ? "" : "s"} read before that`, "Review those; scan the rest again.");
    } finally {
      setBusy(null);
      if (ref.current) ref.current.value = "";
    }
    if (out.length) onPages(out);
  }

  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
      <Button type="button" variant={variant} size={size} disabled={off} title={title} onClick={() => ref.current?.click()}>
        <IconCamera size={16} /> {busy ?? children ?? label}
      </Button>
    </>
  );
}
