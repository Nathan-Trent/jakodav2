import { useEffect, useState, type ReactNode } from "react";
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLogout, IconWifi, IconWifiOff } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { useOnline } from "@/lib/useOnline";
import { visibleNav, type PageKey } from "@/lib/nav";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "jakoda.sidebar.collapsed";

/**
 * Sidebar frame. Forest sidebar (brand foundation holds the frame),
 * near-white content. Nav is role-gated; unbuilt sections are shown with a
 * "soon" mark so the product reads as one system.
 *
 * Collapsible to an icon rail (remembered per terminal; Ctrl+B toggles).
 * Connection + terminal status stay visible in every state (Nielsen #1).
 */
export function AppShell({ page, onNavigate, children }: { page: PageKey; onNavigate: (p: PageKey) => void; children: ReactNode }) {
  const { ctx, active, device, signOut } = useSession();
  const online = useOnline();
  const nav = visibleNav(active!.permissions);
  const [signingOut, setSigningOut] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); setCollapsed((c) => !c); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={cn("h-full grid transition-[grid-template-columns] duration-200", collapsed ? "grid-cols-[68px_minmax(0,1fr)]" : "grid-cols-[232px_minmax(0,1fr)]")}>
      <aside className="bg-sidebar text-sidebar-foreground flex flex-col overflow-hidden">
        <div className={cn("flex items-center pt-5 pb-4", collapsed ? "justify-center px-0" : "justify-between px-5")}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="size-8 shrink-0 rounded-[10px] bg-brand-action grid place-items-center text-white font-extrabold">J</div>
            {!collapsed && (
              <div className="leading-tight min-w-0">
                <div className="font-extrabold tracking-tight">Jakoda</div>
                <div className="text-micro text-sidebar-muted">Point of sale</div>
              </div>
            )}
          </div>
          {!collapsed && <CollapseButton collapsed={collapsed} onClick={() => setCollapsed(true)} />}
        </div>
        {collapsed && <div className="flex justify-center pb-2"><CollapseButton collapsed onClick={() => setCollapsed(false)} /></div>}

        <nav className={cn("grid gap-0.5", collapsed ? "px-2.5" : "px-3")}>
          {nav.map((n) => {
            const activeItem = n.key === page;
            return (
              <button
                key={n.key}
                onClick={() => onNavigate(n.key)}
                title={collapsed ? `${n.label}${n.comingIn ? " (soon)" : ""}` : undefined}
                aria-current={activeItem ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-[10px] h-10 text-[13px] font-semibold transition-colors text-left",
                  collapsed ? "justify-center px-0" : "px-3",
                  activeItem
                    ? "bg-white/10 text-sidebar-active"
                    : "text-sidebar-muted hover:text-sidebar-foreground hover:bg-white/5",
                )}
              >
                <n.icon size={19} stroke={1.75} className="shrink-0" />
                {!collapsed && <span className="flex-1 truncate">{n.label}</span>}
                {!collapsed && n.comingIn && <span className="text-micro text-sidebar-muted/70 font-medium">soon</span>}
              </button>
            );
          })}
        </nav>

        <div className={cn("mt-auto border-t border-white/10 grid gap-3", collapsed ? "px-2.5 py-4 justify-items-center" : "px-5 py-4")}>
          {/* Status: connection + terminal — always visible */}
          <div className={cn("flex items-center gap-2", collapsed && "flex-col")} title={online ? "Connected" : "No connection — changes won't save until you're back online"}>
            <span className={cn("size-2 rounded-full", online ? "bg-brand-signal shadow-[0_0_8px_rgba(74,222,128,0.65)]" : "bg-status-amber shadow-[0_0_8px_rgba(252,211,77,0.65)]")} />
            {!collapsed && (
              <span className="text-caption text-sidebar-muted flex items-center gap-1">
                {online ? <IconWifi size={13} /> : <IconWifiOff size={13} />}
                {online ? "Connected" : "Offline"}
              </span>
            )}
          </div>

          {!collapsed && (
            <div className="grid gap-1">
              <div className="text-small font-semibold truncate">{active!.shop.name}</div>
              <div className="text-caption text-sidebar-muted truncate">{ctx?.user?.full_name}</div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline" className="border-white/20 text-sidebar-foreground/80">{active!.role.name}</Badge>
                {device ? (
                  <Badge variant="outline" className="border-brand-signal/40 text-brand-signal">Terminal on</Badge>
                ) : (
                  <Badge variant="outline" className="border-white/20 text-sidebar-muted">No terminal</Badge>
                )}
              </div>
            </div>
          )}
          <button
            disabled={signingOut}
            title="Sign out"
            onClick={() => { setSigningOut(true); void signOut().finally(() => setSigningOut(false)); }}
            className="flex items-center gap-2 text-[13px] text-sidebar-muted hover:text-sidebar-foreground transition-colors"
          >
            <IconLogout size={16} stroke={1.75} /> {!collapsed && "Sign out"}
          </button>
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto">{children}</main>
    </div>
  );
}

function CollapseButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const Icon = collapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse;
  return (
    <button
      onClick={onClick}
      title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`}
      aria-label={`${collapsed ? "Expand" : "Collapse"} sidebar`}
      className="size-8 rounded-[8px] grid place-items-center text-sidebar-muted hover:text-sidebar-foreground hover:bg-white/5 transition-colors"
    >
      <Icon size={18} stroke={1.75} />
    </button>
  );
}

/** Standard page header: title + optional description + actions. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-8 pt-7 pb-5">
      <div>
        <h1 className="text-heading">{title}</h1>
        {description && <p className="text-small text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
