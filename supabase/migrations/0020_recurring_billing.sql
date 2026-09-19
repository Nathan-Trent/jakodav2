-- ============================================================================
-- 0020_recurring_billing.sql — renew without re-entering the card
-- (Nathan, 2026-09-19). RUN MANUALLY after 0019.
--
--   The first successful online payment leaves a reusable token with the
--   PROVIDER (0018 payment_methods). From then on, the renewal job raises
--   the next invoice a few days before expiry and charges the token. If the
--   charge fails, the owner is emailed a pay link and the job tries again
--   daily, three times, then stops and tells staff. Reminders go to shops
--   with no card on file at 7, 1 and 0 days. Subscription payments only.
-- ============================================================================

-- What the renewal and reminder jobs have already done, so nothing is sent twice.
alter table public.subscriptions add column if not exists reminded jsonb not null default '{}';   -- {"7":"2026-09-12","1":"…","0":"…"} per expiry date
alter table public.invoices add column if not exists charge_attempts int not null default 0;
alter table public.invoices add column if not exists last_charge_error text;
alter table public.invoices add column if not exists kind text not null default 'manual' check (kind in ('manual', 'renewal'));

-- Owners may switch auto-renew off/on for their own shop (nothing else on the row).
grant update (auto_renew) on public.subscriptions to authenticated;
drop policy if exists subscriptions_owner_autorenew on public.subscriptions;
create policy subscriptions_owner_autorenew on public.subscriptions for update
  using (public.has_permission(shop_id, 'shop.settings')) with check (public.has_permission(shop_id, 'shop.settings'));

-- The renewal job's view of who is due: active shops, auto-renew on, expiring
-- within 3 days or already expired (inside grace), no unpaid renewal invoice yet.
create or replace function public.renewals_due(p_days int default 3)
returns table (shop_id uuid, plan text, expires_at timestamptz, method_id uuid, provider text, token text, email text)
language sql stable security definer set search_path = public as $$
  select s.shop_id, s.plan, s.expires_at, m.id, m.provider, m.token, m.email
  from public.subscriptions s
  join public.shops sh on sh.id = s.shop_id and sh.is_active
  join lateral (select * from public.payment_methods pm where pm.shop_id = s.shop_id and pm.revoked_at is null and pm.reusable order by pm.created_at desc limit 1) m on true
  where s.auto_renew and s.status <> 'cancelled' and s.expires_at is not null
    and s.expires_at <= now() + make_interval(days => p_days)
    and not exists (select 1 from public.invoices i where i.shop_id = s.shop_id and i.status = 'unpaid' and i.period_start >= s.expires_at::date - 1);
$$;
revoke all on function public.renewals_due(int) from public, anon, authenticated;
