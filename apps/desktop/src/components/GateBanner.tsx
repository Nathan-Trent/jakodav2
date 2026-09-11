import { IconLock, IconRefresh } from "@tabler/icons-react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { LoadingMark } from "@/components/brand/LoadingMark";
import { useSync } from "@/lib/sync";

/**
 * SYNC / subscription gating, made visible rather than mysterious.
 *
 * A till that silently stops accepting sales is the worst possible failure in
 * a shop. So the state is always named, the cause is always given, and the way
 * out is always one sentence (Nielsen #1, #9).
 */
export function GateBanner() {
  const { gate, status, syncNow } = useSync();
  if (!gate || gate.level === "full") {
    return gate?.warn ? <GateWarning /> : null;
  }

  return (
    <div className="px-8 pt-5">
      <Alert
        tone={gate.level === "locked" ? "critical" : "warning"}
        title={gate.title}
        action={
          <Button size="sm" variant="outline" onClick={syncNow} disabled={status?.syncing}>
            <IconRefresh size={14} className={status?.syncing ? "animate-spin" : undefined} /> Sync now
          </Button>
        }
      >
        {gate.action}
        {gate.daysUntilNextStep !== null && ` (${gate.daysUntilNextStep} day(s) left)`}
      </Alert>
    </div>
  );
}

function GateWarning() {
  const { gate, status, syncNow } = useSync();
  if (!gate?.warn) return null;
  return (
    <div className="px-8 pt-5">
      <Alert
        tone="warning"
        title={gate.title}
        action={<Button size="sm" variant="outline" onClick={syncNow} disabled={status?.syncing}>Sync now</Button>}
      >
        {gate.action}
      </Alert>
    </div>
  );
}

/** Full-screen stop for a locked terminal. Nothing behind it is reachable. */
export function LockedScreen() {
  const { gate, status, syncNow } = useSync();
  return (
    <div className="h-full grid place-items-center p-10">
      <div className="max-w-md text-center grid gap-5 justify-items-center">
        <div className="size-14 rounded-full bg-status-red/10 text-status-red grid place-items-center">
          <IconLock size={26} />
        </div>
        <div className="grid gap-2">
          <h1 className="text-heading">{gate?.title ?? "This terminal is locked"}</h1>
          <p className="text-small text-muted-foreground">{gate?.action}</p>
          {status?.pendingCount ? (
            <p className="text-small text-muted-foreground">
              {status.pendingCount} sale(s) recorded here are still waiting to send. They are safe and will upload as soon as it connects.
            </p>
          ) : null}
        </div>
        <Button onClick={syncNow} disabled={status?.syncing}>
          <IconRefresh size={16} className={status?.syncing ? "animate-spin" : undefined} /> Try to sync
        </Button>
        {status?.syncing && <LoadingMark label="Reaching the server…" size={40} />}
      </div>
    </div>
  );
}
