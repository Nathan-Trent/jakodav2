import { useEffect, useState } from "react";
import { adminOperationalSettings, adminUpdateOperationalSettings } from "@zogal/auth-permissions";
import { Alert, Button, Card, CardContent, Input, Label, notifyError, notifySuccess } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { getSupabase } from "@/lib/supabase";
import { useAsync } from "@/lib/useAsync";

/** TRD §5.1 operational settings, in plain words. Devices receive them on their next heartbeat. */
const FIELDS: { key: string; label: string; help: string; unit: string }[] = [
  { key: "manager_pin_rotation_days", label: "Manager PIN rotates every", help: "How often a manager's override PIN changes.", unit: "days" },
  { key: "subscription_grace_days", label: "Grace after expiry", help: "Normal use continues this long after a subscription expires.", unit: "days" },
  { key: "read_only_window_days", label: "Read-only window", help: "After grace: terminals can look but not sell, for this long, then lock.", unit: "days" },
  { key: "mandatory_sync_days", label: "Must sync at least every", help: "A terminal offline longer than this goes read-only until it syncs.", unit: "days" },
  { key: "sync_warning_days", label: "Start warning at", help: "Days offline before the terminal starts nagging.", unit: "days" },
  { key: "clock_skew_tolerance_hours", label: "Clock skew tolerance", help: "A device clock further off than this is flagged.", unit: "hours" },
];

export function AdminOpsScreen() {
  const ops = useAsync(() => adminOperationalSettings(getSupabase()), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ops.data) setDraft(Object.fromEntries(Object.entries(ops.data.settings).map(([k, v]) => [k, String(v)])));
  }, [ops.data]);

  const changed = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => ops.data && String(ops.data.settings[k]) !== v && v !== "").map(([k, v]) => [k, Number(v)]),
  );
  const invalid = Object.values(changed).some((v) => !Number.isFinite(v) || v < 0);
  const n = Object.keys(changed).length;

  async function save() {
    setBusy(true);
    try {
      await adminUpdateOperationalSettings(getSupabase(), changed);
      notifySuccess("Operational settings saved", { description: "Terminals receive them at their next sync." });
      await ops.reload();
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Operational settings" description="How the terminals behave around sync, expiry and PINs."
        actions={<Button disabled={busy || invalid || n === 0} onClick={() => void save()}>{busy ? "Saving…" : n ? `Save ${n}` : "Save"}</Button>} />
      <Page>
        {ops.error && <Alert tone="warning" title="Couldn't load">{ops.error}</Alert>}
        <Card className="py-2 max-w-2xl"><CardContent className="px-5">
          <ul className="divide-y">
            {FIELDS.map((f) => (
              <li key={f.key} className="py-3 grid sm:grid-cols-[1fr_140px] gap-2 items-center">
                <div><Label htmlFor={`op-${f.key}`}>{f.label}</Label><div className="text-caption text-muted-foreground">{f.help}</div></div>
                <div className="flex items-center gap-2">
                  <Input id={`op-${f.key}`} inputMode="numeric" className="w-24" value={draft[f.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
                  <span className="text-caption text-muted-foreground">{f.unit}</span>
                </div>
              </li>
            ))}
          </ul>
          {ops.data && <p className="text-caption text-muted-foreground pt-3">Last changed {new Date(ops.data.updated_at).toLocaleString()}. Every change is kept in history.</p>}
        </CardContent></Card>
      </Page>
    </>
  );
}
