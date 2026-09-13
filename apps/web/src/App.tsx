import { useEffect, useState } from "react";
import { Alert, Button, LoadingMark, Toaster } from "@zogal/ui";
import { Shell } from "@/components/Shell";
import { SessionProvider, useSession } from "@/lib/session";
import { pageFromPath, pathFor, visibleNav, type PageKey } from "@/lib/nav";
import { LoginScreen } from "@/screens/LoginScreen";
import { OverviewScreen } from "@/screens/OverviewScreen";
import { ReportsScreen } from "@/screens/ReportsScreen";
import { StaffScreen } from "@/screens/StaffScreen";
import { DevicesScreen } from "@/screens/DevicesScreen";
import { TaxScreen } from "@/screens/TaxScreen";
import { ConflictsScreen } from "@/screens/ConflictsScreen";
import { SubscriptionScreen } from "@/screens/SubscriptionScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { AdminShopsScreen } from "@/screens/admin/AdminShopsScreen";
import { AdminPlatformScreen } from "@/screens/admin/AdminPlatformScreen";
import { AdminOpsScreen } from "@/screens/admin/AdminOpsScreen";

export function App() {
  return (
    <SessionProvider>
      <Router />
      <Toaster position="top-center" richColors />
    </SessionProvider>
  );
}

/** Path-based pages so links and the back button work; no router library. */
function Router() {
  const { status, ctx, active, admin, signOut } = useSession();
  const [page, setPage] = useState<PageKey>(() => pageFromPath(location.pathname));

  useEffect(() => {
    const onPop = () => setPage(pageFromPath(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (p: PageKey) => { history.pushState(null, "", pathFor(p)); setPage(p); };

  if (status === "loading") return <LoadingMark label="Starting up…" />;
  if (status === "signed-out") return <LoginScreen />;

  if (!active && !admin) {
    return (
      <div className="min-h-full grid place-items-center p-8">
        <Alert tone="info" title="No shop yet" action={<Button variant="outline" size="sm" onClick={() => void signOut()}>Sign out</Button>}>
          {ctx?.user?.full_name}, your account isn't a member of any shop. Create the shop from the desktop app, or ask the owner to invite you.
        </Alert>
      </div>
    );
  }

  const allowed = visibleNav(active?.permissions ?? [], admin);
  const current = allowed.find((n) => n.key === page) ?? allowed[0]!;

  let content: React.ReactNode;
  switch (current.key) {
    case "reports": content = <ReportsScreen />; break;
    case "staff": content = <StaffScreen />; break;
    case "devices": content = <DevicesScreen />; break;
    case "tax": content = <TaxScreen />; break;
    case "conflicts": content = <ConflictsScreen />; break;
    case "subscription": content = <SubscriptionScreen />; break;
    case "settings": content = <SettingsScreen />; break;
    case "admin_shops": content = <AdminShopsScreen />; break;
    case "admin_platform": content = <AdminPlatformScreen />; break;
    case "admin_ops": content = <AdminOpsScreen />; break;
    default: content = active ? <OverviewScreen onNavigate={navigate} /> : <AdminShopsScreen />;
  }
  return <Shell page={current.key} onNavigate={navigate}>{content}</Shell>;
}
