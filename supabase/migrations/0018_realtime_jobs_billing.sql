-- ============================================================================
-- 0018_realtime_jobs_billing.sql — the database tells the front end
-- (Nathan, 2026-09-19). RUN MANUALLY after 0017.
--
--   "All of the build should be client side first… when there's a change in
--    the database, the database tells the front end. Not always pinging."
--
--   1. Staff READ policies — the three-gate capability model moves into
--      Postgres. A staff member's own session can read exactly the tables
--      their switches cover; nothing else. Supabase Realtime honours these
--      same policies, so a change is pushed only to people allowed to see it.
--      Writes stay server-side (service role + audit), unchanged.
--   2. Realtime publication — the tables the back office, the dashboard and
--      the desktop app listen to. Replaces every poll.
--   3. jobs — background work with retries (emails, publishes, renewals).
--      Run by QStash calling /api/jobs/run; retried with backoff; dead after
--      max_attempts and shown on Health.
--   4. Billing: which payment provider is ACTIVE (keys alone mean nothing),
--      card-on-file tokens for renewals without re-entering the card,
--      subscriptions.auto_renew. Subscription payments only — Doka never
--      moves money between a shop and its customers.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Staff read policies (select only; additive — existing policies stay)
-- ----------------------------------------------------------------------------
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = public.current_app_user_id() and deactivated_at is null);
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

-- Company level
grant select on public.products to authenticated;
create policy products_staff_read on public.products for select using (public.is_staff());
-- Staff list: any staff member can see colleagues (names for audit lines,
-- publish history, the chrome). Only the server writes.
grant select on public.staff to authenticated;
create policy staff_read on public.staff for select using (public.is_staff());

grant select on public.ops_audit_log to authenticated;
create policy ops_audit_staff_read on public.ops_audit_log for select using (public.has_capability('company.audit.view'));
grant select on public.ops_notify to authenticated;
create policy ops_notify_root_read on public.ops_notify for select using (public.is_platform_admin());
grant select, update (read_at) on public.ops_notifications to authenticated;
create policy ops_notifications_own on public.ops_notifications for select using (staff_id in (select id from public.staff where user_id = public.current_app_user_id()));
create policy ops_notifications_own_read on public.ops_notifications for update using (staff_id in (select id from public.staff where user_id = public.current_app_user_id()));

-- Doka: ops view
grant select on public.shops, public.subscriptions, public.devices, public.shop_members, public.roles, public.sync_conflicts, public.signin_events, public.shop_invitations to authenticated;
create policy shops_staff_read on public.shops for select using (public.has_capability('doka.ops.view'));
create policy subscriptions_staff_read on public.subscriptions for select using (public.has_capability('doka.ops.view'));
create policy devices_staff_read on public.devices for select using (public.has_capability('doka.ops.view'));
create policy shop_members_staff_read on public.shop_members for select using (public.has_capability('doka.ops.view'));
create policy roles_staff_read on public.roles for select using (public.has_capability('doka.ops.view'));
create policy sync_conflicts_staff_read on public.sync_conflicts for select using (public.has_capability('doka.ops.view'));
create policy signin_events_staff_read on public.signin_events for select using (public.has_capability('doka.ops.view'));
create policy shop_invitations_staff_read on public.shop_invitations for select using (public.has_capability('doka.ops.view'));
-- Doka: users
grant select on public.users to authenticated;
create policy users_staff_read on public.users for select using (public.has_capability('doka.users.view'));
grant select on public.messages, public.impersonations, public.user_notices to authenticated;
create policy messages_staff_read on public.messages for select using (public.has_capability('doka.users.message'));
create policy impersonations_staff_read on public.impersonations for select using (public.has_capability('doka.users.impersonate'));
create policy user_notices_staff_read on public.user_notices for select using (public.has_capability('doka.users.message'));
-- Doka: finance
grant select on public.invoices, public.pricing_plans_draft, public.catalogue_publish to authenticated;
create policy invoices_staff_read on public.invoices for select using (public.has_capability('doka.finance.view'));
create policy pricing_draft_staff_read on public.pricing_plans_draft for select using (public.has_capability('doka.finance.view'));
create policy catalogue_publish_staff_read on public.catalogue_publish for select using (public.has_capability('doka.finance.view'));
-- Doka: settings (values, never secrets)
grant select on public.platform_settings, public.platform_settings_history, public.operational_settings to authenticated;
create policy platform_settings_staff_read on public.platform_settings for select using (public.has_capability('doka.settings.manage'));
create policy platform_settings_history_staff_read on public.platform_settings_history for select using (public.has_capability('doka.settings.manage'));
create policy operational_settings_staff_read on public.operational_settings for select using (public.has_capability('doka.settings.manage'));
-- Secrets: status only, through a view that never exposes value.
create or replace view public.product_secrets_status with (security_invoker = false) as
  select product, key, description, length(value) > 0 as is_set, updated_at from public.product_secrets;
-- The view runs as its owner; gate inside so only staff with the right switch see it.
create or replace function public.secrets_status(p_product text)
returns setof public.product_secrets_status language sql stable security definer set search_path = public as $$
  select * from public.product_secrets_status
  where product = coalesce(p_product, '')
    and ((product = '' and public.is_platform_admin()) or (product <> '' and public.has_capability(product || '.settings.manage')));
$$;
revoke all on function public.secrets_status(text) from public;
grant execute on function public.secrets_status(text) to authenticated;
-- (no grant on the view itself: only through secrets_status())

-- Users' own rows for the apps (impersonation bar pushed, not polled)
create policy impersonations_self_read on public.impersonations for select using (user_id = public.current_app_user_id());

-- ----------------------------------------------------------------------------
-- 2. Realtime publication
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.products, public.staff, public.ops_audit_log, public.ops_notify, public.ops_notifications,
  public.shops, public.subscriptions, public.devices, public.shop_members, public.shop_invitations,
  public.sync_conflicts, public.signin_events, public.users, public.messages, public.impersonations,
  public.user_notices, public.invoices, public.pricing_plans, public.pricing_plans_draft, public.catalogue_publish,
  public.platform_settings, public.platform_settings_history, public.operational_settings, public.product_secrets;
-- product_secrets is in the publication so the Keys screen updates, but it
-- has no select policy: Realtime pushes nothing for it to a user session.
-- Staff re-read secrets_status() when the audit log shows a secret.* action.

-- ----------------------------------------------------------------------------
-- 3. Jobs — background work with retries
-- ----------------------------------------------------------------------------
create table public.jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,                       -- send_email, publish_site, geolocate, renew, remind, settle
  product      text,
  payload      jsonb not null default '{}',
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts     int not null default 0,
  max_attempts int not null default 5,
  next_run_at  timestamptz not null default now(),
  locked_at    timestamptz,
  last_error   text,
  result       jsonb,
  created_by   uuid references public.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index jobs_due_idx on public.jobs (next_run_at) where status in ('queued', 'failed');
create index jobs_recent_idx on public.jobs (created_at desc);
create trigger jobs_updated_at before update on public.jobs for each row execute function public.set_updated_at();
alter table public.jobs enable row level security;
grant select on public.jobs to authenticated;
create policy jobs_staff_read on public.jobs for select using (public.has_capability('company.health.view'));
alter publication supabase_realtime add table public.jobs;

-- Claim a batch of due jobs atomically (service role). Skips rows another
-- runner holds. A job locked for >10 min is considered crashed and retaken.
create or replace function public.claim_jobs(p_limit int default 20)
returns setof public.jobs language sql security definer set search_path = public as $$
  update public.jobs j set status = 'running', locked_at = now(), attempts = j.attempts + 1
  where j.id in (
    select id from public.jobs
    where (status in ('queued', 'failed') and next_run_at <= now())
       or (status = 'running' and locked_at < now() - interval '10 minutes')
    order by next_run_at limit p_limit for update skip locked)
  returning j.*;
$$;
revoke all on function public.claim_jobs(int) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Billing: active provider, card on file, auto-renew
-- ----------------------------------------------------------------------------
-- Which provider takes payments. '' = none (Pay shows "not switched on").
insert into public.platform_settings (key, value, description) values
  ('payments.provider', '""'::jsonb, 'Active payment provider for Doka subscriptions: "paystack", "flutterwave" or "" (off). Keys alone do nothing.')
on conflict (key) do nothing;

-- A reusable charge token the PROVIDER holds against a card. We never see
-- the card number. One per shop per provider; the latest is used.
create table public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  provider    text not null check (provider in ('paystack', 'flutterwave')),
  token       text not null,                       -- Paystack authorization_code / Flutterwave card token
  email       text not null,                       -- the payer email the token is bound to
  brand       text, last4 text, exp_month int, exp_year int,
  reusable    boolean not null default true,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (shop_id, provider, token)
);
alter table public.payment_methods enable row level security;
-- Owner sees brand/last4 (never the token) through a view; may remove it.
create or replace view public.payment_methods_view with (security_invoker = true) as
  select id, shop_id, provider, brand, last4, exp_month, exp_year, created_at from public.payment_methods where revoked_at is null;
-- Column grant: the token column is never readable by a user session.
grant select (id, shop_id, provider, brand, last4, exp_month, exp_year, created_at, revoked_at) on public.payment_methods to authenticated;
grant select on public.payment_methods_view to authenticated;
create policy payment_methods_owner_read on public.payment_methods for select using (public.has_permission(shop_id, 'shop.settings'));
create policy payment_methods_staff_read on public.payment_methods for select using (public.has_capability('doka.finance.view'));
grant update (revoked_at) on public.payment_methods to authenticated;
create policy payment_methods_owner_revoke on public.payment_methods for update using (public.has_permission(shop_id, 'shop.settings')) with check (public.has_permission(shop_id, 'shop.settings'));
alter publication supabase_realtime add table public.payment_methods;

alter table public.subscriptions add column if not exists auto_renew boolean not null default true;
-- The dashboard's shop_plan_usage() already reads subscriptions; auto_renew rides along in the row.
