import { useEffect, useState } from "react";
import { IconRefresh, IconWifiOff, IconCloudOff } from "@tabler/icons-react";
import { Button } from "../ui/button.js";
import { ZogalMark } from "./ZogalMark.js";

/**
 * Never a blank screen (Nathan, 2026-09-18). Two situations, said plainly:
 *   offline  — the device has no internet at all
 *   unreachable — internet is fine but Doka's server can't be reached
 * Both offer Retry and, where it applies, say what still works.
 */
export function ConnectionScreen({ onRetry, firstTime = false, retrying = false, signOut }: {
  onRetry: () => void | Promise<void>;
  /** True when there is nothing cached — the user has never signed in on this device. */
  firstTime?: boolean;
  retrying?: boolean;
  signOut?: (() => void) | undefined;
}) {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const up = () => { setOnline(true); void onRetry(); };
    const down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, [onRetry]);

  const Icon = online ? IconCloudOff : IconWifiOff;
  const title = online ? "Can't reach Doka right now" : "No internet connection";
  const body = online
    ? "Your internet looks fine but Doka's server isn't answering. This usually clears in a minute."
    : firstTime
      ? "Doka needs a connection the first time you sign in on this computer. After that, it works offline."
      : "Connect to the internet to sign in. Sales you've already recorded are safe on this computer.";

  return (
    <div className="min-h-full h-full grid place-items-center bg-background p-8">
      <div className="max-w-sm w-full grid gap-5 text-center justify-items-center">
        <ZogalMark size={40} />
        <div className="size-14 rounded-full bg-muted grid place-items-center text-muted-foreground"><Icon size={26} /></div>
        <div className="grid gap-1.5">
          <h1 className="text-heading">{title}</h1>
          <p className="text-small text-muted-foreground">{body}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void onRetry()} disabled={retrying}><IconRefresh size={16} className={retrying ? "animate-spin" : undefined} /> {retrying ? "Trying…" : "Try again"}</Button>
          {signOut && <Button variant="ghost" onClick={signOut}>Sign out</Button>}
        </div>
        <p className="text-caption text-muted-foreground">Doka will retry by itself when the connection returns.</p>
      </div>
    </div>
  );
}
