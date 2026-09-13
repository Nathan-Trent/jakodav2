import { IconAlertTriangle, IconCloudCheck, IconCloudUpload, IconLock, IconRefresh, IconWifiOff } from "@tabler/icons-react";
import { useSync } from "@/lib/sync";
import { cn } from "@zogal/ui";

/**
 * SYNC status, always visible in the sidebar (Nielsen #1).
 *
 * It answers the three questions a shop owner actually has, in order:
 * am I connected, is anything unsent, and can I still sell?
 */
export function SyncBadge({ collapsed }: { collapsed: boolean }) {
  const { status, gate, syncNow } = useSync();
  if (!status) return null;

  const pending = status.pendingCount;
  const blocked = gate && gate.level !== "full";
  const warn = gate?.warn ?? false;

  const tone = blocked ? "bad" : warn || !status.online || pending > 0 ? "warn" : "good";
  const Icon = blocked
    ? IconLock
    : !status.online
      ? IconWifiOff
      : status.syncing
        ? IconRefresh
        : pending > 0
          ? IconCloudUpload
          : IconCloudCheck;

  const label = blocked
    ? gate!.level === "locked" ? "Locked" : "Read-only"
    : status.syncing
      ? "Syncing…"
      : pending > 0
        ? `${pending} unsent`
        : !status.online
          ? "Offline"
          : "Synced";

  const title = [
    gate?.title,
    gate?.action,
    status.lastSyncAt ? `Last sync ${status.lastSyncAt.toLocaleString()}` : "Never synced",
    pending > 0 ? `${pending} action(s) waiting to send` : null,
  ].filter(Boolean).join(" · ");

  return (
    <button
      onClick={syncNow}
      title={title}
      className={cn(
        "flex items-center gap-2 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-white/5 w-full",
        collapsed && "justify-center px-0",
      )}
    >
      <span className="relative flex shrink-0">
        <Icon
          size={15}
          className={cn(
            status.syncing && "animate-spin",
            tone === "good" && "text-brand-signal",
            tone === "warn" && "text-status-amber",
            tone === "bad" && "text-status-red",
          )}
        />
        {collapsed && pending > 0 && (
          <span className="absolute -right-1.5 -top-1.5 size-2 rounded-full bg-status-amber" />
        )}
      </span>
      {!collapsed && (
        <span className={cn("text-caption truncate", tone === "bad" ? "text-status-red" : "text-sidebar-muted")}>
          {label}
        </span>
      )}
      {!collapsed && warn && !blocked && <IconAlertTriangle size={13} className="text-status-amber shrink-0" />}
    </button>
  );
}
