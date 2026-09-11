import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthRepository, type DeviceActivation, type Membership, type MyContext } from "@jakoda/auth-permissions";
import { InventoryRepository } from "@jakoda/inventory-batches";
import { getSupabase } from "@/lib/supabase";
import { clearDevice, loadDevice, saveDevice } from "@/lib/device";

/**
 * App-wide session: Supabase auth state → our own user/memberships via
 * get_my_context(), plus the persisted device binding. Everything the
 * screens need is derived here so components stay dumb.
 */
interface SessionState {
  status: "loading" | "signed-out" | "signed-in";
  ctx: MyContext | null;
  device: DeviceActivation | null;
  /** The membership matching the activated device's shop (or the only one). */
  active: Membership | null;
  auth: AuthRepository;
  inventory: InventoryRepository;
  refresh: () => Promise<void>;
  setDevice: (d: DeviceActivation | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const db = useMemo(() => getSupabase(), []);
  const auth = useMemo(() => new AuthRepository(db), [db]);
  const inventory = useMemo(() => new InventoryRepository(db), [db]);

  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [ctx, setCtx] = useState<MyContext | null>(null);
  const [device, setDeviceState] = useState<DeviceActivation | null>(() => loadDevice());

  const refresh = useCallback(async () => {
    try {
      const c = await auth.bootstrap();
      setCtx(c);
      setStatus("signed-in");
    } catch (e) {
      console.error("bootstrap failed", e);
      setCtx(null);
      setStatus("signed-out");
    }
  }, [auth]);

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
    if (d) saveDevice(d);
    else clearDevice();
    setDeviceState(d);
  }, []);

  const active = useMemo<Membership | null>(() => {
    if (!ctx) return null;
    if (device) return ctx.memberships.find((m) => m.shop.id === device.shop_id) ?? null;
    return ctx.memberships[0] ?? null;
  }, [ctx, device]);

  const signOut = useCallback(async () => {
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
