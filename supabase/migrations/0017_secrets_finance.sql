-- ============================================================================
-- 0017_secrets_finance.sql — keys per product; Finance draft/publish; plan gating
-- (Nathan, 2026-09-19). RUN MANUALLY after 0016.
--
--   product_secrets      third-party keys (Anthropic, Paystack, Flutterwave,
--                        Resend) per product or company-wide, set from the
--                        back office. Service role only. NEVER readable by
--                        the apps' clients. Edge Functions read them.
--   pricing_plans_draft  Finance edits drafts; publish_catalogue() copies
--                        draft → live and bumps a version (zogal.app's rule:
--                        Save is a draft, Publish is the promise). Same ids.
--   plan gating          activate_device() and shop invites refuse when the
--                        shop's plan limit is reached, with a plain message.
--   invoices / receipts  records for payments (providers wire in next).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Secrets
-- ----------------------------------------------------------------------------
create table public.product_secrets (
  product     text not null default '',   -- '' = company-wide (e.g. Resend); otherwise a products.key
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  value       text not null,
  description text,
  updated_by  uuid references public.users(id),
  updated_at  timestamptz not null default now(),
  primary key (product, key),
  check (product = '' or product ~ '^[a-z][a-z0-9_]{1,39}$')
);
alter table public.product_secrets enable row level security;
revoke all on public.product_secrets from anon, authenticated;
-- The only door for a function running as a user: "is it set?" — never the value.
create or replace function public.secret_is_set(p_product text, p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.product_secrets where product = coalesce(p_product, '') and key = p_key and length(value) > 0);
$$;
revoke all on function public.secret_is_set(text, text) from public;
grant execute on function public.secret_is_set(text, text) to authenticated;

-- What the back office lists (values shown as set / not set only).
insert into public.product_secrets (product, key, value, description) values
  ('',     'resend_api_key',         '', 'Resend — every email from Zogal Business and its products'),
  ('doka', 'anthropic_api_key',      '', 'Anthropic — reads notebook photos'),
  ('doka', 'paystack_secret_key',    '', 'Paystack secret key (sk_...)'),
  ('doka', 'paystack_public_key',    '', 'Paystack public key (pk_...) — shown to the payer''s browser'),
  ('doka', 'flutterwave_secret_key', '', 'Flutterwave secret key'),
  ('doka', 'flutterwave_public_key', '', 'Flutterwave public key — shown to the payer''s browser'),
  ('doka', 'flutterwave_secret_hash','', 'Flutterwave webhook verification hash');

-- ----------------------------------------------------------------------------
-- 2. Finance: draft → publish
-- ----------------------------------------------------------------------------
create table public.pricing_plans_draft (like public.pricing_plans including all);
insert into public.pricing_plans_draft select * from public.pricing_plans;
alter table public.pricing_plans_draft enable row level security;
revoke all on public.pricing_plans_draft from anon, authenticated;

create table public.catalogue_publish (
  id           bigserial primary key,
  product      text not null references public.products(key),
  version      int not null,
  published_by uuid references public.users(id),
  published_at timestamptz not null default now(),
  note         text
);
alter table public.catalogue_publish enable row level security;
revoke all on public.catalogue_publish from anon, authenticated;

-- Copies draft over live in one call. Live rows the draft dropped are HIDDEN,
-- never deleted: a subscription may still name them.
create or replace function public.publish_catalogue(p_product text, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_version int;
begin
  insert into public.pricing_plans (id, product, key, name, tagline, price_monthly, price_yearly, currency, features, limits, highlight, is_visible, sort_order, updated_by, updated_at, created_at)
  select id, product, key, name, tagline, price_monthly, price_yearly, currency, features, limits, highlight, is_visible, sort_order, updated_by, now(), created_at
  from public.pricing_plans_draft where product = p_product
  on conflict (id) do update set
    key = excluded.key, name = excluded.name, tagline = excluded.tagline, price_monthly = excluded.price_monthly, price_yearly = excluded.price_yearly,
    currency = excluded.currency, features = excluded.features, limits = excluded.limits, highlight = excluded.highlight, is_visible = excluded.is_visible,
    sort_order = excluded.sort_order, updated_by = excluded.updated_by, updated_at = now();
  update public.pricing_plans set is_visible = false, updated_at = now()
   where product = p_product and id not in (select id from public.pricing_plans_draft where product = p_product);
  select coalesce(max(version), 0) + 1 into v_version from public.catalogue_publish where product = p_product;
  insert into public.catalogue_publish (product, version, published_by, note) values (p_product, v_version, public.current_app_user_id(), p_note);
  return v_version;
end $$;
revoke all on function public.publish_catalogue(text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Plan gating
-- ----------------------------------------------------------------------------
-- The shop's LIVE plan limits. Null limit = unlimited. No subscription row,
-- or a plan key that is not in the live catalogue = the cheapest visible plan.
create or replace function public.shop_plan_limits(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.limits from public.subscriptions s join public.pricing_plans p on p.key = s.plan and p.product = 'doka' where s.shop_id = p_shop_id),
    (select p.limits from public.pricing_plans p where p.product = 'doka' and p.is_visible order by p.price_monthly limit 1),
    '{}'::jsonb);
$$;
revoke all on function public.shop_plan_limits(uuid) from public;
grant execute on function public.shop_plan_limits(uuid) to authenticated;

-- Usage against limits, for the dashboard ("1 of 1 terminals used").
create or replace function public.shop_plan_usage(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan', (select s.plan from public.subscriptions s where s.shop_id = p_shop_id),
    'limits', public.shop_plan_limits(p_shop_id),
    'terminals', (select count(*) from public.devices where shop_id = p_shop_id and revoked_at is null),
    'staff', (select count(*) from public.shop_members where shop_id = p_shop_id and is_active));
$$;
revoke all on function public.shop_plan_usage(uuid) from public;
grant execute on function public.shop_plan_usage(uuid) to authenticated;

-- Enforce at the two doors. Activation codes: refuse to mint when full.
create or replace function public.create_device_activation_code(p_shop_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_bytes bytea := gen_random_bytes(8);
  v_row public.device_activation_codes;
  v_limit int; v_used int;
  i int;
begin
  if not public.has_permission(p_shop_id, 'shop.settings') then
    raise exception 'permission denied: shop.settings' using errcode = 'insufficient_privilege';
  end if;
  -- Plan gating (0017): count active terminals against the live plan.
  v_limit := (public.shop_plan_limits(p_shop_id) ->> 'terminals')::int;
  select count(*) into v_used from public.devices where shop_id = p_shop_id and revoked_at is null;
  if v_limit is not null and v_used >= v_limit then
    raise exception 'plan_limit: Your plan allows % terminal%. Revoke one or upgrade to add another.', v_limit, case when v_limit = 1 then '' else 's' end
      using errcode = 'check_violation';
  end if;
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.device_activation_codes (shop_id, code_hash, created_by)
  values (p_shop_id, sha256(convert_to(v_code, 'UTF8')), public.current_app_user_id())
  returning * into v_row;
  return query select v_code, v_row.expires_at;
end $$;

-- Invitations: refuse when staff seats are full.
create or replace function public.enforce_staff_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit int; v_used int;
begin
  v_limit := (public.shop_plan_limits(new.shop_id) ->> 'staff')::int;
  select count(*) into v_used from public.shop_members where shop_id = new.shop_id and is_active;
  if v_limit is not null and v_used >= v_limit then
    raise exception 'plan_limit: Your plan allows % staff. Upgrade to invite more.', v_limit using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists shop_invitations_limit on public.shop_invitations;
create trigger shop_invitations_limit before insert on public.shop_invitations for each row execute function public.enforce_staff_limit();

-- ----------------------------------------------------------------------------
-- 4. Invoices and receipts (records; providers wire in through the back office)
-- ----------------------------------------------------------------------------
create table public.invoices (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique,                       -- DOKA-2026-000001
  product       text not null references public.products(key),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  plan_key      text not null,
  period_start  date not null,
  period_end    date not null,
  amount        numeric(14,2) not null check (amount >= 0),
  currency      text not null default 'NGN',
  status        text not null default 'unpaid' check (status in ('unpaid', 'paid', 'void')),
  provider      text check (provider in ('paystack', 'flutterwave', 'manual')),
  provider_ref  text,
  paid_at       timestamptz,
  created_by    uuid references public.users(id),
  created_at    timestamptz not null default now()
);
create index invoices_shop_idx on public.invoices (shop_id, created_at desc);
alter table public.invoices enable row level security;
create policy invoices_read on public.invoices for select using (public.has_permission(shop_id, 'shop.settings'));
grant select on public.invoices to authenticated;

create sequence public.invoice_seq;
create or replace function public.next_invoice_number(p_product text)
returns text language sql security definer set search_path = public as $$
  select upper(p_product) || '-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_seq')::text, 6, '0');
$$;
revoke all on function public.next_invoice_number(text) from public, anon, authenticated;

-- Marks an invoice paid and extends the subscription — called by the payment
-- webhook (service role) or the back office (manual). One place, one rule.
create or replace function public.apply_payment(p_invoice_id uuid, p_provider text, p_provider_ref text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.invoices;
begin
  select * into v from public.invoices where id = p_invoice_id for update;
  if v.id is null then raise exception 'no such invoice'; end if;
  if v.status = 'paid' then return; end if;   -- idempotent: webhooks retry
  update public.invoices set status = 'paid', provider = p_provider, provider_ref = p_provider_ref, paid_at = now() where id = p_invoice_id;
  insert into public.subscriptions (shop_id, status, plan, expires_at)
  values (v.shop_id, 'active', v.plan_key, (v.period_end + 1)::timestamptz)
  on conflict (shop_id) do update set status = 'active', plan = v.plan_key, expires_at = greatest(public.subscriptions.expires_at, (v.period_end + 1)::timestamptz);
end $$;
revoke all on function public.apply_payment(uuid, text, text) from public, anon, authenticated;
