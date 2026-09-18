-- ============================================================================
-- 0015_pricing_pos_web.sql — pricing plans + partner web-till switch
-- (Nathan, 2026-09-18)
--
-- RUN MANUALLY after 0014.
--
--   1. pricing_plans — what business.getzogal.com/doka shows. PUBLIC read
--      (anon), admin-only write from the back office. Marketing copy lives
--      here so a price change never needs a deploy.
--   2. platform setting `pos_web.enabled` — the kill switch for the
--      temporary partner web till. Readable by anon (the till must check it
--      before login); only platform admins can flip it.
-- ============================================================================

create table public.pricing_plans (
  id            uuid primary key default gen_random_uuid(),
  product       text not null default 'doka' check (product ~ '^[a-z][a-z0-9_]{1,39}$'),
  key           text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name          text not null,
  tagline       text,
  price_monthly numeric(14,2) not null check (price_monthly >= 0),
  price_yearly  numeric(14,2) check (price_yearly is null or price_yearly >= 0),
  currency      text not null default 'NGN',
  features      jsonb not null default '[]',   -- ["Unlimited items", "2 terminals", ...]
  limits        jsonb not null default '{}',   -- {"terminals": 2, "staff": 5}
  highlight     boolean not null default false,
  is_visible    boolean not null default true,
  sort_order    int not null default 0,
  updated_by    uuid references public.users(id),
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (product, key)
);
create trigger pricing_plans_updated_at before update on public.pricing_plans
  for each row execute function public.set_updated_at();

alter table public.pricing_plans enable row level security;
-- Anyone (including the anonymous marketing site) may read visible plans.
create policy pricing_plans_public_read on public.pricing_plans for select
  using (is_visible or public.is_platform_admin());
create policy pricing_plans_admin_write on public.pricing_plans for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
grant select on public.pricing_plans to anon, authenticated;

-- Starter seed — Nathan edits from the back office.
insert into public.pricing_plans (product, key, name, tagline, price_monthly, price_yearly, features, limits, highlight, sort_order) values
  ('doka', 'starter',  'Starter',  'One shop, one till',            5000,  50000,
   '["1 terminal", "Unlimited items and sales", "Works offline", "Owner dashboard on your phone", "5 notebook scans a month"]', '{"terminals": 1, "staff": 3}', false, 1),
  ('doka', 'standard', 'Standard', 'For a busy shop with staff',    12000, 120000,
   '["Up to 3 terminals", "Staff roles and permissions", "Customers and history", "Tax status and filing records", "20 notebook scans a month"]', '{"terminals": 3, "staff": 10}', true, 2),
  ('doka', 'multi',    'Multi-shop', 'Several shops, one owner',    30000, 300000,
   '["Unlimited terminals", "Unlimited staff", "Everything in Standard", "Priority support"]', '{"terminals": null, "staff": null}', false, 3);

-- ----------------------------------------------------------------------------
-- Partner web till switch
-- ----------------------------------------------------------------------------
insert into public.platform_settings (key, value, description) values
  ('pos_web.enabled', 'true', 'Temporary partner web till (browser POS) reachable at all')
on conflict (key) do nothing;

-- The till checks this BEFORE sign-in, so anon must be able to ask.
-- Only this one key is exposed to anon; everything else stays behind auth.
create or replace function public.pos_web_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((value)::boolean, false) from public.platform_settings where key = 'pos_web.enabled';
$$;
revoke all on function public.pos_web_enabled() from public;
grant execute on function public.pos_web_enabled() to anon, authenticated;
