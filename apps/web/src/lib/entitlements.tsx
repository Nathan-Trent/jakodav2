import { useEffect, useMemo, useState } from "react";
import { entitlementOf, featureEnabled, type Entitlement, type Entitlements, type FeatureKey } from "@zogal/shared";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

/**
 * What this shop's plan allows (0027). The dashboard is always online, so it
 * asks the server and lets the database tell it when that changes: a plan
 * edit published from the back office, or this shop's subscription moving
 * plan, arrives over Realtime and triggers one re-read. No polling.
 */
export function useEntitlements(): Entitlements {
  const { active } = useSession();
  const shopId = active?.shop.id ?? null;
  const [ents, setEnts] = useState<Entitlements>({});

  useEffect(() => {
    if (!shopId) return;
    const db = getSupabase();
    let cancelled = false;
    const load = () => {
      db.rpc("shop_entitlements", { p_shop_id: shopId }).then(({ data, error }) => {
        if (!cancelled && !error && data) setEnts(data as Entitlements);
      });
    };
    load();
    const ch = db.channel(`entitlements:${shopId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "pricing_plans" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "subscriptions", filter: `shop_id=eq.${shopId}` }, load)
      .subscribe();
    return () => { cancelled = true; void db.removeChannel(ch); };
  }, [shopId]);

  return ents;
}

export function useFeature(key: FeatureKey): boolean { return featureEnabled(useEntitlements(), key); }
export function useEntitlement(key: FeatureKey): Entitlement { const e = useEntitlements(); return useMemo(() => entitlementOf(e, key), [e, key]); }
