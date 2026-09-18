import type { ReactNode } from "react";
import { AuthCover } from "@zogal/ui";

/** Frame for pre-shell screens (login, setup): Doka's ink cover on the left, the form on paper. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full grid grid-cols-[minmax(300px,2fr)_minmax(0,3fr)]">
      <AuthCover />
      <main className="min-h-0 min-w-0 overflow-y-auto flex items-center justify-center p-10">{children}</main>
    </div>
  );
}
