import { Alert, Badge, Card, CardContent } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useAsync } from "@/lib/useAsync";

interface Sub { status: "active" | "past_due" | "cancelled"; plan: string; expires_at: string | null }

/**
 * Subscription (TRD §7): what the offline gating enforces. Read-only for the
 * owner in this stage — payments are their own unit of work; Zogal's back
 * office sets status and expiry (admin_set_subscription).
 */
export function SubscriptionScreen() {
  const { active } = useSession();
  const shop = active!.shop;
  const sub = useAsync(async () => {
    const { data, error } = await getSupabase().from("subscriptions").select("status, plan, expires_at").eq("shop_id", shop.id).single<Sub>();
    if (error) throw error; return data;
  }, [shop.id]);
  const s = sub.data;
  const days = s?.expires_at ? Math.ceil((Date.parse(s.expires_at) - Date.now()) / 86_400_000) : null;

  return (
    <>
      <PageHeader title="Subscription" description="What keeps the terminals running." />
      <Page>
        {sub.error && <Alert tone="warning" title="Couldn't load">{sub.error}</Alert>}
        {s && (
          <div className="grid sm:grid-cols-3 gap-4">
            <Card className="py-5 gap-0 bg-brand-forest text-white border-transparent"><CardContent className="px-5 grid gap-1">
              <div className="text-micro text-white/60">Status</div>
              <div className="figure figure-lg capitalize">{s.status.replace("_", " ")}</div>
              <div className="text-caption text-white/60">Plan: {s.plan}</div>
            </CardContent></Card>
            <Card className="py-5 gap-0"><CardContent className="px-5 grid gap-1">
              <div className="text-micro text-muted-foreground">Expires</div>
              <div className="figure figure-lg">{s.expires_at ? new Date(s.expires_at).toLocaleDateString() : "—"}</div>
              <div className="text-caption text-muted-foreground">{s.expires_at ? (days! >= 0 ? `${days} days left` : `${-days!} days ago`) : "No expiry set"}</div>
            </CardContent></Card>
            <Card className="py-5 gap-0"><CardContent className="px-5 grid gap-1">
              <div className="text-micro text-muted-foreground">Terminals</div>
              <div className="flex gap-1 mt-1">{days !== null && days < 0 ? <Badge variant="warning">In grace / read-only window</Badge> : <Badge variant="success">Full use</Badge>}</div>
              <div className="text-caption text-muted-foreground">After expiry: a few days of normal use, then read-only, then locked — until renewed.</div>
            </CardContent></Card>
          </div>
        )}
        <Alert tone="info" title="Renewals">Payment inside the dashboard is coming. For now, contact Zogal to renew or change plan; it takes effect on the terminals at their next sync.</Alert>
      </Page>
    </>
  );
}
