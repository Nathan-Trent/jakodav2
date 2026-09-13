import type { ReactNode } from "react";
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconXboxX } from "@tabler/icons-react";
import { cn } from "../lib/utils.js";

/**
 * Inline, persistent message — for state that must stay visible (unlike a
 * toast): a blocked action, an offline warning, an empty state with a next
 * step. Colours come from the status system only.
 */
export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "success" | "warning" | "critical";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = { info: IconInfoCircle, success: IconCircleCheck, warning: IconAlertTriangle, critical: IconXboxX }[tone];
  return (
    <div
      role={tone === "critical" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-[12px] border px-4 py-3",
        tone === "info" && "bg-muted border-border",
        tone === "success" && "bg-[#DCFCE7] border-[#BBF7D0] text-[#14532D]",
        tone === "warning" && "bg-[#FEF9C3] border-[#FDE68A] text-[#713F12]",
        tone === "critical" && "bg-[#FEE2E2] border-[#FECACA] text-[#7F1D1D]",
        className,
      )}
    >
      <Icon size={18} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 grid gap-0.5">
        <div className="text-small font-semibold">{title}</div>
        {children && <div className="text-small opacity-90">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
