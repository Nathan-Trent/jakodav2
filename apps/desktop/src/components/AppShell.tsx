import { useState, type ReactNode } from "react";
import { IconLogout } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { visibleNav, type PageKey } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * Sidebar frame. Forest sidebar (brand foundation holds the frame),
 * near-white content. Nav is role-gated; unbuilt sections are shown with a
 * "soon" mark so the product reads as one system.
 */
export function AppShell({ page, onNavigate, children }: { page: PageKey; onNavigate: (p: PageKey) => void; children: ReactNode }) {
  const { ctx, active, device, signOut } = useSession();
  const nav = visibleNav(active!.permissions);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="h-full grid grid-cols-[232px_minmax(0,1fr)]">
      <aside className="bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-[10px] bg-brand-action grid place-items-center text-white font-extrabold">J</div>
            <div className="leading-tight">
              <div className="font-extrabold tracking-tight">Jakoda</div>
              <div className="text-micro text-sidebar-muted">Point of sale</div>
            </div>
          </div>
        </div>

        <nav className="px-3 grid gap-0.5">
          {nav.map((n) => {
            const activeItem = n.key === page;
            return (
              <button
                key={n.key}
                onClick={() => onNavigate(n.key)}
                className={cn(
                  "flex items-center gap-3 rounded-[10px] px-3 h-10 text-[13px] font-semibold transition-colors text-left",
                  activeItem
                    ? "bg-white/10 text-sidebar-active"
                    : "text-sidebar-muted hover:text-sidebar-foreground hover:bg-white/5",
                )}
              >
                <n.icon size={19} stroke={1.75} className="shrink-0" />
                <span className="flex-1">{n.label}</span>
                {n.comingIn && <span className="text-micro text-sidebar-muted/70 font-medium">soon</span>}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto px-5 py-4 border-t border-white/10 grid gap-3">
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
          <button
            disabled={signingOut}
            onClick={() => { setSigningOut(true); void signOut().finally(() => setSigningOut(false)); }}
            className="flex items-center gap-2 text-[13px] text-sidebar-muted hover:text-sidebar-foreground transition-colors"
          >
            <IconLogout size={16} stroke={1.75} /> Sign out
          </button>
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto">{children}</main>
    </div>
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
