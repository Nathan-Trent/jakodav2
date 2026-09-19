import { useCallback, useEffect, useState } from "react";
import { currentImpersonation, fetchNotices, markNoticeRead, subscribePresence, type Impersonation, type UserNotice } from "@zogal/auth-permissions";
import { PresenceBar } from "@zogal/ui";
import { getSupabase } from "@/lib/supabase";
import { useOnline } from "@/lib/useOnline";

/** Notices from Zogal Business and the "staff is signed in as you" bar. Pushed by the database (no polling); read once on open and on reconnect; silent offline. */
export function Presence() {
  const online = useOnline();
  const [notices, setNotices] = useState<UserNotice[]>([]);
  const [imp, setImp] = useState<Impersonation | null>(null);
  const load = useCallback(async () => {
    if (!navigator.onLine) return;
    const db = getSupabase();
    const [n, i] = await Promise.all([fetchNotices(db), currentImpersonation(db)]);
    setNotices(n); setImp(i);
  }, []);
  // Subscribe once; every change to my rows re-reads. Coming back online re-subscribes (supabase-js) and re-reads.
  useEffect(() => subscribePresence(getSupabase(), () => void load()), [load]);
  useEffect(() => { if (online) void load(); }, [online, load]);
  if (!imp && notices.every((n) => n.read_at)) return null;
  return (
    <div className="px-8 pt-5">
      <PresenceBar notices={notices} impersonation={imp} onDismiss={(id) => { setNotices((ns) => ns.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))); void markNoticeRead(getSupabase(), id); }} />
    </div>
  );
}
