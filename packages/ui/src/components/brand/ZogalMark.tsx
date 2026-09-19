import { cn } from "../../lib/utils.js";

// Vite base ("/" or "/webapp/" for the partner web build) so the file resolves wherever the app is served.
const BASE: string = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";

/**
 * The Zogal mark — the ribbon Z. Copied into this project (public/brand) so
 * Doka carries its own assets and never depends on the zogal.app repo.
 *
 * It is artwork with a gradient, not a shape, so it cannot be recoloured —
 * no token applies to it and it renders identically in both themes. Served
 * at the size it is drawn: 128px, with a 2x for dense screens.
 */
export function ZogalMark({ size = 28, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <img
      src={`${BASE}brand/zogal-mark-128.png`}
      srcSet={`${BASE}brand/zogal-mark-128.png 1x, ${BASE}brand/zogal-mark-256.png 2x`}
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

/** The product name is "Doka by Zogal" (Nathan, 2026-09-17) — Doka is the product, Zogal the maker. */
export const PRODUCT_NAME = "Doka";
export const PRODUCT_BY = "by Zogal";

/** Mark + product name. `sub` replaces the "by Zogal" line for variants (e.g. "Back office"). */
export function ZogalLockup({ size = 32, sub = PRODUCT_BY, className }: { size?: number; sub?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5 min-w-0", className)}>
      <ZogalMark size={size} className="shrink-0" />
      <div className="leading-tight min-w-0">
        <div className="font-extrabold tracking-tight">{PRODUCT_NAME}</div>
        {sub && <div className="text-micro text-sidebar-muted">{sub}</div>}
      </div>
    </div>
  );
}
