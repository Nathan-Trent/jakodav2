import { SessionProvider, useSession } from "./lib/session.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { SetupScreen } from "./screens/SetupScreen.js";
import { PosScreen } from "./screens/PosScreen.js";

export function App() {
  return (
    <SessionProvider>
      <Router />
    </SessionProvider>
  );
}

/** Screen selection is pure state — no router lib needed for a POS. */
function Router() {
  const { status, active, device } = useSession();

  if (status === "loading") {
    return <div className="min-h-full flex items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (status === "signed-out") return <LoginScreen />;
  // Need a shop membership AND (for now) a bound terminal before selling.
  if (!active || !device) return <SetupScreen />;
  return <PosScreen />;
}
