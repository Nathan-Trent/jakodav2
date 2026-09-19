import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardContent, notifyError, notifySuccess } from "@zogal/ui";
import { PageHeader, Page } from "@/components/Shell";
import { useSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";
import { useAsync } from "@/lib/useAsync";

interface Sub { status: "active" | "past_due" | "cancelled"; plan: string; expires_at: string | null; auto_renew: boolean }
interface Card { id: string; provider: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }
interface Usage { plan: string | null; limits: { terminals?: number; staff?: number }; terminals: number; staff: number }
interface Invoice { id: string; number: string; plan_key: string; period_start: string; period_end: string; amount: number; currency: string; status: "unpaid" | "paid" | "void"; provider: string | null; paid_at: string | null; created_at: string }
interface Plan { key: string; name: string; tagline: string | null; price_monthly: number; price_yearly: number | null; features: string[]; limits: { terminals?: number; staff?: number }; highlight: boolean }

/**
 * Subscription (TRD §7): what the offline gating enforces, what the plan
 * allows (0017 plan gating), the invoices Zogal has raised, and paying them.
 * Checkout starts on Zogal's server (the provider keys live there, never in
 * this bundle); the payer comes back here and we confirm at once.
 */
const PAY_API = import.meta.env.VITE_PAY_API_URL ?? "https://ops.business.zogal.app";
const naira = (n: number) => `₦${Number(n).toLocaleString("en-NG")}`;

export function SubscriptionScreen() {
  const { active } = useSession();
  const shop = active!.shop;
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  const data = useAsync(async () => {
    const db = getSupabase();
    const [s, u, inv, plans, cards] = await Promise.all([
      db.from("subscriptions").select("status, plan, expires_at, auto_renew").eq("shop_id", shop.id).single<Sub>(),
      db.rpc("shop_plan_usage", { p_shop_id: shop.id }),
      db.from("invoices").select("id, number, plan_key, period_start, period_end, amount, currency, status, provider, paid_at, created_at").eq("shop_id", shop.id).order("created_at", { ascending: false }).limit(24),
      db.from("pricing_plans").select("key, name, tagline, price_monthly, price_yearly, features, limits, highlight").eq("product", "doka").eq("is_visible", true).order("sort_order"),
      db.from("payment_methods_view").select("id, provider, brand, last4, exp_month, exp_year").eq("shop_id", shop.id).order("created_at", { ascending: false }),
    ]);
    if (s.error) throw s.error;
    if (u.error) throw u.error;
    if (inv.error) throw inv.error;
    if (plans.error) throw plans.error;
    if (cards.error) throw cards.error;
    return { sub: s.data, usage: u.data as Usage, invoices: (inv.data ?? []) as Invoice[], plans: (plans.data ?? []) as Plan[], cards: (cards.data ?? []) as Card[] };
  }, [shop.id, tick]);

  // Back from checkout: ?invoice=&provider=&reference=(&transaction_id=) → confirm with Zogal's server.
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const invoice = q.get("invoice"), provider = q.get("provider"), reference = q.get("reference") ?? q.get("tx_ref");
    if (!invoice || !provider || !reference) return;
    window.history.replaceState(null, "", window.location.pathname);
    setConfirming(invoice);
    void (async () => {
      try {
        const r = await payApi("/api/pay/confirm", { invoice_id: invoice, provider, reference, transaction_id: q.get("transaction_id") ?? undefined });
        if (r.ok) notifySuccess("Payment received", { description: "Your subscription has been extended. Terminals pick it up at their next sync." });
        else notifyError(new Error(r.error ?? "Payment not confirmed"));
      } catch (e) { notifyError(e); }
      setConfirming(null); reload();
    })();
  }, []);

  const [paying, setPaying] = useState<string | null>(null);
  // One button. Zogal chooses the provider on its side; the owner just pays.
  const pay = async (invoiceId: string) => {
    setPaying(invoiceId);
    try {
      const r = await payApi("/api/pay/init", { invoice_id: invoiceId });
      if (r.url) window.location.assign(r.url); else notifyError(new Error(r.error ?? "Couldn't start payment"));
    } catch (e) { notifyError(e); }
    setPaying(null);
  };

  // Card on file: remove it, or turn automatic renewal off/on. Own rows only (RLS).
  const [cardBusy, setCardBusy] = useState(false);
  const removeCard = async (id: string) => {
    setCardBusy(true);
    const { error } = await getSupabase().from("payment_methods").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) notifyError(error); else notifySuccess("Card removed", { description: "We won't charge it again. You'll get reminders before expiry instead." });
    setCardBusy(false); reload();
  };
  const setAutoRenew = async (on: boolean) => {
    setCardBusy(true);
    const { error } = await getSupabase().from("subscriptions").update({ auto_renew: on }).eq("shop_id", shop.id);
    if (error) notifyError(error); else notifySuccess(on ? "Automatic renewal on" : "Automatic renewal off");
    setCardBusy(false); reload();
  };

  const d = data.data;
  const s = d?.sub;
  const days = s?.expires_at ? Math.ceil((Date.parse(s.expires_at) - Date.now()) / 86_400_000) : null;
  const unpaid = d?.invoices.filter((i) => i.status === "unpaid") ?? [];
  const current = d?.plans.find((p) => p.key === s?.plan);

  return (
    <>
      <PageHeader title="Subscription" description="What keeps the terminals running, what your plan allows, and what is due." />
      <Page>
        {data.error && <Alert tone="warning" title="Couldn't load">{data.error}</Alert>}
        {confirming && <Alert tone="info" title="Confirming your payment…">One moment — checking with the payment provider.</Alert>}

        {unpaid.length > 0 && (
          <div className="grid gap-3">
            {unpaid.map((i) => (
              <Card key={i.id} className="py-4 gap-0 border-brand-coral/40"><CardContent className="px-5 flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[200px]">
                  <div className="font-semibold">Invoice {i.number} · {naira(i.amount)}</div>
                  <div className="text-caption text-muted-foreground">{planName(d!.plans, i.plan_key)} · {i.period_start} to {i.period_end}</div>
                </div>
                <Button disabled={paying === i.id} onClick={() => void pay(i.id)}>{paying === i.id ? "Opening secure payment…" : `Pay ${naira(i.amount)}`}</Button>
              </CardContent></Card>
            ))}
          </div>
        )}

        {s && d && (
          <div className="grid sm:grid-cols-3 gap-4">
            <Card className="py-5 gap-0 bg-brand-forest text-white border-transparent"><CardContent className="px-5 grid gap-1">
              <div className="text-micro text-white/60">Plan</div>
              <div className="figure figure-lg">{current?.name ?? s.plan}</div>
              <div className="text-caption text-white/60 capitalize">{s.status.replace("_", " ")}{current ? ` · ${naira(current.price_monthly)}/month` : ""}</div>
            </CardContent></Card>
            <Card className="py-5 gap-0"><CardContent className="px-5 grid gap-1">
              <div className="text-micro text-muted-foreground">Expires</div>
              <div className="figure figure-lg">{s.expires_at ? new Date(s.expires_at).toLocaleDateString() : "—"}</div>
              <div className="text-caption text-muted-foreground">{s.expires_at ? (days! >= 0 ? `${days} days left` : `${-days!} days ago — grace, then read-only`) : "No expiry set"}</div>
            </CardContent></Card>
            <Card className="py-5 gap-0"><CardContent className="px-5 grid gap-1">
              <div className="text-micro text-muted-foreground">In use</div>
              <div className="grid gap-1 mt-1 text-small">
                <UsageLine label="Terminals" used={d.usage.terminals} limit={d.usage.limits?.terminals} />
                <UsageLine label="Staff" used={d.usage.staff} limit={d.usage.limits?.staff} />
              </div>
              <div className="flex gap-1 mt-1">{days !== null && days < 0 ? <Badge variant="warning">In grace / read-only window</Badge> : <Badge variant="success">Full use</Badge>}</div>
            </CardContent></Card>
          </div>
        )}

        {s && d && (
          <Card className="py-4 gap-0"><CardContent className="px-5 flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[220px]">
              <div className="font-semibold">Renewal</div>
              {d.cards.length > 0 ? (
                <div className="text-caption text-muted-foreground">
                  Card on file: {d.cards[0]!.brand ?? "card"} •••• {d.cards[0]!.last4 ?? "????"}{d.cards[0]!.exp_month ? ` · expires ${String(d.cards[0]!.exp_month).padStart(2, "0")}/${d.cards[0]!.exp_year}` : ""}.
                  {s.auto_renew ? " We renew automatically a few days before expiry and email you a receipt." : " Automatic renewal is off — we'll remind you before expiry."}
                </div>
              ) : (
                <div className="text-caption text-muted-foreground">No card on file. Pay once online and we can renew automatically from then on — no card to re-enter.</div>
              )}
            </div>
            {d.cards.length > 0 && (
              <div className="flex gap-2">
                <Button variant="outline" disabled={cardBusy} onClick={() => void setAutoRenew(!s.auto_renew)}>{s.auto_renew ? "Turn auto-renew off" : "Turn auto-renew on"}</Button>
                <Button variant="ghost" disabled={cardBusy} onClick={() => void removeCard(d.cards[0]!.id)}>Remove card</Button>
              </div>
            )}
          </CardContent></Card>
        )}

        {d && d.plans.length > 0 && (
          <section className="grid gap-3">
            <h2 className="text-h3">Plans</h2>
            <div className="grid sm:grid-cols-3 gap-3">
              {d.plans.map((p) => (
                <Card key={p.key} className={`py-5 gap-0 ${p.key === s?.plan ? "border-brand-forest" : p.highlight ? "border-brand-coral/60" : ""}`}><CardContent className="px-5 grid gap-2">
                  <div className="flex items-center justify-between"><div className="font-semibold">{p.name}</div>{p.key === s?.plan ? <Badge variant="success">Your plan</Badge> : p.highlight ? <Badge>Recommended</Badge> : null}</div>
                  <div className="figure">{naira(p.price_monthly)}<span className="text-caption text-muted-foreground font-normal"> /month</span></div>
                  {p.tagline && <div className="text-caption text-muted-foreground">{p.tagline}</div>}
                  <ul className="text-small grid gap-0.5 mt-1">{(p.features ?? []).map((f, i) => <li key={i}>· {f}</li>)}</ul>
                  <div className="text-caption text-muted-foreground">{p.limits?.terminals ?? "Unlimited"} terminal{p.limits?.terminals === 1 ? "" : "s"} · {p.limits?.staff ?? "Unlimited"} staff</div>
                </CardContent></Card>
              ))}
            </div>
            <p className="text-caption text-muted-foreground">To change plan, write to hello@getzogal.com — Zogal raises the invoice and you pay it here. Changing plans from this page arrives later.</p>
          </section>
        )}

        {d && d.invoices.length > 0 && (
          <section className="grid gap-3">
            <h2 className="text-h3">Invoices and receipts</h2>
            <div className="grid gap-2">
              {d.invoices.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-border px-4 py-2.5 text-small">
                  <span className="font-mono">{i.number}</span>
                  <span className="text-muted-foreground">{planName(d.plans, i.plan_key)} · {i.period_start} → {i.period_end}</span>
                  <span className="flex-1" />
                  <span className="tabular-nums font-semibold">{naira(i.amount)}</span>
                  {i.status === "paid" ? <Badge variant="success">Paid{i.provider ? ` · ${i.provider}` : ""}</Badge> : i.status === "void" ? <Badge variant="secondary">Void</Badge> : <Badge variant="warning">Unpaid</Badge>}
                </div>
              ))}
            </div>
          </section>
        )}

        {d && unpaid.length === 0 && (
          <Alert tone="info" title="Nothing due">When a renewal is due, Zogal emails the invoice and it appears here with a Pay button. Paying extends your subscription at once.</Alert>
        )}
      </Page>
    </>
  );
}

function UsageLine({ label, used, limit }: { label: string; used: number; limit: number | undefined }) {
  const full = limit !== undefined && used >= limit;
  return <div className={full ? "text-status-red font-medium" : ""}>{label}: {used} of {limit ?? "unlimited"}{full ? " — full" : ""}</div>;
}

function planName(plans: Plan[], key: string) { return plans.find((p) => p.key === key)?.name ?? key; }

async function payApi(path: string, body: Record<string, unknown>): Promise<{ ok?: boolean; url?: string; error?: string }> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in first");
  const res = await fetch(`${PAY_API}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
  if (!res.ok && !j.error) j.error = `Zogal's server said ${res.status}`;
  return j;
}
