import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Auto-update for installed desktops (Nathan, 2026-09-13: "we can always
 * push updates to it when it's on individual systems").
 *
 * How it works: GitHub Actions builds a signed installer for every version
 * tag and publishes it as a GitHub Release with a `latest.json`. Each
 * installed copy asks that URL on launch and every 6 hours. A newer version
 * is downloaded, its signature checked against the public key compiled into
 * the app, and installed when the cashier says so — never mid-sale.
 *
 * Only real in the Tauri shell. In a browser (the partner web build) the
 * hook is inert: the site is simply redeployed.
 */
export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "uptodate";
  version?: string;
  notes?: string;
  progress?: number; // 0..1
  error?: string;
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The cashier never needs to read a raw updater exception — that's for us,
 * in the console. This turns the ones we actually see into one plain
 * sentence; anything unrecognised falls back to a generic, still-plain line
 * rather than the technical text.
 */
export function friendlyUpdateError(raw: string | undefined): string {
  const m = raw ?? "";
  if (/fallback platforms.*not found|platforms.*object/i.test(m)) {
    return "The update server wasn't finished publishing this release when we checked. Try again in a few minutes.";
  }
  if (/Failed to fetch|NetworkError|ERR_INTERNET|dns|timed? ?out/i.test(m)) {
    return "Couldn't reach the update server. Check the connection and try again.";
  }
  if (/404|not found/i.test(m)) {
    return "No release was found to update to. Try again later.";
  }
  if (/signature/i.test(m)) {
    return "The update didn't pass its safety check, so it wasn't installed. Try again later, or reinstall Doka from getzogal.com.";
  }
  return "Something stopped the check. Try again later.";
}

type UpdateHandle = {
  version: string;
  body?: string;
  downloadAndInstall: (cb?: (e: { event: "Started" | "Progress" | "Finished"; data: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
};

function useUpdater(): { state: UpdateState; install: () => Promise<void>; dismiss: () => void; checkNow: () => Promise<void> } {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [update, setUpdate] = useState<UpdateHandle | null>(null);

  const check = useCallback(async (manual = false) => {
    if (!isTauri()) { if (manual) setState({ status: "uptodate" }); return; }
    setState((s) => (s.status === "idle" || s.status === "uptodate" || manual ? { status: "checking" } : s));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (u) {
        setUpdate(u as unknown as UpdateHandle);
        setState({ status: "available", version: u.version, ...(u.body ? { notes: u.body } : {}) });
      } else {
        // Manual check: say so; automatic: stay quiet.
        setState({ status: manual ? "uptodate" : "idle" });
      }
    } catch (e) {
      // No network or GitHub unreachable: not an error the cashier needs unless they asked.
      setState({ status: manual ? "error" : "idle", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const t = setTimeout(() => void check(), 5000); // let the app settle first
    const i = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [check]);

  const install = useCallback(async () => {
    if (!update) return;
    setState((s) => ({ ...s, status: "downloading", progress: 0 }));
    try {
      let total = 0, got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") { got += e.data.chunkLength ?? 0; if (total) setState((s) => ({ ...s, progress: got / total })); }
        else if (e.event === "Finished") setState((s) => ({ ...s, status: "ready", progress: 1 }));
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: e instanceof Error ? e.message : String(e) }));
    }
  }, [update]);

  const dismiss = useCallback(() => setState((s) => (s.status === "available" || s.status === "uptodate" || s.status === "error" ? { ...s, status: "idle" } : s)), []);
  return { state, install, dismiss, checkNow: () => check(true) };
}

/** One updater for the whole app, so the banner and the "Check for updates" button agree. */
type Updater = ReturnType<typeof useUpdater>;
const UpdaterCtx = createContext<Updater | null>(null);
export function UpdaterProvider({ children }: { children: ReactNode }) {
  const u = useUpdater();
  return createElement(UpdaterCtx.Provider, { value: u }, children);
}
export function useUpdaterCtx(): Updater {
  const v = useContext(UpdaterCtx);
  if (!v) throw new Error("useUpdaterCtx outside UpdaterProvider");
  return v;
}
