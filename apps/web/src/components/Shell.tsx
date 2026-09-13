import { useState, type ReactNode } from "react";
import type { Icon } from "@tabler/icons-react";
import { IconLogout, IconMenu2, IconX } from "@tabler/icons-react";
import { Badge, ZogalLockup, ZogalMark, cn } from "@zogal/ui";
import { useSession } from "@/lib/session";
import { visibleNav, type PageKey } from "@/lib/nav";

/**
 * Dashboard frame — the desktop shell's sibling, made for a phone as much as
 * a laptop (TRD: V2 mobile is this dashboard made mobile-friendly). Forest
 * sidebar on wide screens; a top bar with a drawer below 900px. Shop
 * switcher for owners of more than one shop. Back-office section appears
 * only for platform admins.
 */
export function Shell({ page, onNavigate, children }: { page: PageKey; onNavigate: (p: PageKey) => void; children: ReactNode }) {
  const { ctx, active, admin, setActiveShop, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const nav = visibleNav(active?.permissions ?? [], admin);
  const shopNav = nav.filter((n) => n.section === "shop");
  const adminNav = nav.filter((n) => n.section === "admin");

  const menu = (
    <>
      <nav className="grid gap-0.5 px-3">
        {shopNav.map((n) => <NavButton key={n.key} active={n.key === page} icon={n.icon} label={n.label} onClick={() => { onNavigate(n.key); setOpen(false); }} />)}
      </nav>
      {adminNav.length > 0 && (
        <>
          <div className="px-6 pt-5 pb-1 text-micro text-sidebar-muted/80 uppercase tracking-wider">Zogal back office</div>
          <nav className="grid gap-0.5 px-3">
            {adminNav.map((n) => <NavButton key={n.key} active={n.key === page} icon={n.icon} label={n.label} onClick={() => { onNavigate(n.key); setOpen(false); }} />)}
          </nav>
        </>
      )}
      <div className="mt-auto border-t border-white/10 px-5 py-4 grid gap-3">
        {ctx && ctx.memberships.length > 1 ? (
          <label className="grid gap-1">
            <span className="text-micro text-sidebar-muted">Shop</span>
            <select className="h-9 rounded-md bg-white/10 px-2 text-sm text-sidebar-foreground" value={active?.shop.id ?? ""} onChange={(e) => setActiveShop(e.target.value)}>
              {ctx.memberships.map((m) => <option key={m.shop.id} value={m.shop.id} className="text-foreground">{m.shop.name}</option>)}
            </select>
          </label>
        ) : (
          <div className="text-small font-semibold truncate">{active?.shop.name ?? "No shop"}</div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-small truncate">{ctx?.user?.full_name}</div>
            <div className="flex gap-1 mt-0.5">{active && <Badge variant="outline" className="border-white/20 text-sidebar-muted">{active.role.name}</Badge>}{admin && <Badge variant="outline" className="border-white/20 text-sidebar-active">Admin</Badge>}</div>
          </div>
          <button className="text-sidebar-muted hover:text-sidebar-foreground" title="Sign out" onClick={() => void signOut()}><IconLogout size={18} /></button>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-full md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-20 bg-sidebar text-sidebar-foreground flex items-center justify-between px-4 h-14">
        <ZogalLockup size={28} sub="ERP" />
        <button aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>{open ? <IconX size={22} /> : <IconMenu2 size={22} />}</button>
      </header>
      {open && (
        <div className="md:hidden fixed inset-0 top-14 z-10 bg-sidebar text-sidebar-foreground flex flex-col pt-3 overflow-y-auto">{menu}</div>
      )}
      <aside className="hidden md:flex bg-sidebar text-sidebar-foreground flex-col sticky top-0 h-screen overflow-y-auto">
        <div className="flex items-center px-5 pt-5 pb-4"><ZogalLockup size={32} sub="ERP" /></div>
        {menu}
      </aside>
      <main className="min-w-0 bg-background">{children}</main>
    </div>
  );
}

function NavButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: Icon; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined}
      className={cn("flex items-center gap-3 rounded-[10px] h-10 px-3 text-[13px] font-semibold transition-colors text-left",
        active ? "bg-white/10 text-sidebar-active" : "text-sidebar-muted hover:text-sidebar-foreground hover:bg-white/5")}>
      <Icon size={19} stroke={1.75} className="shrink-0" /><span className="flex-1 truncate">{label}</span>
    </button>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 md:px-8 pt-6 md:pt-7 pb-5">
      <div><h1 className="text-heading">{title}</h1>{description && <p className="text-small text-muted-foreground mt-0.5">{description}</p>}</div>
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

/** Content padding that matches PageHeader on every width. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 md:px-8 pb-8 grid gap-4", className)}>{children}</div>;
}

export { ZogalMark };
