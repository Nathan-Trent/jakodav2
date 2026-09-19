-- ============================================================================
-- 0027_entitlements.sql — feature gating, plan entitlements, server-side
-- subscription gate, abuse rate limits (Nathan, 2026-09-19).
-- RUN MANUALLY after 0026.
--
-- Until now a plan carried a free-text feature list and two loose limits
-- (terminals, staff), checked at two doors only. Nothing was re-checked on
-- downgrade; record_sale never asked whether the subscription was still
-- alive; and the terminal's signed token carried no limits, so offline it
-- could not know it was over one.
--
-- Now:
--   1. `feature_catalogue` — every gateable thing Doka has, with its kind:
--        toggle  on/off                      (tax, reports, staff_roles, expenses)
--        count   on/off + max at once        (terminals, staff, shops, items, customers)
--        quota   on/off + N per period       (notebook_scans: per day/week/month/year)
--   2. `pricing_plans.entitlements` jsonb: {key: {enabled, quantity, period}}.
--      Edited per plan in the back office; the plan's marketing bullets are
--      GENERATED from it (entitlement_feature_lines), so the site can never
--      promise what the code doesn't gate. Existing plans are migrated from
--      their old `limits`; everything else starts enabled + unlimited, so no
--      shop loses anything until Nathan edits a plan.
--   3. `require_entitlement(shop, key, adding)` — the one question every
--      RPC, trigger and policy asks. Counted things are checked on CREATE and
--      on ACCEPT/ACTIVATE. Over-limit after a downgrade: newest terminals
--      beyond the limit are read-only (device_standing), newest staff beyond
--      the limit lose their permissions (member_over_limit) — owners never.
--   4. `shop_gate_level(shop, at)` — the SERVER now enforces the same
--      expiry → grace → read-only → locked ladder the terminal enforces
--      offline (packages/sync/gating.ts). A modified client gains nothing:
--      its sales are refused on upload.
--   5. `rate_limit_hit(bucket, limit, window)` — abuse limits on the hot
--      RPCs, keyed by user or device (the credential IS the token), by IP
--      only where there is no identity yet.
--   6. device_heartbeat returns entitlements + this terminal's standing, so
--      the signed token carries them and the terminal enforces them offline
--      exactly as the server does online.
--
-- SCHEMA ADDITIONS: feature_catalogue, pricing_plans(.draft).entitlements,
-- rate_limit_hits. Functions wrapped (renamed *_v1, same signature kept):
-- record_sale, replay_offline_sale, create_shop, activate_device,
-- create_custom_role, get_my_manager_pin, authorize_override, shop_report,
-- shop_tax_summary. Triggers added: items/customers/expenses/tax_periods/
-- shop_members insert. Replaced: enforce_staff_limit, notebook_scan_quota,
-- create_device_activation_code, has_permission, device_heartbeat,
-- shop_plan_limits/shop_plan_usage (now read entitlements).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Feature catalogue
-- ----------------------------------------------------------------------------
create table public.feature_catalogue (
  product     text not null default 'doka',
  key         text not null,
  name        text not null,
  description text not null,
  kind        text not null check (kind in ('toggle', 'count', 'quota')),
  unit        text,                        -- noun for counts/quotas: "terminals", "scans"
  sort_order  int  not null default 100,
  primary key (product, key)
);
alter table public.feature_catalogue enable row level security;
grant select on public.feature_catalogue to anon, authenticated;
create policy feature_catalogue_read on public.feature_catalogue for select using (true);

insert into public.feature_catalogue (product, key, name, description, kind, unit, sort_order) values
  ('doka', 'terminals',      'Terminals',            'Computers that can sell. Beyond the limit, the newest terminals become read-only until one is revoked.', 'count', 'terminals', 10),
  ('doka', 'staff',          'Staff',                'People in the shop, including the owner. Beyond the limit, the newest members lose access until one is removed.', 'count', 'staff', 20),
  ('doka', 'shops',          'Shops per owner',      'How many shops one owner account can create.', 'count', 'shops', 30),
  ('doka', 'items',          'Items',                'Products in the catalogue.', 'count', 'items', 40),
  ('doka', 'customers',      'Customers',            'Attach customers to sales and keep their purchase history.', 'count', 'customers', 50),
  ('doka', 'notebook_scans', 'Notebook scans',       'Photograph a handwritten sales page and have it read into sales.', 'quota', 'scans', 60),
  ('doka', 'staff_roles',    'Roles & manager PINs', 'Custom roles, per-person permission overrides and manager PIN approvals.', 'toggle', null, 70),
  ('doka', 'tax',            'Tax',                  'Tax estimates, filing records and period locks.', 'toggle', null, 80),
  ('doka', 'reports',        'Reports',              'Sales, profit and stock reports.', 'toggle', null, 90),
  ('doka', 'expenses',       'Expenses',             'Record shop expenses and see profit after them.', 'toggle', null, 100);

-- ----------------------------------------------------------------------------
-- 2. Plans carry entitlements. Migrate the old `limits`; everything else
--    enabled + unlimited (no shop loses anything today).
-- ----------------------------------------------------------------------------
alter table public.pricing_plans       add column entitlements jsonb not null default '{}';
alter table public.pricing_plans_draft add column entitlements jsonb not null default '{}';

create or replace function public.entitlements_from_limits(p_limits jsonb)
returns jsonb language sql stable as $$
  select jsonb_object_agg(f.key, jsonb_build_object(
    'enabled', true,
    'quantity', case when f.key in ('terminals', 'staff') and p_limits ? f.key and jsonb_typeof(p_limits->f.key) = 'number' then (p_limits->>f.key)::int
                     when f.key = 'notebook_scans' then 5 else null end,
    'period',   case when f.key = 'notebook_scans' then 'month' else null end))
  from public.feature_catalogue f where f.product = 'doka';
$$;
update public.pricing_plans       set entitlements = public.entitlements_from_limits(limits) where product = 'doka' and entitlements = '{}';
update public.pricing_plans_draft set entitlements = public.entitlements_from_limits(limits) where product = 'doka' and entitlements = '{}';

-- Marketing bullets, generated. "Unlimited items" / "3 terminals" / "20 notebook scans a month".
create or replace function public.entitlement_feature_lines(p_ent jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(line order by x.sort_order), '[]'::jsonb) from (
    select f.sort_order,
      case
        when not coalesce((p_ent->f.key->>'enabled')::boolean, true) then null
        when f.kind = 'toggle' then f.name
        when f.kind = 'count' then
          case when (p_ent->f.key->>'quantity') is null then 'Unlimited ' || f.unit
               when (p_ent->f.key->>'quantity')::int = 1 then '1 ' || regexp_replace(f.unit, 's$', '')
               else (p_ent->f.key->>'quantity') || ' ' || f.unit end
        when f.kind = 'quota' then
          case when (p_ent->f.key->>'quantity') is null then 'Unlimited ' || f.unit
               else (p_ent->f.key->>'quantity') || ' ' || f.unit || ' a ' || coalesce(p_ent->f.key->>'period', 'month') end
      end as line
    from public.feature_catalogue f where f.product = 'doka'
  ) x where line is not null;
$$;

-- Publishing keeps `features` and `limits` in step with the entitlements
-- (older readers — the marketing site, shop_plan_limits — keep working).
create or replace function public.sync_plan_derived_columns()
returns trigger language plpgsql as $$
begin
  if new.product = 'doka' and new.entitlements <> '{}' then
    new.features := public.entitlement_feature_lines(new.entitlements);
    new.limits := jsonb_strip_nulls(jsonb_build_object(
      'terminals', case when coalesce((new.entitlements->'terminals'->>'enabled')::boolean, true) then (new.entitlements->'terminals'->>'quantity')::int else 0 end,
      'staff',     case when coalesce((new.entitlements->'staff'->>'enabled')::boolean, true) then (new.entitlements->'staff'->>'quantity')::int else 0 end));
  end if;
  return new;
end $$;
create trigger pricing_plans_derived before insert or update on public.pricing_plans for each row execute function public.sync_plan_derived_columns();
create trigger pricing_plans_draft_derived before insert or update on public.pricing_plans_draft for each row execute function public.sync_plan_derived_columns();
update public.pricing_plans set updated_at = updated_at where product = 'doka';        -- fire once
update public.pricing_plans_draft set updated_at = updated_at where product = 'doka';

-- ----------------------------------------------------------------------------
-- 3. The shop's live entitlements and the one question everyone asks
-- ----------------------------------------------------------------------------
-- Live plan's entitlements; no subscription / unknown plan → cheapest visible
-- plan; a key missing from the plan → enabled + unlimited (a feature added to
-- the catalogue later is never silently switched off for existing plans).
create or replace function public.shop_entitlements(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.entitlements from public.subscriptions s join public.pricing_plans p on p.key = s.plan and p.product = 'doka' where s.shop_id = p_shop_id),
    (select p.entitlements from public.pricing_plans p where p.product = 'doka' and p.is_visible order by p.price_monthly limit 1),
    '{}'::jsonb);
$$;
revoke all on function public.shop_entitlements(uuid) from public;
grant execute on function public.shop_entitlements(uuid) to authenticated;

create or replace function public.entitlement_of(p_shop_id uuid, p_key text, out enabled boolean, out quantity int, out period text)
language sql stable security definer set search_path = public as $$
  select coalesce((e->>'enabled')::boolean, true),
         (e->>'quantity')::int,
         e->>'period'
  from (select public.shop_entitlements(p_shop_id) -> p_key as e) x;
$$;
revoke all on function public.entitlement_of(uuid, text) from public;

-- Period window start in the shop's own timezone (quotas).
create or replace function public.period_start(p_period text, p_tz text)
returns timestamptz language sql stable as $$
  select case p_period
    when 'day'   then (date_trunc('day',   now() at time zone p_tz)) at time zone p_tz
    when 'week'  then (date_trunc('week',  now() at time zone p_tz)) at time zone p_tz
    when 'year'  then (date_trunc('year',  now() at time zone p_tz)) at time zone p_tz
    else              (date_trunc('month', now() at time zone p_tz)) at time zone p_tz end;
$$;

-- Current usage for counted/quota entitlements.
create or replace function public.entitlement_usage(p_shop_id uuid, p_key text)
returns int language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_period text;
begin
  case p_key
    when 'terminals' then return (select count(*) from public.devices where shop_id = p_shop_id and revoked_at is null);
    when 'staff'     then return (select count(*) from public.shop_members where shop_id = p_shop_id and is_active);
    when 'items'     then return (select count(*) from public.items where shop_id = p_shop_id and is_active);
    when 'customers' then return (select count(*) from public.customers where shop_id = p_shop_id and is_active);
    when 'shops'     then
      -- Shops the owner of THIS shop owns (active), the owner being the shop's first active Owner.
      return (select count(distinct m2.shop_id) from public.shop_members m1
                join public.shop_members m2 on m2.user_id = m1.user_id and m2.is_active and m2.role_id = '00000000-0000-0000-0000-000000000001'
                join public.shops s on s.id = m2.shop_id and s.is_active
              where m1.shop_id = p_shop_id and m1.is_active and m1.role_id = '00000000-0000-0000-0000-000000000001');
    when 'notebook_scans' then
      select timezone into v_tz from public.shops where id = p_shop_id;
      select period into v_period from public.entitlement_of(p_shop_id, 'notebook_scans');
      return (select count(*) from public.notebook_scans
              where shop_id = p_shop_id and status <> 'failed' and created_at >= public.period_start(coalesce(v_period, 'month'), coalesce(v_tz, 'Africa/Lagos')));
    else return 0;
  end case;
end $$;
revoke all on function public.entitlement_usage(uuid, text) from public;

-- Refuses with a plain `plan_limit:` message (the apps already translate it).
create or replace function public.require_entitlement(p_shop_id uuid, p_key text, p_adding int default 1)
returns void language plpgsql stable security definer set search_path = public as $$
declare e record; f record; v_used int;
begin
  select * into e from public.entitlement_of(p_shop_id, p_key);
  select * into f from public.feature_catalogue where product = 'doka' and key = p_key;
  if not e.enabled then
    raise exception 'plan_limit: % is not included in your plan. Upgrade to use it.', coalesce(f.name, p_key) using errcode = 'check_violation';
  end if;
  if e.quantity is not null and p_adding > 0 then
    v_used := public.entitlement_usage(p_shop_id, p_key);
    if v_used + p_adding > e.quantity then
      if f.kind = 'quota' then
        raise exception 'plan_limit: You have used % of % % this %. It resets at the start of the next %.', v_used, e.quantity, f.unit, coalesce(e.period, 'month'), coalesce(e.period, 'month') using errcode = 'check_violation';
      else
        raise exception 'plan_limit: Your plan allows % %. Remove one or upgrade to add another.', e.quantity, case when e.quantity = 1 then regexp_replace(f.unit, 's$', '') else f.unit end using errcode = 'check_violation';
      end if;
    end if;
  end if;
end $$;
revoke all on function public.require_entitlement(uuid, text, int) from public;
grant execute on function public.require_entitlement(uuid, text, int) to authenticated;

-- Everything the dashboard shows at once: entitlements + usage per counted key.
create or replace function public.shop_plan_usage(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '{}'; f record; ent jsonb := public.shop_entitlements(p_shop_id);
begin
  if p_shop_id not in (select public.current_shop_ids()) then
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;
  for f in select key, kind from public.feature_catalogue where product = 'doka' loop
    v := v || jsonb_build_object(f.key, coalesce(ent->f.key, '{"enabled":true}'::jsonb) ||
           case when f.kind <> 'toggle' then jsonb_build_object('used', public.entitlement_usage(p_shop_id, f.key)) else '{}'::jsonb end);
  end loop;
  return jsonb_build_object('plan', (select s.plan from public.subscriptions s where s.shop_id = p_shop_id),
                            'limits', public.shop_plan_limits(p_shop_id), 'entitlements', v,
                            -- kept for the existing dashboard cards
                            'terminals', public.entitlement_usage(p_shop_id, 'terminals'),
                            'staff', public.entitlement_usage(p_shop_id, 'staff'));
end $$;

-- ----------------------------------------------------------------------------
-- 4. Over-limit after a downgrade: newest beyond the limit give way
-- ----------------------------------------------------------------------------
-- Terminals: rank active devices oldest-first; rank > quantity → over_limit.
create or replace function public.device_standing(p_device_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare d public.devices; e record; v_rank int;
begin
  select * into d from public.devices where id = p_device_id;
  if not found or d.revoked_at is not null then return 'revoked'; end if;
  select * into e from public.entitlement_of(d.shop_id, 'terminals');
  if not e.enabled then return 'over_limit'; end if;
  if e.quantity is null then return 'ok'; end if;
  select count(*) into v_rank from public.devices where shop_id = d.shop_id and revoked_at is null
    and (activated_at, id) <= (d.activated_at, d.id);
  return case when v_rank > e.quantity then 'over_limit' else 'ok' end;
end $$;
revoke all on function public.device_standing(uuid) from public;
grant execute on function public.device_standing(uuid) to authenticated;

-- Staff: rank active members oldest-first; Owners are never cut.
create or replace function public.member_over_limit(p_shop_id uuid, p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare e record; m public.shop_members; v_rank int;
begin
  select * into m from public.shop_members where shop_id = p_shop_id and user_id = p_user_id and is_active;
  if not found then return false; end if;
  if m.role_id = '00000000-0000-0000-0000-000000000001' then return false; end if;
  select * into e from public.entitlement_of(p_shop_id, 'staff');
  if e.quantity is null then return false; end if;
  select count(*) into v_rank from public.shop_members where shop_id = p_shop_id and is_active
    and (created_at, user_id) <= (m.created_at, m.user_id);
  return v_rank > e.quantity;
end $$;
revoke all on function public.member_over_limit(uuid, uuid) from public;

-- has_permission is the root of every write policy: an over-limit member has none.
create or replace function public.has_permission(p_shop_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.member_permissions(p_shop_id, public.current_app_user_id()) p
    where p = p_permission)
  and not public.member_over_limit(p_shop_id, public.current_app_user_id());
$$;

-- ----------------------------------------------------------------------------
-- 5. Server-side subscription gate — the same ladder as gating.ts
-- ----------------------------------------------------------------------------
create or replace function public.shop_gate_level(p_shop_id uuid, p_at timestamptz default now())
returns text language plpgsql stable security definer set search_path = public as $$
declare s public.subscriptions; o jsonb; v_past interval; v_grace interval; v_ro interval;
begin
  select * into s from public.subscriptions where shop_id = p_shop_id;
  if not found then return 'full'; end if;
  if s.status = 'cancelled' then return 'locked'; end if;
  if s.expires_at is null or p_at <= s.expires_at then return 'full'; end if;
  select settings into o from public.operational_settings where id = 1;
  v_grace := make_interval(days => coalesce((o->>'subscription_grace_days')::int, 5));
  v_ro    := make_interval(days => coalesce((o->>'read_only_window_days')::int, 7));
  v_past  := p_at - s.expires_at;
  return case when v_past < v_grace then 'full' when v_past < v_grace + v_ro then 'read_only' else 'locked' end;
end $$;
revoke all on function public.shop_gate_level(uuid, timestamptz) from public;
grant execute on function public.shop_gate_level(uuid, timestamptz) to authenticated;

create or replace function public.require_writable(p_shop_id uuid, p_at timestamptz default now())
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.shop_gate_level(p_shop_id, p_at) <> 'full' then
    raise exception 'subscription_locked: This shop''s subscription has expired. Renew from the dashboard to continue.' using errcode = 'check_violation';
  end if;
end $$;
revoke all on function public.require_writable(uuid, timestamptz) from public;

-- ----------------------------------------------------------------------------
-- 6. Abuse rate limits. Bucket = who + what. Sliding window, one row per hit.
-- ----------------------------------------------------------------------------
create table public.rate_limit_hits (
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index rate_limit_hits_idx on public.rate_limit_hits (bucket, created_at desc);
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

create or replace function public.rate_limit_hit(p_bucket text, p_limit int, p_window interval)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  select count(*) into v_n from public.rate_limit_hits where bucket = p_bucket and created_at > now() - p_window;
  if v_n >= p_limit then
    raise exception 'rate_limited: Too many requests. Wait a moment and try again.' using errcode = 'too_many_connections';
  end if;
  insert into public.rate_limit_hits (bucket) values (p_bucket);
  if random() < 0.01 then delete from public.rate_limit_hits where created_at < now() - interval '1 day'; end if;
end $$;
revoke all on function public.rate_limit_hit(text, int, interval) from public;

create or replace function public.caller_ip() returns inet language plpgsql stable as $$
declare v inet;
begin
  begin v := split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)::inet; exception when others then v := null; end;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Enforcement — wrap the doors (same signatures, callers unchanged)
-- ----------------------------------------------------------------------------

-- record_sale: gate + terminal standing + rate limit (600 sales / 10 min / user).
alter function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid, text) rename to record_sale_v1;
revoke all on function public.record_sale_v1(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid, text) from public, anon, authenticated;
create or replace function public.record_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz default now(), p_note text default null,
  p_device_id uuid default null, p_customer_id uuid default null,
  p_payment_type text default 'cash'
) returns public.sales language plpgsql security definer set search_path = public as $$
begin
  perform public.rate_limit_hit('sale:' || public.current_app_user_id(), 600, interval '10 minutes');
  perform public.require_writable(p_shop_id, p_sold_at);
  if p_device_id is not null and public.device_standing(p_device_id) = 'over_limit' then
    raise exception 'plan_limit: This terminal is beyond your plan''s limit and is read-only. Revoke another terminal or upgrade.' using errcode = 'check_violation';
  end if;
  return public.record_sale_v1(p_shop_id, p_client_ref, p_sold_by, p_lines, p_sold_at, p_note, p_device_id, p_customer_id, p_payment_type);
end $$;
revoke all on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid, text) from public;
grant execute on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid, text) to authenticated;

-- replay_offline_sale: gate judged at the time the sale HAPPENED (a sale made
-- inside grace is honest even if it uploads a week later); standing at upload.
alter function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb, text) rename to replay_offline_sale_v1;
revoke all on function public.replay_offline_sale_v1(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb, text) from public, anon, authenticated;
create or replace function public.replay_offline_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz, p_device_id uuid, p_note text default null,
  p_customer jsonb default null, p_payment_type text default 'cash'
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.rate_limit_hit('sale:' || public.current_app_user_id(), 600, interval '10 minutes');
  if exists (select 1 from public.sales where shop_id = p_shop_id and client_ref = p_client_ref) then
    return public.replay_offline_sale_v1(p_shop_id, p_client_ref, p_sold_by, p_lines, p_sold_at, p_device_id, p_note, p_customer, p_payment_type);
  end if;
  perform public.require_writable(p_shop_id, p_sold_at);
  if p_device_id is not null and public.device_standing(p_device_id) = 'over_limit' then
    raise exception 'plan_limit: This terminal is beyond your plan''s limit and is read-only. Revoke another terminal or upgrade.' using errcode = 'check_violation';
  end if;
  return public.replay_offline_sale_v1(p_shop_id, p_client_ref, p_sold_by, p_lines, p_sold_at, p_device_id, p_note, p_customer, p_payment_type);
end $$;
revoke all on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb, text) from public;
grant execute on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb, text) to authenticated;

-- Customers: the feature may be off or full. A queued SALE must never fail
-- over its customer, so the resolver swallows the refusal → walk-in; the
-- standalone customer replay and direct inserts do refuse.
create or replace function public.enforce_customer_entitlement()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(new.shop_id, 'customers'); return new; end $$;
create trigger customers_entitlement before insert on public.customers for each row execute function public.enforce_customer_entitlement();

create or replace function public.resolve_offline_customer(p_shop_id uuid, p_customer jsonb, p_created_by uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := null; v_ref uuid := null; v_phone text; v_name text;
begin
  if p_customer is null then return null; end if;
  if p_customer ? 'id' then
    select id into v_id from public.customers where id = (p_customer->>'id')::uuid and shop_id = p_shop_id;
    return v_id;
  end if;
  v_name := nullif(trim(coalesce(p_customer->>'name', '')), '');
  if v_name is null then return null; end if;
  v_phone := nullif(trim(coalesce(p_customer->>'phone', '')), '');
  begin v_ref := (p_customer->>'client_ref')::uuid; exception when others then v_ref := null; end;
  if v_ref is not null then
    select id into v_id from public.customers where shop_id = p_shop_id and client_ref = v_ref;
    if v_id is not null then return v_id; end if;
  end if;
  if v_phone is not null then
    select id into v_id from public.customers where shop_id = p_shop_id and phone = v_phone;
    if v_id is not null then
      if v_ref is not null then update public.customers set client_ref = coalesce(client_ref, v_ref) where id = v_id; end if;
      return v_id;
    end if;
  end if;
  begin
    insert into public.customers (shop_id, name, phone, note, created_by, client_ref)
    values (p_shop_id, left(v_name, 120), v_phone, nullif(trim(coalesce(p_customer->>'note', '')), ''), p_created_by, v_ref)
    returning id into v_id;
  exception when check_violation then
    -- customers off / full on this plan: the sale still records, as a walk-in
    v_id := null;
  end;
  return v_id;
end $$;

create or replace function public.replay_offline_customer(
  p_shop_id uuid, p_client_ref uuid, p_created_by uuid, p_name text, p_phone text default null, p_note text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.rate_limit_hit('customer:' || public.current_app_user_id(), 300, interval '10 minutes');
  if not (public.has_permission(p_shop_id, 'sales.create') or public.has_permission(p_shop_id, 'customers.manage')) then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.shop_members where shop_id = p_shop_id and user_id = p_created_by) then
    raise exception 'creator is not a member of this shop' using errcode = 'insufficient_privilege';
  end if;
  if p_phone is not null and p_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phone must be 7-15 digits' using errcode = 'check_violation';
  end if;
  -- Already uploaded (retry) → fine even if the plan is now full.
  select id into v_id from public.customers where shop_id = p_shop_id and client_ref = p_client_ref;
  if v_id is not null then return v_id; end if;
  if p_phone is not null then
    select id into v_id from public.customers where shop_id = p_shop_id and phone = p_phone;
    if v_id is not null then update public.customers set client_ref = coalesce(client_ref, p_client_ref) where id = v_id; return v_id; end if;
  end if;
  perform public.require_entitlement(p_shop_id, 'customers');   -- plain refusal, the terminal shows it
  return public.resolve_offline_customer(p_shop_id,
    jsonb_build_object('client_ref', p_client_ref, 'name', p_name, 'phone', p_phone, 'note', p_note), p_created_by);
end $$;

-- Items, expenses, tax filing: insert triggers.
create or replace function public.enforce_item_entitlement()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(new.shop_id, 'items'); perform public.require_writable(new.shop_id); return new; end $$;
create trigger items_entitlement before insert on public.items for each row execute function public.enforce_item_entitlement();

create or replace function public.enforce_expense_entitlement()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(new.shop_id, 'expenses'); perform public.require_writable(new.shop_id); return new; end $$;
create trigger expenses_entitlement before insert on public.expenses for each row execute function public.enforce_expense_entitlement();

create or replace function public.enforce_tax_entitlement()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(new.shop_id, 'tax'); return new; end $$;
create trigger tax_periods_entitlement before insert on public.tax_periods for each row execute function public.enforce_tax_entitlement();

-- Purchases: the subscription gate only (buying stock is core, not gated).
create or replace function public.enforce_purchase_writable()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.require_writable(new.shop_id); return new; end $$;
create trigger purchases_writable before insert on public.purchases for each row execute function public.enforce_purchase_writable();

-- Staff: at invite AND at accept (shop_members insert).
create or replace function public.enforce_staff_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(new.shop_id, 'staff'); return new; end $$;
drop trigger if exists shop_members_limit on public.shop_members;
create trigger shop_members_limit before insert on public.shop_members for each row
  when (new.role_id <> '00000000-0000-0000-0000-000000000001') execute function public.enforce_staff_limit();

-- Shops per owner: create_shop.
alter function public.create_shop(text) rename to create_shop_v1;
revoke all on function public.create_shop_v1(text) from public, anon, authenticated;
create or replace function public.create_shop(p_name text)
returns public.shops language plpgsql security definer set search_path = public as $$
declare v_user uuid := public.current_app_user_id(); v_any uuid; e record; v_owned int;
begin
  if v_user is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  perform public.rate_limit_hit('create_shop:' || v_user, 5, interval '1 hour');
  -- The limit is read from a shop this user already owns (they all share the owner's plan in practice).
  select shop_id into v_any from public.shop_members where user_id = v_user and is_active and role_id = '00000000-0000-0000-0000-000000000001' limit 1;
  if v_any is not null then
    select * into e from public.entitlement_of(v_any, 'shops');
    select count(*) into v_owned from public.shop_members m join public.shops s on s.id = m.shop_id and s.is_active
      where m.user_id = v_user and m.is_active and m.role_id = '00000000-0000-0000-0000-000000000001';
    if e.quantity is not null and v_owned >= e.quantity then
      raise exception 'plan_limit: Your plan allows % shop%. Upgrade to add another.', e.quantity, case when e.quantity = 1 then '' else 's' end using errcode = 'check_violation';
    end if;
  end if;
  return public.create_shop_v1(p_name);
end $$;
revoke all on function public.create_shop(text) from public;
grant execute on function public.create_shop(text) to authenticated;

-- Terminals: at code creation (replaces the 0017 body's check) and at activation.
create or replace function public.create_device_activation_code(p_shop_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_bytes bytea := gen_random_bytes(8);
  v_row public.device_activation_codes;
  i int;
begin
  if not public.has_permission(p_shop_id, 'shop.settings') then
    raise exception 'permission denied: shop.settings' using errcode = 'insufficient_privilege';
  end if;
  perform public.rate_limit_hit('actcode:' || public.current_app_user_id(), 20, interval '1 hour');
  perform public.require_entitlement(p_shop_id, 'terminals');
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.device_activation_codes (shop_id, code_hash, created_by)
  values (p_shop_id, sha256(convert_to(v_code, 'UTF8')), public.current_app_user_id())
  returning * into v_row;
  return query select v_code, v_row.expires_at;
end $$;

alter function public.activate_device(text, text) rename to activate_device_v1;
revoke all on function public.activate_device_v1(text, text) from public, anon, authenticated;
create or replace function public.activate_device(p_code text, p_device_name text)
returns table (device_id uuid, shop_id uuid, credential text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_shop uuid;
begin
  select c.shop_id into v_shop from public.device_activation_codes c
    where c.code_hash = sha256(convert_to(upper(trim(p_code)), 'UTF8')) and c.used_at is null and c.expires_at > now();
  if v_shop is not null then
    perform pg_advisory_xact_lock(hashtext('activate:' || v_shop));   -- two codes can't both squeeze in
    perform public.require_entitlement(v_shop, 'terminals');
  end if;
  return query select * from public.activate_device_v1(p_code, p_device_name);   -- keeps the 0025 IP rate limit
end $$;
revoke all on function public.activate_device(text, text) from public;
grant execute on function public.activate_device(text, text) to anon, authenticated;

-- Roles & PINs (toggle).
alter function public.create_custom_role(uuid, text, text, text[]) rename to create_custom_role_v1;
revoke all on function public.create_custom_role_v1(uuid, text, text, text[]) from public, anon, authenticated;
create or replace function public.create_custom_role(p_shop_id uuid, p_key text, p_name text, p_permissions text[])
returns public.roles language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(p_shop_id, 'staff_roles', 0); return public.create_custom_role_v1(p_shop_id, p_key, p_name, p_permissions); end $$;
revoke all on function public.create_custom_role(uuid, text, text, text[]) from public;
grant execute on function public.create_custom_role(uuid, text, text, text[]) to authenticated;

alter function public.get_my_manager_pin(uuid, interval) rename to get_my_manager_pin_v1;
revoke all on function public.get_my_manager_pin_v1(uuid, interval) from public, anon, authenticated;
create or replace function public.get_my_manager_pin(p_shop_id uuid, p_rotation interval default interval '7 days')
returns table (pin text, expires_at timestamptz) language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(p_shop_id, 'staff_roles', 0); return query select * from public.get_my_manager_pin_v1(p_shop_id, p_rotation); end $$;
revoke all on function public.get_my_manager_pin(uuid, interval) from public;
grant execute on function public.get_my_manager_pin(uuid, interval) to authenticated;

alter function public.authorize_override(uuid, text, text, uuid) rename to authorize_override_v1;
revoke all on function public.authorize_override_v1(uuid, text, text, uuid) from public, anon, authenticated;
create or replace function public.authorize_override(p_shop_id uuid, p_pin text, p_action text, p_reference_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
begin perform public.require_entitlement(p_shop_id, 'staff_roles', 0); return public.authorize_override_v1(p_shop_id, p_pin, p_action, p_reference_id); end $$;
revoke all on function public.authorize_override(uuid, text, text, uuid) from public;
grant execute on function public.authorize_override(uuid, text, text, uuid) to authenticated;

-- Reports and tax (toggles) — the read RPCs.
alter function public.shop_report(uuid, date, date) rename to shop_report_v2;
revoke all on function public.shop_report_v2(uuid, date, date) from public, anon, authenticated;
create or replace function public.shop_report(p_shop_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin perform public.require_entitlement(p_shop_id, 'reports', 0); return public.shop_report_v2(p_shop_id, p_from, p_to); end $$;
revoke all on function public.shop_report(uuid, date, date) from public;
grant execute on function public.shop_report(uuid, date, date) to authenticated;

alter function public.shop_tax_summary(uuid, date, date) rename to shop_tax_summary_v1;
revoke all on function public.shop_tax_summary_v1(uuid, date, date) from public, anon, authenticated;
create or replace function public.shop_tax_summary(p_shop_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin perform public.require_entitlement(p_shop_id, 'tax', 0); return public.shop_tax_summary_v1(p_shop_id, p_from, p_to); end $$;
revoke all on function public.shop_tax_summary(uuid, date, date) from public;
grant execute on function public.shop_tax_summary(uuid, date, date) to authenticated;

-- Notebook scans: the plan's quantity + period replace the single platform number.
create or replace function public.notebook_scan_quota(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e record; v_used int; v_enabled boolean := coalesce((public.platform_setting('notebook.enabled'))::boolean, false);
begin
  if p_shop_id not in (select public.current_shop_ids()) then
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;
  select * into e from public.entitlement_of(p_shop_id, 'notebook_scans');
  v_used := public.entitlement_usage(p_shop_id, 'notebook_scans');
  return jsonb_build_object('enabled', v_enabled and e.enabled, 'allowance', e.quantity, 'used', v_used,
                            'remaining', case when e.quantity is null then null else greatest(e.quantity - v_used, 0) end,
                            'period', coalesce(e.period, 'month'));
end $$;

create or replace function public.notebook_scan_begin(p_shop_id uuid, p_device_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_quota jsonb; v_id uuid;
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  perform public.rate_limit_hit('scan:' || public.current_app_user_id(), 30, interval '10 minutes');
  v_quota := public.notebook_scan_quota(p_shop_id);
  if not (v_quota->>'enabled')::boolean then
    raise exception 'plan_limit: Notebook scans are not included in your plan. Upgrade to use them.' using errcode = 'check_violation';
  end if;
  perform public.require_entitlement(p_shop_id, 'notebook_scans');   -- "used 5 of 5 scans this day"
  insert into public.notebook_scans (shop_id, requested_by, device_id)
  values (p_shop_id, public.current_app_user_id(), p_device_id)
  returning id into v_id;
  return v_id;
end $$;

-- Keep the old limit readers honest (they now derive from entitlements via the trigger).
create or replace function public.shop_plan_limits(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'terminals', (select quantity from public.entitlement_of(p_shop_id, 'terminals')),
    'staff',     (select quantity from public.entitlement_of(p_shop_id, 'staff'))));
$$;

-- ----------------------------------------------------------------------------
-- 8. The token carries it all: entitlements + this terminal's standing
-- ----------------------------------------------------------------------------
create or replace function public.device_heartbeat(
  p_device_id uuid, p_credential text,
  p_monotonic_seconds bigint default null,
  p_wall_clock_seconds bigint default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_device   public.devices;
  v_sub      public.subscriptions;
  v_settings jsonb;
  v_div      bigint;
  v_tol      bigint;
begin
  perform public.rate_limit_hit('hb:' || p_device_id, 120, interval '10 minutes');
  update public.devices d
    set last_sync_at = now()
    where d.id = p_device_id
      and d.credential_hash = sha256(convert_to(p_credential, 'UTF8'))
      and d.revoked_at is null
    returning * into v_device;
  if not found then
    raise exception 'unknown or revoked device' using errcode = 'invalid_password';
  end if;

  select * into v_sub from public.subscriptions where shop_id = v_device.shop_id;
  select settings into v_settings from public.operational_settings where id = 1;

  if p_monotonic_seconds is not null and p_wall_clock_seconds is not null then
    v_tol := ((v_settings->>'clock_skew_tolerance_hours')::bigint) * 3600;
    v_div := abs(p_wall_clock_seconds - p_monotonic_seconds);
    if v_div > v_tol then
      insert into public.clock_anomalies (device_id, shop_id, monotonic_seconds, wall_clock_seconds, divergence_seconds)
      values (p_device_id, v_device.shop_id, p_monotonic_seconds, p_wall_clock_seconds, v_div);
    end if;
  end if;

  return jsonb_build_object(
    'device_id',   v_device.id,
    'shop_id',     v_device.shop_id,
    'server_time', now(),
    'subscription', jsonb_build_object(
      'status',     coalesce(v_sub.status, 'active'),
      'plan',       coalesce(v_sub.plan, 'standard'),
      'expires_at', v_sub.expires_at
    ),
    'policy', jsonb_build_object(
      'grace_days',           v_settings->'subscription_grace_days',
      'read_only_days',       v_settings->'read_only_window_days',
      'mandatory_sync_days',  v_settings->'mandatory_sync_days',
      'sync_warning_days',    v_settings->'sync_warning_days'
    ),
    -- 0027: what this shop may do, and whether THIS terminal counts.
    'entitlements', public.shop_entitlements(v_device.shop_id),
    'standing',     public.device_standing(v_device.id),
    'subscription_token', v_device.subscription_token
  );
end $$;

-- Realtime: the dashboard and terminals hear a plan edit the moment it publishes.
alter publication supabase_realtime add table public.feature_catalogue;

-- Publishing carries entitlements draft → live (0017 listed the columns explicitly).
create or replace function public.publish_catalogue(p_product text, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_version int;
begin
  insert into public.pricing_plans (id, product, key, name, tagline, price_monthly, price_yearly, currency, features, limits, entitlements, highlight, is_visible, sort_order, updated_by, updated_at, created_at)
  select id, product, key, name, tagline, price_monthly, price_yearly, currency, features, limits, entitlements, highlight, is_visible, sort_order, updated_by, now(), created_at
  from public.pricing_plans_draft where product = p_product
  on conflict (id) do update set
    key = excluded.key, name = excluded.name, tagline = excluded.tagline, price_monthly = excluded.price_monthly, price_yearly = excluded.price_yearly,
    currency = excluded.currency, features = excluded.features, limits = excluded.limits, entitlements = excluded.entitlements, highlight = excluded.highlight, is_visible = excluded.is_visible,
    sort_order = excluded.sort_order, updated_by = excluded.updated_by, updated_at = now();
  update public.pricing_plans set is_visible = false, updated_at = now()
   where product = p_product and id not in (select id from public.pricing_plans_draft where product = p_product);
  select coalesce(max(version), 0) + 1 into v_version from public.catalogue_publish where product = p_product;
  insert into public.catalogue_publish (product, version, published_by, note) values (p_product, v_version, public.current_app_user_id(), p_note);
  return v_version;
end $$;
revoke all on function public.publish_catalogue(text, text) from public, anon, authenticated;
