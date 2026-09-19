import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SyncEngine, canSeeFinancials, canWrite, type GateDecision, type SyncStatus } from "@zogal/sync";
import { notifyError } from "@zogal/ui";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

/**
 * SYNC: runs the engine for the active terminal and publishes its status.
 *
 * The gate it produces is the single source of truth for what the app will
 * let anyone do. Screens ask `canWrite` / `canSeeFinancials` rather than
 * re-deriving rules, so there is one place to be wrong.
 */
interface SyncContextValue {
  status: SyncStatus | null;
  /** Convenience: is the terminal allowed to record anything right now? */
  writable: boolean;
  /** TRD §7: tax numbers and reports are hidden below "full". */
  financialsVisible: boolean;
  gate: GateDecision | null;
  syncNow: () => void;
}

const IDLE_GATE: GateDecision = {
  level: "full", reason: "ok", title: "Up to date", action: "", daysUntilNextStep: null, warn: false,
};

const Ctx = createContext<SyncContextValue>({
  status: null, writable: true, financialsVisible: true, gate: null, syncNow: () => {},
});

export function SyncProvider({ children }: { children: ReactNode }) {
  const { ctx, device, active, setDevice } = useSession();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  const userId = ctx?.user?.id ?? null;
  const shopId = active?.shop.id ?? null;

  useEffect(() => {
    if (!device || !userId || !shopId) { setStatus(null); setEngine(null); return; }
    const e = new SyncEngine({
      db: getSupabase(),
      shopId,
      deviceId: device.device_id,
      credential: device.credential,
      userId,
      publicKeyB64: import.meta.env.VITE_SUBSCRIPTION_PUBLIC_KEY ?? "",
      functionsUrl: `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1`,
      anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
      onStatus: setStatus,
      onRevoked: () => {
        // SYNC: the owner revoked this terminal. Drop the binding at once —
        // the app falls back to the activation screen (App.tsx: !device).
        setDevice(null);
        notifyError(new Error("unknown or revoked device")); // → "This terminal has been revoked" (ui/errors)
      },
    });
    setEngine(e);
    void e.start();

    // SYNC: the database tells us, we don't ask. The owner's Revoke click
    // updates our devices row; RLS lets a shop member see it, so the push
    // arrives here and the terminal is out immediately — no refresh, no
    // waiting for the next sync tick. A DELETE of the row counts the same.
    const ch = getSupabase()
      .channel(`device:${device.device_id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "devices", filter: `id=eq.${device.device_id}` }, (p) => {
        const row = p.new as { revoked_at?: string | null } | undefined;
        if (p.eventType === "DELETE" || row?.revoked_at) e.revoke();
      })
      .subscribe();

    return () => { e.stop(); void getSupabase().removeChannel(ch); };
  }, [device, userId, shopId, setDevice]);

  const value = useMemo<SyncContextValue>(() => {
    const gate = status?.gate ?? IDLE_GATE;
    return {
      status,
      gate,
      writable: canWrite(gate.level),
      financialsVisible: canSeeFinancials(gate.level),
      syncNow: () => void engine?.syncNow(),
    };
  }, [status, engine]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncContextValue {
  return useContext(Ctx);
}
