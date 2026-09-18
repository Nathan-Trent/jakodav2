import { useEffect, useState } from "react";
import { IconBellRinging, IconUserShield, IconX } from "@tabler/icons-react";
import { Alert } from "./Alert.js";
import { cn } from "../lib/utils.js";

/**
 * Two things the Zogal Business back office can put in front of a user:
 *   - a NOTICE (a message sent on behalf of Doka) — shown once, dismissable
 *   - an IMPERSONATION — a red bar that says a member of Zogal staff is
 *     signed in as them right now, and until when. Never hidden.
 * Data comes from the app (it owns the Supabase client); this just draws.
 */
export interface NoticeItem { id: string; title: string; body: string | null; read_at: string | null; created_at: string }
export interface ImpersonationInfo { staff: string | null; expires_at: string }

export function PresenceBar({ notices, impersonation, onDismiss, className }: {
  notices: NoticeItem[]; impersonation: ImpersonationInfo | null; onDismiss: (id: string) => void; className?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const unread = notices.filter((n) => !n.read_at);
  if (!impersonation && unread.length === 0) return null;
  const mins = impersonation ? Math.max(0, Math.round((Date.parse(impersonation.expires_at) - now) / 60_000)) : 0;
  return (
    <div className={cn("grid gap-2", className)}>
      {impersonation && (
        <div className="flex items-center gap-3 rounded-[10px] bg-status-red text-white px-4 py-2.5 text-small font-semibold">
          <IconUserShield size={18} className="shrink-0" />
          <span className="flex-1">Zogal support{impersonation.staff ? ` (${impersonation.staff})` : ""} is signed in as you to help with a problem. Ends in {mins} min. Payments and plan changes are paused meanwhile.</span>
        </div>
      )}
      {unread.map((n) => (
        <Alert key={n.id} tone="info" title={n.title}
          action={<button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={() => onDismiss(n.id)}><IconX size={16} /></button>}>
          <span className="inline-flex items-start gap-2"><IconBellRinging size={14} className="mt-0.5 shrink-0" /><span className="whitespace-pre-line">{n.body ?? ""}</span></span>
          <div className="text-caption text-muted-foreground mt-1">From Doka · {new Date(n.created_at).toLocaleDateString()}</div>
        </Alert>
      ))}
    </div>
  );
}
