import { useState } from "react";
import { Toaster, LoadingMark } from "@zogal/ui";
import { AppShell } from "@/components/AppShell";
import { SessionProvider, useSession } from "@/lib/session";
import { SyncProvider, useSync } from "@/lib/sync";
import { ShopDataProvider } from "@/lib/shopData";
import { NAV, visibleNav, type PageKey } from "@/lib/nav";
import { LoginScreen } from "@/screens/LoginScreen";
import { SetupScreen } from "@/screens/SetupScreen";
import { DashboardScreen } from "@/screens/DashboardScreen";
import { PosScreen } from "@/screens/PosScreen";
import { SalesScreen } from "@/screens/SalesScreen";
import { CustomersScreen } from "@/screens/CustomersScreen";
import { NotebookScreen } from "@/screens/NotebookScreen";
import { ItemsScreen } from "@/screens/ItemsScreen";
import { DevicesScreen } from "@/screens/DevicesScreen";
import { PurchasesScreen } from "@/screens/PurchasesScreen";
import { ExpensesScreen } from "@/screens/ExpensesScreen";
import { TaxScreen } from "@/screens/TaxScreen";
import { ComingSoonScreen } from "@/screens/ComingSoonScreen";
import { ConflictsScreen } from "@/screens/ConflictsScreen";
import { GateBanner, LockedScreen } from "@/components/GateBanner";

export function App() {
  return (
    <SessionProvider>
      <SyncProvider>
        <ShopDataProvider>
          <Router />
          <Toaster position="top-center" richColors />
        </ShopDataProvider>
      </SyncProvider>
    </SessionProvider>
  );
}

/** Screen selection is pure state — no router lib needed for a POS. */
function Router() {
  const { status, active, device } = useSession();
  const { gate } = useSync();
  const [page, setPage] = useState<PageKey>("dashboard");

  if (status === "loading") {
    return <LoadingMark label="Starting up…" />;
  }
  if (status === "signed-out") return <LoginScreen />;
  // Need a shop membership AND (for now) a bound terminal before selling.
  if (!active || !device) return <SetupScreen />;

  // Guard: a page the role can't see falls back to the dashboard.
  const allowed = visibleNav(active.permissions);
  const current = allowed.find((n) => n.key === page) ?? allowed[0] ?? NAV[0]!;

  let content: React.ReactNode;
  if (current.comingIn) content = <ComingSoonScreen item={current} />;
  else if (current.key === "conflicts") content = <ConflictsScreen />;
  else if (current.key === "sell") content = <PosScreen />;
  else if (current.key === "sales") content = <SalesScreen />;
  else if (current.key === "customers") content = <CustomersScreen />;
  else if (current.key === "notebook") content = <NotebookScreen />;
  else if (current.key === "items") content = <ItemsScreen />;
  else if (current.key === "devices") content = <DevicesScreen />;
  else if (current.key === "purchases") content = <PurchasesScreen />;
  else if (current.key === "expenses") content = <ExpensesScreen />;
  else if (current.key === "tax") content = <TaxScreen />;
  else content = <DashboardScreen onNavigate={setPage} />;

  // SYNC: a locked terminal shows nothing but the way to unlock it.
  return (
    <AppShell page={current.key} onNavigate={setPage}>
      {gate?.level === "locked" ? <LockedScreen /> : <><GateBanner />{content}</>}
    </AppShell>
  );
}
