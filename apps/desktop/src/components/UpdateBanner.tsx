import { IconDownload } from "@tabler/icons-react";
import { Alert, Button } from "@zogal/ui";
import { useUpdater } from "@/lib/updater";

/**
 * "A new version is ready" — visible, never forced. The cashier chooses
 * when to restart (Norman: the user controls timing of disruptive actions).
 */
export function UpdateBanner() {
  const { state, install, dismiss } = useUpdater();
  if (state.status === "idle" || state.status === "checking") return null;
  const pct = Math.round((state.progress ?? 0) * 100);
  return (
    <div className="px-8 pt-5">
      {state.status === "available" && (
        <Alert tone="info" title={`Doka ${state.version} is available`}
          action={<div className="flex gap-2"><Button size="sm" variant="ghost" onClick={dismiss}>Later</Button><Button size="sm" onClick={() => void install()}><IconDownload size={14} /> Update and restart</Button></div>}>
          Takes about a minute. Finish any sale in progress first — the app restarts when done.{state.notes ? ` What's new: ${state.notes}` : ""}
        </Alert>
      )}
      {state.status === "downloading" && <Alert tone="info" title={`Downloading update… ${pct}%`}>Keep the app open.</Alert>}
      {state.status === "ready" && <Alert tone="success" title="Installed — restarting">One moment.</Alert>}
      {state.status === "error" && <Alert tone="warning" title="Update didn't install">{state.error ?? "Try again later."} Your app keeps working as it is.</Alert>}
    </div>
  );
}
