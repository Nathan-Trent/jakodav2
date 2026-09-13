import { useState } from "react";
import { adminSetPlatformSetting, listPlatformSettings, platformSettingsHistory } from "@zogal/auth-permissions";
import { Alert, Button, Card, CardContent, Input, notifyError, notifySuccess } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { getSupabase } from "@/lib/supabase";
import { useAsync } from "@/lib/useAsync";

/**
 * Platform settings (0013): the keys Zogal's business sets — scan allowance,
 * model, toggles. Shop owners never see this. Every change is logged with
 * who changed it; the history is shown below.
 */
export function AdminPlatformScreen() {
  const settings = useAsync(() => listPlatformSettings(getSupabase()), []);
  const history = useAsync(() => platformSettingsHistory(getSupabase(), 30), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const shownValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  async function save(key: string, current: unknown) {
    const raw = drafts[key];
    if (raw === undefined) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; } // "5" → 5, "true" → true, plain text stays a string
    if (JSON.stringify(value) === JSON.stringify(current)) return;
    setBusy(key);
    try {
      await adminSetPlatformSetting(getSupabase(), key, value);
      notifySuccess(`${key} updated`);
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
      await Promise.all([settings.reload(), history.reload()]);
    } catch (e) { notifyError(e); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Platform settings" description="Business-side keys. Changes apply to every shop immediately and are logged." />
      <Page>
        {settings.error && <Alert tone="warning" title="Couldn't load">{settings.error}</Alert>}
        <Card className="py-2"><CardContent className="px-5">
          <ul className="divide-y">
            {(settings.data ?? []).map((s) => {
              const shown = drafts[s.key] ?? shownValue(s.value);
              const dirty = drafts[s.key] !== undefined && drafts[s.key] !== shownValue(s.value);
              return (
                <li key={s.key} className="py-3 grid sm:grid-cols-[1fr_220px_auto] gap-2 items-center">
                  <div><div className="font-mono text-small font-semibold">{s.key}</div><div className="text-caption text-muted-foreground">{s.description} · changed {new Date(s.updated_at).toLocaleDateString()}</div></div>
                  <Input value={shown} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void save(s.key, s.value); }} />
                  <Button size="sm" disabled={!dirty || busy === s.key} onClick={() => void save(s.key, s.value)}>{busy === s.key ? "Saving…" : "Save"}</Button>
                </li>
              );
            })}
          </ul>
        </CardContent></Card>
        <Card className="py-4"><CardContent className="px-5 grid gap-2">
          <div className="text-title">History</div>
          {(history.data ?? []).length === 0 ? <p className="text-small text-muted-foreground">No changes yet.</p> : (
            <ul className="divide-y">
              {history.data!.map((h) => (
                <li key={h.id} className="py-2 text-small flex flex-wrap gap-x-3 gap-y-1">
                  <span className="text-muted-foreground w-40">{new Date(h.changed_at).toLocaleString()}</span>
                  <span className="font-mono">{h.key}</span>
                  <span className="text-muted-foreground">{h.old_value === null ? "(new)" : JSON.stringify(h.old_value)} → {JSON.stringify(h.new_value)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent></Card>
      </Page>
    </>
  );
}
