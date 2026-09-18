-- ============================================================================
-- 0016_backoffice_foundation.sql — Zogal Business back office, slice 1
-- (Nathan, 2026-09-18). RUN MANUALLY after 0015.
--
-- The company layer, replicated from zogal.app's back office:
--   products            one row per product (Doka today); colour, site path
--   staff               Zogal Business staff; Root is the only role that grants
--   has_capability()    one switch per thing a person may do, per product/area
--   ops_audit_log       what operators did (service-role insert only)
--   ops_notify          Who is told: per person, per event, per channel
--   ops_notifications   the bell inside the back office
--   signin_events       where product users sign in from (the product map)
--   messages / user_notices   email + in-app messages to users, on behalf of a product
--   impersonations      "sign in as" — logged, time-boxed, Root-granted capability
--
-- platform_admins (0013) is folded into staff as Root. is_platform_admin()
-- keeps working (= Root) so every existing admin_* function is unchanged.
-- Reads by the back office go through the service role (server only); RLS
-- here exists so nothing leaks to the apps' anon/authenticated clients.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Products
-- ----------------------------------------------------------------------------
create table public.products (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        text not null,
  tagline     text,
  -- Accent colour the back office wears inside this product, and mail templates use.
  colour      text not null default '#E0563F',
  site_path   text,                      -- on business.getzogal.com, e.g. '/doka'
  app_url     text,                      -- e.g. https://doka.zogal.app
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
insert into public.products (key, name, tagline, colour, site_path, app_url, sort_order) values
  ('doka', 'Doka', 'The shop app that knows your profit.', '#E0563F', '/doka', 'https://doka.zogal.app', 1);

-- ----------------------------------------------------------------------------
-- 2. Staff and capabilities
-- ----------------------------------------------------------------------------
-- A staff row is created by Root with an email and switches; the person is
-- linked to it the first time they sign in with that email (see staff_link).
create table public.staff (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique check (email = lower(email)),
  user_id        uuid unique references public.users(id) on delete set null,
  name           text,
  role           text not null default 'staff' check (role in ('root', 'staff')),
  -- One switch per thing, e.g. 'doka.ops.view', 'marketing.doka.publish'.
  -- Validated by the back office against its capability list; text[] so a
  -- new switch never needs a migration.
  capabilities   text[] not null default '{}',
  invited_by     uuid references public.users(id),
  invited_at     timestamptz not null default now(),
  accepted_at    timestamptz,
  deactivated_at timestamptz,
  updated_at     timestamptz not null default now()
);
create trigger staff_updated_at before update on public.staff for each row execute function public.set_updated_at();
alter table public.staff enable row level security;
-- No client policies: staff rows are read and written by the back office server (service role).

-- Fold existing platform admins in as Root.
insert into public.staff (email, user_id, name, role, accepted_at)
select u.email, u.id, u.full_name, 'root', now()
from public.platform_admins pa join public.users u on u.id = pa.user_id
on conflict (email) do update set user_id = excluded.user_id, role = 'root', accepted_at = coalesce(public.staff.accepted_at, now());

-- Link a signed-in user to a pending staff row by email (called by the back office after sign-in).
create or replace function public.staff_link()
returns public.staff language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.current_app_user_id(); v_email text; v_row public.staff;
begin
  if v_uid is null then return null; end if;
  select lower(email) into v_email from public.users where id = v_uid;
  update public.staff set user_id = v_uid, accepted_at = coalesce(accepted_at, now())
   where user_id is null and email = v_email and deactivated_at is null
   returning * into v_row;
  if v_row.id is null then select * into v_row from public.staff where user_id = v_uid; end if;
  return v_row;
end $$;
revoke all on function public.staff_link() from public;
grant execute on function public.staff_link() to authenticated;

-- The one question every gate asks.
create or replace function public.has_capability(p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = public.current_app_user_id() and s.deactivated_at is null
      and (s.role = 'root' or p_cap = any(s.capabilities))
  );
$$;
revoke all on function public.has_capability(text) from public;
grant execute on function public.has_capability(text) to authenticated;

-- Root, and only Root. Existing admin_* functions keep calling this.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = public.current_app_user_id() and role = 'root' and deactivated_at is null);
$$;

-- ----------------------------------------------------------------------------
-- 3. Audit log — inserted by the server only
-- ----------------------------------------------------------------------------
create table public.ops_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references public.users(id),
  actor_role  text not null check (actor_role in ('root', 'staff')),   -- at the time
  product     text references public.products(key),                     -- null = company-wide
  action      text not null,                                            -- 'staff.invite', 'subscription.set', 'user.impersonate'
  summary     text not null,                                            -- one plain line, written at the time
  target_type text,
  target_id   text,
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index ops_audit_log_time_idx on public.ops_audit_log (created_at desc);
create index ops_audit_log_product_idx on public.ops_audit_log (product, created_at desc);
alter table public.ops_audit_log enable row level security;

-- ----------------------------------------------------------------------------
-- 4. Who is told, and the bell
-- ----------------------------------------------------------------------------
-- One row per (staff, event) they want; channels chosen per row.
create table public.ops_notify (
  staff_id   uuid not null references public.staff(id) on delete cascade,
  event      text not null,   -- 'doka.signup', 'doka.signin', 'doka.payment', 'doka.subscription', 'doka.sync_conflicts', 'company.failure', 'marketing.contact', 'marketing.published'
  email      boolean not null default true,
  bell       boolean not null default true,
  primary key (staff_id, event)
);
alter table public.ops_notify enable row level security;

create table public.ops_notifications (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  event       text not null,
  product     text references public.products(key),
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index ops_notifications_staff_idx on public.ops_notifications (staff_id, read_at, created_at desc);
alter table public.ops_notifications enable row level security;

-- ----------------------------------------------------------------------------
-- 5. Sign-in events — the product map
-- ----------------------------------------------------------------------------
create table public.signin_events (
  id          uuid primary key default gen_random_uuid(),
  product     text not null references public.products(key),
  user_id     uuid not null references public.users(id) on delete cascade,
  shop_id     uuid references public.shops(id) on delete set null,
  surface     text not null check (surface in ('desktop', 'web', 'pos_web')),
  ip          inet,
  city        text, region text, country text,        -- resolved by the back office, lazily
  lat double precision, lng double precision,
  created_at  timestamptz not null default now()
);
create index signin_events_product_time_idx on public.signin_events (product, created_at desc);
alter table public.signin_events enable row level security;

-- Apps call this right after sign-in. IP comes from the request, never the client.
create or replace function public.record_signin(p_product text, p_surface text, p_shop_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.current_app_user_id(); v_ip text;
begin
  if v_uid is null then return; end if;
  begin
    v_ip := split_part(coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''), ',', 1);
  exception when others then v_ip := null; end;
  insert into public.signin_events (product, user_id, shop_id, surface, ip)
  values (p_product, v_uid, p_shop_id, p_surface, nullif(trim(v_ip), '')::inet);
end $$;
revoke all on function public.record_signin(text, text, uuid) from public;
grant execute on function public.record_signin(text, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Messages to users — on behalf of a product
-- ----------------------------------------------------------------------------
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  product     text not null references public.products(key),   -- whose identity the message wears
  sent_by     uuid not null references public.users(id),
  to_user_id  uuid references public.users(id) on delete set null,
  to_shop_id  uuid references public.shops(id) on delete set null,
  to_email    text,
  channels    text[] not null default '{email}',                -- 'email', 'in_app'
  subject     text not null,
  body        text not null,
  status      text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error       text,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index messages_user_idx on public.messages (to_user_id, created_at desc);
alter table public.messages enable row level security;

-- What a product user sees inside the app (the dashboard bell / till notice).
create table public.user_notices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  product     text not null references public.products(key),
  message_id  uuid references public.messages(id) on delete set null,
  title       text not null,
  body        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index user_notices_idx on public.user_notices (user_id, read_at, created_at desc);
alter table public.user_notices enable row level security;
create policy user_notices_own on public.user_notices for select using (user_id = public.current_app_user_id());
create policy user_notices_read_mark on public.user_notices for update
  using (user_id = public.current_app_user_id()) with check (user_id = public.current_app_user_id());
grant select, update (read_at) on public.user_notices to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Sign in as a user — logged and time-boxed
-- ----------------------------------------------------------------------------
create table public.impersonations (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id),
  user_id     uuid not null references public.users(id),
  product     text not null references public.products(key),
  reason      text not null check (length(trim(reason)) >= 5),
  started_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  ended_at    timestamptz
);
alter table public.impersonations enable row level security;
-- The app asks "is this session an impersonation?" to show the red bar and block money actions.
create or replace function public.current_impersonation()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', i.id, 'staff', s.name, 'expires_at', i.expires_at, 'product', i.product)
  from public.impersonations i join public.staff s on s.id = i.staff_id
  where i.user_id = public.current_app_user_id() and i.ended_at is null and i.expires_at > now()
  order by i.started_at desc limit 1;
$$;
revoke all on function public.current_impersonation() from public;
grant execute on function public.current_impersonation() to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Product user view — the "who is linked to whom" the profile shows
-- ----------------------------------------------------------------------------
-- Everything the Users screen needs in one call, for the back office only
-- (service role). Owner = the earliest active Owner of each shop.
create or replace view public.ops_user_memberships as
select m.user_id, u.email, u.full_name, m.shop_id, s.name as shop_name, r.name as role_name, r.key as role_key, m.is_active, m.joined_at,
       (select u2.full_name from public.shop_members m2 join public.users u2 on u2.id = m2.user_id
         where m2.shop_id = m.shop_id and m2.role_id = '00000000-0000-0000-0000-000000000001' and m2.is_active
         order by m2.joined_at limit 1) as owner_name,
       (select m2.user_id from public.shop_members m2
         where m2.shop_id = m.shop_id and m2.role_id = '00000000-0000-0000-0000-000000000001' and m2.is_active
         order by m2.joined_at limit 1) as owner_id
from public.shop_members m
join public.users u on u.id = m.user_id
join public.shops s on s.id = m.shop_id
join public.roles r on r.id = m.role_id;
revoke all on public.ops_user_memberships from anon, authenticated;
