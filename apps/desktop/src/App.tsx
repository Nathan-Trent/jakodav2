import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/AppShell";
import { SessionProvider, useSession } from "@/lib/session";
import { NAV, visibleNav, type PageKey } from "@/lib/nav";
import { LoginScreen } from "@/screens/LoginScreen";
import { SetupScreen } from "@/screens/SetupScreen";
import { DashboardScreen } from "@/screens/DashboardScreen";
import { PosScreen } from "@/screens/PosScreen";
import { ItemsScreen } from "@/screens/ItemsScreen";
import { DevicesScreen } from "@/screens/DevicesScreen";
import { PurchasesScreen } from "@/screens/PurchasesScreen";
import { ComingSoonScreen } from "@/screens/ComingSoonScreen";

export function App() {
  return (
    <SessionProvider>
      <Router />
      <Toaster position="top-center" richColors />
    </SessionProvider>
  );
}

/** Screen selection is pure state — no router lib needed for a POS. */
function Router() {
  const { status, active, device } = useSession();
  const [page, setPage] = useState<PageKey>("dashboard");

  if (status === "loading") {
    return <div className="min-h-full flex items-center justify-center text-small text-muted-foreground">Loading…</div>;
  }
  if (status === "signed-out") return <LoginScreen />;
  // Need a shop membership AND (for now) a bound terminal before selling.
  if (!active || !device) return <SetupScreen />;

  // Guard: a page the role can't see falls back to the dashboard.
  const allowed = visibleNav(active.permissions);
  const current = allowed.find((n) => n.key === page) ?? allowed[0] ?? NAV[0]!;

  let content: React.ReactNode;
  if (current.comingIn) content = <ComingSoonScreen item={current} />;
  else if (current.key === "sell") content = <PosScreen />;
  else if (current.key === "items") content = <ItemsScreen />;
  else if (current.key === "devices") content = <DevicesScreen />;
  else if (current.key === "purchases") content = <PurchasesScreen />;
  else content = <DashboardScreen onNavigate={setPage} />;

  return (
    <AppShell page={current.key} onNavigate={setPage}>
      {content}
    </AppShell>
  );
}
