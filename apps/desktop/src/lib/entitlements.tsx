import { useEffect, useMemo, useState } from "react";
import { entitlementOf, featureEnabled, type Entitlement, type Entitlements, type FeatureKey } from "@zogal/shared";
import { useSession } from "@/lib/session";
import { useSync } from "@/lib/sync";
import { getSupabase } from "@/lib/supabase";

/**
 * What this shop's plan allows (0027).
 *
 * SYNC / offline: the truth the terminal trusts is the SIGNED token's copy —
 * it can't be edited on the machine, and it is what the server used when it
 * minted the token. Before the first token exists (fresh activation) we ask
 * the server once and cache the answer; a plan edit reaches us at the next
 * sync, when the new token arrives. The server enforces every gate too, so
 * a stale copy here can only ever be more permissive for a moment, never
 * unlock anything for real.
 */
const CACHE_KEY = (shopId: string) => `doka.entitlements.${shopId}`;

export function useEntitlements(): Entitlements {
  const { status } = useSync();
  const { active } = useSession();
  const shopId = active?.shop.id ?? null;
  const fromToken = status?.subscription?.entitlements;
  const [fallback, setFallback] = useState<Entitlements | null>(() => {
    if (!shopId) return null;
    try { const raw = localStorage.getItem(CACHE_KEY(shopId)); return raw ? (JSON.parse(raw) as Entitlements) : null; } catch { return null; }
  });

  useEffect(() => {
    if (fromToken || !shopId || !navigator.onLine) return;
    let cancelled = false;
    getSupabase().rpc("shop_entitlements", { p_shop_id: shopId }).then(({ data, error }) => {
      if (cancelled || error || !data) return;
      setFallback(data as Entitlements);
      try { localStorage.setItem(CACHE_KEY(shopId), JSON.stringify(data)); } catch { /* ignore */ }
    });
    return () => { cancelled = true; };
  }, [fromToken, shopId]);

  return useMemo(() => fromToken ?? fallback ?? {}, [fromToken, fallback]);
}

export function useFeature(key: FeatureKey): boolean {
  return featureEnabled(useEntitlements(), key);
}

export function useEntitlement(key: FeatureKey): Entitlement {
  return entitlementOf(useEntitlements(), key);
}
