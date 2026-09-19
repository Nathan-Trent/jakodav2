import { useCallback, useEffect, useState, type DependencyList } from "react";

/** Load-on-mount + reload, with error kept for the screen to show (not a toast — it's the page's state). */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, deps);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}

export const money = (v: number | string | null | undefined): number => (v == null ? 0 : typeof v === "number" ? v : Number(v));
