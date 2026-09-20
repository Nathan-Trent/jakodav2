import { useCallback, useEffect, useState } from "react";
import { closeScan, fetchScanQuota, parseDocumentPage, type PageKind, type ParsedByKind, type ScanQuota } from "@zogal/inventory-batches";
import { useSession } from "@/lib/session";
import { useOnline } from "@/lib/useOnline";
import { getSupabase } from "@/lib/supabase";

/**
 * Document scan as an entry type (0029). The screen decides the kind; this
 * gives it the quota (for the button's tooltip), a `parse` for one page, and
 * the list of pages read so far. Confirming/discarding closes the scans.
 * Online only, like every AI call; the button says so.
 */
export function useDocumentScan<K extends PageKind>(kind: K) {
  const { active, device } = useSession();
  const online = useOnline();
  const shopId = active!.shop.id;
  const [quota, setQuota] = useState<ScanQuota | null>(null);
  const [pages, setPages] = useState<{ scanId: string; result: ParsedByKind[K] }[]>([]);

  const refreshQuota = useCallback(() => {
    if (!online) return;
    fetchScanQuota(getSupabase(), shopId).then(setQuota).catch(() => setQuota(null));
  }, [shopId, online]);
  useEffect(() => { refreshQuota(); }, [refreshQuota]);

  const parse = useCallback(async (base64: string) => {
    const r = await parseDocumentPage(getSupabase(), { kind, shopId, deviceId: device?.device_id ?? null, imageBase64: base64, mediaType: "image/jpeg" });
    return r;
  }, [kind, shopId, device]);

  /** Mark every open page confirmed (with what was created) or discarded, then clear. */
  const finish = useCallback(async (status: "confirmed" | "discarded", createdIds: string[] = []) => {
    const db = getSupabase();
    await Promise.all(pages.map((p, i) => closeScan(db, p.scanId, status, i === 0 ? createdIds : []).catch(() => undefined)));
    setPages([]);
    refreshQuota();
  }, [pages, refreshQuota]);

  const enabled = online && (quota?.enabled ?? true) && (quota?.remaining === null || quota === null || (quota.remaining ?? 0) > 0);
  const disabledReason = !online ? "Reading a page needs a connection." : quota && !quota.enabled ? "Document scans aren't included in your plan." : undefined;

  return { quota, pages, setPages, parse, finish, enabled, disabledReason, results: pages.map((p) => p.result) };
}
