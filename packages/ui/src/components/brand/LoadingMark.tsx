import { useEffect, useState } from "react";
import { ZogalMark } from "./ZogalMark.js";
import { cn } from "../../lib/utils.js";

/**
 * The app's one loading state — the breathing mark, matching zogal.app.
 *
 * It escalates rather than spinning forever (Nielsen #1 visibility, #9
 * recovery): a loader that never changes insists everything is fine while it
 * plainly is not. After a few seconds it says the connection is slow; after
 * twelve it admits failure and offers a way out. Offline skips to the end —
 * waiting twelve seconds to tell someone what their machine already knows is
 * theatre.
 *
 * Transform and opacity only, so it stays on the compositor.
 */
export function LoadingMark({
  label = "Loading…",
  size = 48,
  onRetry,
  className,
}: {
  label?: string;
  size?: number;
  onRetry?: () => void;
  className?: string;
}) {
  const stage = useStalledAfter();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={stage !== "stalled"}
      className={cn("flex flex-col items-center justify-center gap-4 p-8 text-center", className)}
    >
      <ZogalMark size={size} className={stage === "stalled" ? "opacity-35" : "animate-[zogal-breathe_2.4s_ease-in-out_infinite]"} />
      <p className={cn("max-w-[280px] text-small font-medium", stage === "stalled" ? "text-foreground" : "text-muted-foreground")}>
        {stage === "stalled"
          ? "Can't reach the server. Check your connection and try again — nothing you've saved is lost."
          : stage === "slow"
            ? "Still loading. Your connection looks slow."
            : label}
      </p>
      {stage === "stalled" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-10 rounded-[10px] border border-brand-action/25 bg-brand-action/10 px-5 text-small font-semibold text-brand-action"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** "loading" → "slow" after 4s → "stalled" after 12s (immediately if offline). */
function useStalledAfter(): "loading" | "slow" | "stalled" {
  const [stage, setStage] = useState<"loading" | "slow" | "stalled">(() =>
    typeof navigator !== "undefined" && !navigator.onLine ? "stalled" : "loading",
  );
  useEffect(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) { setStage("stalled"); return; }
    const a = window.setTimeout(() => setStage("slow"), 4000);
    const b = window.setTimeout(() => setStage("stalled"), 12000);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, []);
  return stage;
}
