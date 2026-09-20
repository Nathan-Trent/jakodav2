import { useCallback, useEffect, useState } from "react";
import { closeScan, fetchScanQuota, parseDocumentPage, type PageKind, type ParsedByKind, type ScanQuota } from "@zogal/inventory-batches";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

/**
 * Document scan as an entry type on the web dashboard (0029). Same pipeline
 * as the desktop; this is the onboarding path — the owner walks the shop
 * with a phone and photographs the stock ledger.
 */
export function useDocumentScan<K extends PageKind>(kind: K) {
  const { active } = useSession();
  const shopId = active!.shop.id;
  const [quota, setQuota] = useState<ScanQuota | null>(null);
  const [pages, setPages] = useState<{ scanId: string; result: ParsedByKind[K] }[]>([]);

  const refreshQuota = useCallback(() => {
    fetchScanQuota(getSupabase(), shopId).then(setQuota).catch(() => setQuota(null));
  }, [shopId]);
  useEffect(() => { refreshQuota(); }, [refreshQuota]);

  const parse = useCallback(async (base64: string) =>
    parseDocumentPage(getSupabase(), { kind, shopId, deviceId: null, imageBase64: base64, mediaType: "image/jpeg" }), [kind, shopId]);

  const finish = useCallback(async (status: "confirmed" | "discarded", createdIds: string[] = []) => {
    const db = getSupabase();
    await Promise.all(pages.map((p, i) => closeScan(db, p.scanId, status, i === 0 ? createdIds : []).catch(() => undefined)));
    setPages([]);
    refreshQuota();
  }, [pages, refreshQuota]);

  const enabled = (quota?.enabled ?? true) && (quota === null || quota.remaining === null || quota.remaining > 0);
  const disabledReason = quota && !quota.enabled ? "Document scans aren't included in your plan." : undefined;
  return { quota, pages, setPages, parse, finish, enabled, disabledReason, results: pages.map((p) => p.result) };
}
