import type { ReactNode } from "react";

/**
 * Frame for pre-shell screens (login, setup). Forest brand panel on the
 * left carries the product's promise; the form sits on near-white.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full grid grid-cols-[minmax(300px,2fr)_minmax(0,3fr)]">
      <aside className="relative bg-brand-forest text-white p-10 flex flex-col overflow-hidden">
        {/* ambient depth: one deep-green glow, kept subtle */}
        <div className="pointer-events-none absolute -bottom-24 -left-16 size-80 rounded-full" style={{ background: "radial-gradient(circle, rgba(22,163,74,0.28) 0%, transparent 70%)" }} />
        <div className="flex items-center gap-2.5">
          <div className="size-9 rounded-[10px] bg-brand-action grid place-items-center font-extrabold">J</div>
          <span className="text-title">Jakoda</span>
        </div>
        <div className="mt-auto grid gap-3 max-w-sm">
          <h2 className="text-display">Know your numbers. Every day.</h2>
          <p className="text-subheading text-white/70 font-medium">
            Sales, stock and true profit as they happen — and the records to back them up when it's time to file.
          </p>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 overflow-y-auto flex items-center justify-center p-10">{children}</main>
    </div>
  );
}
