import { useCallback, useEffect, useState } from "react";
import { loadFiledPeriods, loadLedgerSummary, loadTaxProfile, loadTaxReference, monthWindow, yearWindow } from "@zogal/tax-engine";
import type { BusinessCategory, FiledPeriod, LedgerSummary, ShopTaxProfile, TaxRule, TaxType } from "@zogal/tax-engine";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

export interface TaxSlice {
  taxTypes: TaxType[]; categories: BusinessCategory[]; rules: TaxRule[];
  profile: (ShopTaxProfile & { declaredAt: string }) | null;
  year: LedgerSummary; month: LedgerSummary; filed: FiledPeriod[];
}

/** Same slice the desktop caches offline — here loaded live, since the dashboard is online-only. */
export function useTaxSlice(): { tax: TaxSlice | null; loading: boolean; refresh: () => Promise<void> } {
  const { active } = useSession();
  const shopId = active!.shop.id;
  const [tax, setTax] = useState<TaxSlice | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const db = getSupabase();
      const today = new Date().toISOString().slice(0, 10);
      const [ref, profile, filed] = await Promise.all([loadTaxReference(db), loadTaxProfile(db, shopId), loadFiledPeriods(db, shopId)]);
      const y = yearWindow(today, profile?.fiscalYearStartMonth ?? 1);
      const m = monthWindow(today);
      const [year, month] = await Promise.all([loadLedgerSummary(db, shopId, y.start, y.end), loadLedgerSummary(db, shopId, m.start, m.end)]);
      setTax({ ...ref, profile, year, month, filed });
    } finally { setLoading(false); }
  }, [shopId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { tax, loading, refresh };
}
