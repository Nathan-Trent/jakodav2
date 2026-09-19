import { useEffect, useState, type ReactNode } from "react";
import { Alert, LoadingMark, ZogalMark } from "@zogal/ui";
import { isTauri } from "@/lib/updater";
import { getSupabase } from "@/lib/supabase";

/**
 * The partner web till (this app served as a website) can be switched off
 * from the Doka back office (`pos_web.enabled`, 0015). Checked before
 * anything else renders; the installed desktop app is never gated by it.
 * If the check itself fails (no network), the cached answer from the last
 * successful check is used, so an offline partner keeps working.
 */
export function WebTillGate({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean | null>(() => {
    if (isTauri()) return true;
    try { const v = localStorage.getItem("doka.posweb.enabled"); return v === null ? null : v === "1"; } catch { return null; }
  });

  useEffect(() => {
    if (isTauri()) return;
    const check = () => {
      getSupabase().rpc("pos_web_enabled").then(({ data, error }) => {
        // Can't ask: keep the cached answer; with no cache, a kill switch fails CLOSED.
        if (error) { setEnabled((e) => e ?? false); return; }
        const on = data === true;
        setEnabled(on);
        try { localStorage.setItem("doka.posweb.enabled", on ? "1" : "0"); } catch { /* ignore */ }
      });
    };
    check();
    // The switch is anon-readable only through this RPC (no Realtime for anon),
    // so re-ask whenever the tab comes back into view or the network returns —
    // switching the trial off takes effect without anyone reloading.
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => { window.removeEventListener("focus", check); window.removeEventListener("online", check); };
  }, []);

  if (enabled === null) return <LoadingMark label="Starting up…" />;
  if (!enabled) {
    return (
      <div className="min-h-full grid place-items-center p-8 bg-background">
        <div className="max-w-md grid gap-4 justify-items-center text-center">
          <ZogalMark size={48} />
          <Alert tone="info" title="The web version of Doka isn't available right now">
            It has been switched off. If you have the desktop app installed, keep using that; otherwise contact Zogal.
          </Alert>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
