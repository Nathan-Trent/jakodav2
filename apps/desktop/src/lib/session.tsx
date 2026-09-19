import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AuthRepository, recordSignin, type DeviceActivation, type Membership, type MyContext } from "@zogal/auth-permissions";
import { InventoryRepository } from "@zogal/inventory-batches";
import { getSupabase } from "@/lib/supabase";
import { clearDevice, loadDevice, saveDevice } from "@/lib/device";

/**
 * App-wide session: Supabase auth state → our own user/memberships via
 * get_my_context(), plus the persisted device binding. Everything the
 * screens need is derived here so components stay dumb.
 */
interface SessionState {
  /** `unreachable`: there is a session but the server can't be reached and nothing is cached — show a connection screen, never a blank one. */
  status: "loading" | "signed-out" | "signed-in" | "unreachable";
  ctx: MyContext | null;
  /** `undefined` = still reading the OS credential store; not yet known whether this till is activated. */
  device: DeviceActivation | null | undefined;
  /** The membership matching the activated device's shop (or the only one). */
  active: Membership | null;
  auth: AuthRepository;
  inventory: InventoryRepository;
  refresh: () => Promise<void>;
  setDevice: (d: DeviceActivation | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);
const CTX_KEY = "doka.session.ctx";

/** Fetch failures, timeouts and Supabase's "Failed to fetch" are connectivity, not auth. */
export function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return /fetch|network|ECONN|timeout|Load failed|NetworkError/i.test(msg) || (typeof navigator !== "undefined" && !navigator.onLine);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const db = useMemo(() => getSupabase(), []);
  const auth = useMemo(() => new AuthRepository(db), [db]);
  const inventory = useMemo(() => new InventoryRepository(db), [db]);

  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [ctx, setCtx] = useState<MyContext | null>(null);
  // undefined until the one-time async read of the OS credential store resolves.
  const [device, setDeviceState] = useState<DeviceActivation | null | undefined>(undefined);
  const deviceRef = useRef<DeviceActivation | null>(null);
  const signinRecorded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadDevice().then((d) => { if (!cancelled) { deviceRef.current = d; setDeviceState(d); } });
    return () => { cancelled = true; };
  }, []);

  /**
   * SYNC / offline: the till must open with no network once it has signed in
   * once. The user's context (memberships, permissions) is cached after every
   * successful bootstrap; if the server can't be reached we run on the cache.
   * Only a genuine auth failure signs the user out.
   */
  const refresh = useCallback(async () => {
    try {
      const c = await auth.bootstrap();
      setCtx(c);
      setStatus("signed-in");
      try { localStorage.setItem(CTX_KEY, JSON.stringify(c)); } catch { /* ignore */ }
      // Once per app start: tell the back office where this sign-in is (0016).
      if (!signinRecorded.current) { signinRecorded.current = true; void recordSignin(db, "desktop", deviceRef.current?.shop_id ?? null); }
    } catch (e) {
      const network = isNetworkError(e);
      console.error("bootstrap failed", e);
      if (network) {
        let cached: MyContext | null = null;
        try { const raw = localStorage.getItem(CTX_KEY); cached = raw ? (JSON.parse(raw) as MyContext) : null; } catch { cached = null; }
        if (cached) { setCtx(cached); setStatus("signed-in"); return; }
        setCtx(null); setStatus("unreachable"); return;
      }
      setCtx(null);
      setStatus("signed-out");
      try { localStorage.removeItem(CTX_KEY); } catch { /* ignore */ }
    }
  }, [auth, db]);

  useEffect(() => {
    const { data: sub } = db.auth.onAuthStateChange((event, session) => {
      if (session) {
        // Defer: calling supabase inside the callback deadlocks the auth lock.
        setTimeout(() => void refresh(), 0);
      } else if (event !== "INITIAL_SESSION" || !session) {
        setCtx(null);
        setStatus("signed-out");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [db, refresh]);

  const setDevice = useCallback((d: DeviceActivation | null) => {
    deviceRef.current = d;
    setDeviceState(d); // update the screen at once; the keyring write happens alongside
    void (d ? saveDevice(d) : clearDevice());
  }, []);

  const active = useMemo<Membership | null>(() => {
    if (!ctx) return null;
    if (device) return ctx.memberships.find((m) => m.shop.id === device.shop_id) ?? null;
    return ctx.memberships[0] ?? null;
  }, [ctx, device]);

  const signOut = useCallback(async () => {
    try { localStorage.removeItem(CTX_KEY); } catch { /* ignore */ }
    await auth.signOut();
  }, [auth]);

  const value = useMemo<SessionState>(
    () => ({ status, ctx, device, active, auth, inventory, refresh, setDevice, signOut }),
    [status, ctx, device, active, auth, inventory, refresh, setDevice, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

/** Message for the user from any thrown error (Supabase, zod, Error). */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; issues?: { message: string }[] };
    if (Array.isArray(o.issues) && o.issues[0]) return o.issues[0].message;
    if (typeof o.message === "string") return o.message;
  }
  return String(e);
}
