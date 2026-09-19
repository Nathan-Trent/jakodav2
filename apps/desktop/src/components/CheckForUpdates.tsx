import { IconDownload } from "@tabler/icons-react";
import { Button } from "@zogal/ui";
import { isTauri, useUpdaterCtx } from "@/lib/updater";

/** Manual override for the auto-updater; lives in the dashboard header (Nathan: not the side panel). */
export function CheckForUpdates() {
  const updater = useUpdaterCtx();
  if (!isTauri()) return null;
  const checking = updater.state.status === "checking" || updater.state.status === "downloading";
  return (
    <Button variant="outline" disabled={checking} onClick={() => void updater.checkNow()} title="Doka also checks by itself every few hours">
      <IconDownload size={16} className={checking ? "animate-pulse" : undefined} /> {checking ? "Checking…" : "Check for updates"}
    </Button>
  );
}
