import { ZogalMark } from "./ZogalMark.js";
import { cn } from "../../lib/utils.js";

/**
 * The ink cover beside a sign-in form — Doka's name plate, the same one the
 * product page opens with. No leaves: a stamp, the name, a ruled promise.
 * Shared by the desktop till and the web dashboard so both doors match.
 */
export function AuthCover({ sub = "by Zogal", stamp = "Product 01", title = "The till that knows your profit.", line, className }: {
  sub?: string; stamp?: string; title?: string; line?: string; className?: string;
}) {
  return (
    <aside className={cn("relative bg-brand-forest text-white p-8 md:p-10 flex flex-col overflow-hidden", className)}>
      <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full" style={{ background: "radial-gradient(circle, rgba(255,180,163,0.18) 0%, transparent 65%)" }} />
      <div className="relative flex items-center gap-2.5">
        <ZogalMark size={30} />
        <span className="text-title">Doka <span className="text-white/55 font-semibold">{sub}</span></span>
      </div>
      <div className="relative mt-auto grid gap-4 max-w-md">
        <span className="stamp text-brand-signal w-fit">{stamp}</span>
        <h2 className="text-display leading-[1.02]" style={{ fontSize: 40 }}>{title}</h2>
        <div className="border-t-2 border-white/30 pt-4 text-subheading text-white/70 font-medium">
          {line ?? "Sales, stock and true profit — recorded as they happen, even with no network."}
        </div>
      </div>
    </aside>
  );
}
