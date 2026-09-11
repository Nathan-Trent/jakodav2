import { IconRefresh } from "@tabler/icons-react";
import { asOf, useShopData } from "@/lib/shopData";
import { useSync } from "@/lib/sync";
import { cn } from "@/lib/utils";

/**
 * "Showing what this terminal last downloaded."
 *
 * Deliberately a quiet line, not an alert: working offline is a normal state
 * in a Nigerian shop, not a fault, and a red banner every few seconds is the
 * "constantly complaining" failure. It states the age of the data and offers
 * a retry, and otherwise gets out of the way (Nielsen #1 without #9 noise).
 */
export function StaleNotice({ className }: { className?: string }) {
  const { stale, lastUpdatedAt, refreshing, refresh } = useShopData();
  const { status } = useSync();
  if (!stale) return null;

  const offline = status ? !status.online : !navigator.onLine;

  return (
    <div className={cn("flex items-center gap-2 text-caption text-muted-foreground", className)}>
      <span className="size-1.5 rounded-full bg-status-amber shrink-0" />
      <span>
        {offline ? "Offline" : "Can't reach the server"} — showing data as of {asOf(lastUpdatedAt)}
        {status && status.pendingCount > 0 && ` · ${status.pendingCount} sale(s) waiting to upload`}
      </span>
      <button
        onClick={() => void refresh()}
        disabled={refreshing}
        className="inline-flex items-center gap-1 underline hover:text-foreground disabled:opacity-50"
      >
        <IconRefresh size={12} className={refreshing ? "animate-spin" : undefined} /> Retry
      </button>
    </div>
  );
}
