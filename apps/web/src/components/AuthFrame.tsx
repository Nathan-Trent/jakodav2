import type { ReactNode } from "react";
import { AuthCover } from "@zogal/ui";

/** Frame for the sign-in screens: Doka's ink cover, the form on paper. Cover collapses to a strip on phones. */
export function AuthFrame({ children, sub = "by Zogal", title }: { children: ReactNode; sub?: string; title?: string }) {
  return (
    <div className="min-h-full grid md:grid-cols-[minmax(300px,2fr)_minmax(0,3fr)]">
      <AuthCover sub={sub} className="min-h-[200px] md:min-h-0 [&>div:last-child]:hidden md:[&>div:last-child]:grid" {...(title ? { title } : {})} />
      <main className="min-h-0 min-w-0 overflow-y-auto flex items-center justify-center p-6 md:p-10">{children}</main>
    </div>
  );
}
