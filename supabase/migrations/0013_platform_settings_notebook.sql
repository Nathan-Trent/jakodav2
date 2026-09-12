-- ============================================================================
-- 0013_platform_settings_notebook.sql — Stage 7 (Nathan, 2026-09-12)
--
-- RUN MANUALLY after 0012. Two things:
--
--   1. PLATFORM SETTINGS — keys the BUSINESS (Nathan's back office) sets, not
--      the shop owner. Scan allowance lives here. Readable by every signed-in
--      user through platform_setting(); writable only by platform_admins.
--      Every change is kept in platform_settings_history. The admin UI comes
--      with the web dashboard (Stage 8); until then, change a value with:
--        update public.platform_settings set value = '10' where key = 'notebook.free_scans_per_month';
--      (as postgres in the SQL editor — bypasses RLS; the trigger still logs it).
--
--   2. NOTEBOOK SCANS — one row per photographed page (PRD §5.6, §6.5). The
--      Edge Function `parse-notebook-page` begins a scan (quota checked HERE,
--      in Postgres, not in the function), calls the model, stores the parsed
--      draft; the cashier confirms rows into ordinary sales via record_sale.
--      The image itself is never stored.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Platform admins + settings
-- ----------------------------------------------------------------------------
create table public.platform_admins (
  user_id   uuid primary key references public.users(id) on delete cascade,
  added_at  timestamptz not null default now(),
  note      text
);
alter table public.platform_admins enable row level security;
-- Nobody reads this through the API; is_platform_admin() is the only door.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = public.current_app_user_id());
$$;

create table public.platform_settings (
  key          text primary key check (key ~ '^[a-z][a-z0-9_.]{1,79}$'),
  value        jsonb not null,
  description  text not null,
  updated_by   uuid references public.users(id),
  updated_at   timestamptz not null default now()
);
create table public.platform_settings_history (
  id          bigserial primary key,
  key         text not null,
  old_value   jsonb,
  new_value   jsonb not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create or replace function public.log_platform_setting_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.platform_settings_history (key, old_value, new_value, changed_by)
  values (new.key, case when tg_op = 'UPDATE' then old.value else null end, new.value,
          coalesce(new.updated_by, public.current_app_user_id()));
  new.updated_at := now();
  return new;
end $$;
create trigger platform_settings_log before insert or update on public.platform_settings
  for each row execute function public.log_platform_setting_change();

alter table public.platform_settings enable row level security;
alter table public.platform_settings_history enable row level security;
create policy platform_settings_admin on public.platform_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy platform_settings_history_admin on public.platform_settings_history for select
  using (public.is_platform_admin());

-- Shops read a setting only through this (no table access).
create or replace function public.platform_setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from public.platform_settings where key = p_key;
$$;
revoke all on function public.platform_setting(text) from public;
grant execute on function public.platform_setting(text) to authenticated, service_role;

insert into public.platform_settings (key, value, description) values
  ('notebook.enabled',               'true',           'Notebook photo capture available to shops'),
  ('notebook.free_scans_per_month',  '5',              'Free notebook scans per shop per calendar month (PRD §5.6)'),
  ('notebook.model',                 '"claude-opus-5"', 'Model used to read notebook pages'),
  ('notebook.max_rows_per_page',     '60',             'Safety cap on parsed rows per scan');

-- ----------------------------------------------------------------------------
-- 2. Notebook scans
-- ----------------------------------------------------------------------------
create table public.notebook_scans (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  requested_by   uuid not null references public.users(id),
  device_id      uuid references public.devices(id),
  page_kind      text not null default 'sales' check (page_kind in ('sales')),
  status         text not null default 'pending'
                 check (status in ('pending', 'parsed', 'failed', 'confirmed', 'discarded')),
  -- Parsed draft: {page_date, rows: [{line, item_text, item_id, quantity, unit_price, confidence, note}], warnings[]}
  result         jsonb,
  model          text,
  input_tokens   int,
  output_tokens  int,
  error          text,
  sale_ids       uuid[],
  created_at     timestamptz not null default now(),
  finished_at    timestamptz,
  confirmed_at   timestamptz
);
create index notebook_scans_shop_idx on public.notebook_scans (shop_id, created_at desc);
alter table public.notebook_scans enable row level security;
create policy notebook_scans_read on public.notebook_scans for select
  using (shop_id in (select public.current_shop_ids()));
-- All writes go through the functions below (definer) or the service role.

-- Quota for a shop this calendar month (shop-local). Counts every scan that
-- reached the model (pending/parsed/confirmed/discarded); failures are free.
create or replace function public.notebook_scan_quota(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tz        text;
  v_month     date;
  v_allow     int := coalesce((public.platform_setting('notebook.free_scans_per_month'))::int, 0);
  v_enabled   boolean := coalesce((public.platform_setting('notebook.enabled'))::boolean, false);
  v_used      int;
begin
  if p_shop_id not in (select public.current_shop_ids()) then
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_month := date_trunc('month', (now() at time zone v_tz))::date;
  select count(*) into v_used from public.notebook_scans
   where shop_id = p_shop_id and status <> 'failed'
     and (created_at at time zone v_tz)::date >= v_month;
  return jsonb_build_object('enabled', v_enabled, 'allowance', v_allow, 'used', v_used,
                            'remaining', greatest(v_allow - v_used, 0), 'month', v_month);
end $$;
revoke all on function public.notebook_scan_quota(uuid) from public;
grant execute on function public.notebook_scan_quota(uuid) to authenticated;

-- Called by the Edge Function AS THE USER before the model call. Refuses
-- when over quota, so the paid call never happens without an allowance.
create or replace function public.notebook_scan_begin(p_shop_id uuid, p_device_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_quota jsonb;
  v_id    uuid;
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  v_quota := public.notebook_scan_quota(p_shop_id);
  if not (v_quota->>'enabled')::boolean then
    raise exception 'notebook capture is switched off' using errcode = 'check_violation';
  end if;
  if (v_quota->>'remaining')::int <= 0 then
    raise exception 'scan_allowance_exhausted: % of % free scans used this month',
      v_quota->>'used', v_quota->>'allowance' using errcode = 'check_violation';
  end if;
  insert into public.notebook_scans (shop_id, requested_by, device_id)
  values (p_shop_id, public.current_app_user_id(), p_device_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.notebook_scan_begin(uuid, uuid) from public;
grant execute on function public.notebook_scan_begin(uuid, uuid) to authenticated;

-- The cashier's verdict on a parsed page.
create or replace function public.notebook_scan_close(p_scan_id uuid, p_status text, p_sale_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  if p_status not in ('confirmed', 'discarded') then
    raise exception 'status must be confirmed or discarded' using errcode = 'check_violation';
  end if;
  select shop_id into v_shop from public.notebook_scans where id = p_scan_id;
  if v_shop is null or not public.has_permission(v_shop, 'sales.create') then
    raise exception 'permission denied' using errcode = 'insufficient_privilege';
  end if;
  update public.notebook_scans
     set status = p_status, sale_ids = p_sale_ids, confirmed_at = now()
   where id = p_scan_id and status = 'parsed';
end $$;
revoke all on function public.notebook_scan_close(uuid, text, uuid[]) from public;
grant execute on function public.notebook_scan_close(uuid, text, uuid[]) to authenticated;
