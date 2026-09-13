import { useEffect, useState } from "react";
import { Alert, Button, LoadingMark, Toaster } from "@zogal/ui";
import { Shell } from "@/components/Shell";
import { SessionProvider, useSession } from "@/lib/session";
import { ADMIN_NAV, adminPageFromPath, adminPath, isAdminPath, shopPageFromPath, shopPath, visibleShopNav, type AdminPage, type ShopPage } from "@/lib/nav";
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
  const admin = isAdminPath(location.pathname);
  return (
    <SessionProvider>
      {admin ? <AdminRouter /> : <ShopRouter />}
      <Toaster position="top-center" richColors />
    </SessionProvider>
  );
}

function usePath<K extends string>(fromPath: (p: string) => K, toPath: (k: K) => string): [K, (k: K) => void] {
  const [page, setPage] = useState<K>(() => fromPath(location.pathname));
  useEffect(() => {
    const onPop = () => setPage(fromPath(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [fromPath]);
  return [page, (k) => { history.pushState(null, "", toPath(k)); setPage(k); }];
}

/** The shop owner's dashboard at `/`. */
function ShopRouter() {
  const { status, ctx, active, signOut } = useSession();
  const [page, navigate] = usePath<ShopPage>(shopPageFromPath, shopPath);

  if (status === "loading") return <LoadingMark label="Starting up…" />;
  if (status === "signed-out") return <LoginScreen />;
  if (!active) {
    return (
      <div className="min-h-full grid place-items-center p-8">
        <Alert tone="info" title="No shop yet" action={<Button variant="outline" size="sm" onClick={() => void signOut()}>Sign out</Button>}>
          {ctx?.user?.full_name}, your account isn't a member of any shop. Create the shop from the desktop app, or ask the owner to invite you.
        </Alert>
      </div>
    );
  }
  const allowed = visibleShopNav(active.permissions);
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
    default: content = <OverviewScreen onNavigate={navigate} />;
  }
  return <Shell items={allowed} page={current.key} onNavigate={navigate} variant="shop">{content}</Shell>;
}

/** The Zogal back office at `/admin` — platform admins only; Postgres refuses everyone else anyway. */
function AdminRouter() {
  const { status, admin, ctx, signOut } = useSession();
  const [page, navigate] = usePath<AdminPage>(adminPageFromPath, adminPath);

  if (status === "loading") return <LoadingMark label="Starting up…" />;
  if (status === "signed-out") return <LoginScreen variant="admin" />;
  if (!admin) {
    return (
      <div className="min-h-full grid place-items-center p-8">
        <Alert tone="warning" title="This is the Zogal back office"
          action={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => location.assign("/")}>Go to my shop</Button><Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button></div>}>
          {ctx?.user?.full_name}, your account isn't a platform admin. Your shop dashboard is at the main address.
        </Alert>
      </div>
    );
  }
  let content: React.ReactNode;
  switch (page) {
    case "platform": content = <AdminPlatformScreen />; break;
    case "ops": content = <AdminOpsScreen />; break;
    default: content = <AdminShopsScreen />;
  }
  return <Shell items={ADMIN_NAV} page={page} onNavigate={navigate} variant="admin">{content}</Shell>;
}
