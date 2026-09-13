import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthRepository, isPlatformAdmin, type Membership, type MyContext } from "@zogal/auth-permissions";
import { getSupabase } from "@/lib/supabase";

/**
 * Web-dashboard session. Same Supabase auth as the desktop; no device
 * binding (a browser isn't a terminal). The active shop is a choice — an
 * owner of two shops switches between them — remembered per browser.
 * `admin` is true only for Zogal platform admins (0013) and only decides
 * whether the back-office section is shown; Postgres enforces it.
 */
interface SessionState {
  status: "loading" | "signed-out" | "signed-in";
  ctx: MyContext | null;
  active: Membership | null;
  admin: boolean;
  auth: AuthRepository;
  setActiveShop: (shopId: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);
const SHOP_KEY = "zogal.web.shop";

export function SessionProvider({ children }: { children: ReactNode }) {
  const db = useMemo(() => getSupabase(), []);
  const auth = useMemo(() => new AuthRepository(db), [db]);
  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [ctx, setCtx] = useState<MyContext | null>(null);
  const [admin, setAdmin] = useState(false);
  const [shopId, setShopId] = useState<string | null>(() => { try { return localStorage.getItem(SHOP_KEY); } catch { return null; } });

  const refresh = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([auth.bootstrap(), isPlatformAdmin(db)]);
      setCtx(c);
      setAdmin(a);
      setStatus("signed-in");
    } catch {
      setCtx(null);
      setAdmin(false);
      setStatus("signed-out");
    }
  }, [auth, db]);

  useEffect(() => {
    const { data: sub } = db.auth.onAuthStateChange((event, session) => {
      if (session) setTimeout(() => void refresh(), 0); // defer: avoids the auth lock deadlock
      else if (event !== "INITIAL_SESSION" || !session) { setCtx(null); setStatus("signed-out"); }
    });
    return () => sub.subscription.unsubscribe();
  }, [db, refresh]);

  const active = useMemo<Membership | null>(() => {
    if (!ctx) return null;
    return ctx.memberships.find((m) => m.shop.id === shopId) ?? ctx.memberships[0] ?? null;
  }, [ctx, shopId]);

  const setActiveShop = useCallback((id: string) => {
    setShopId(id);
    try { localStorage.setItem(SHOP_KEY, id); } catch { /* ignore */ }
  }, []);

  const signOut = useCallback(async () => { await auth.signOut(); }, [auth]);

  const value = useMemo<SessionState>(
    () => ({ status, ctx, active, admin, auth, setActiveShop, refresh, signOut }),
    [status, ctx, active, admin, auth, setActiveShop, refresh, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}
