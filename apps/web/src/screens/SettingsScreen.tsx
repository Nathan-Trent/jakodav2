import { useState, type FormEvent } from "react";
import { Button, Card, CardContent, Input, Label, notifyError, notifySuccess } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

const TIMEZONES = ["Africa/Lagos", "Africa/Accra", "Africa/Nairobi", "Africa/Johannesburg", "Europe/London", "UTC"];

/** Shop details (shop.settings). Operational parameters are Zogal's, not the owner's — they live in the back office. */
export function SettingsScreen() {
  const { active, refresh } = useSession();
  const shop = active!.shop;
  const [name, setName] = useState(shop.name);
  const [tz, setTz] = useState(shop.timezone);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const { error } = await getSupabase().from("shops").update({ name: name.trim(), timezone: tz }).eq("id", shop.id);
      if (error) throw error;
      notifySuccess("Shop details saved");
      await refresh();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Settings" description="Shop details. The day boundary for figures follows the timezone." />
      <Page>
        <Card className="py-5 max-w-lg"><CardContent className="px-5">
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-2"><Label htmlFor="s-name">Shop name</Label><Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></div>
            <div className="grid gap-2"><Label htmlFor="s-tz">Timezone</Label>
              <select id="s-tz" className="h-9 rounded-md border bg-card px-2 text-sm" value={tz} onChange={(e) => setTz(e.target.value)}>
                {[...new Set([tz, ...TIMEZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
              </select></div>
            <div><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</Button></div>
          </form>
        </CardContent></Card>
      </Page>
    </>
  );
}
