import { cn } from "../../lib/utils.js";

/**
 * The Zogal mark — the ribbon Z. Copied into this project (public/brand) so
 * Zogal ERP carries its own assets and never depends on the zogal.app repo.
 *
 * It is artwork with a gradient, not a shape, so it cannot be recoloured —
 * no token applies to it and it renders identically in both themes. Served
 * at the size it is drawn: 128px, with a 2x for dense screens.
 */
export function ZogalMark({ size = 28, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <img
      src="/brand/zogal-mark-128.png"
      srcSet="/brand/zogal-mark-128.png 1x, /brand/zogal-mark-256.png 2x"
      alt=""
      width={size}
      height={size}
      aria-hidden
      draggable={false}
      className={className}
      style={{ width: size, height: size, objectFit: "contain", ...style }}
    />
  );
}

/** Mark + name. Horizontal here (desktop sidebar), unlike the app's stacked lockup. */
export function ZogalLockup({ size = 32, sub = "ERP", className }: { size?: number; sub?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5 min-w-0", className)}>
      <ZogalMark size={size} className="shrink-0" />
      <div className="leading-tight min-w-0">
        <div className="font-extrabold tracking-tight">Zogal</div>
        {sub && <div className="text-micro text-sidebar-muted">{sub}</div>}
      </div>
    </div>
  );
}
