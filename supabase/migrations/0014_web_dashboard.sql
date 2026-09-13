-- ============================================================================
-- 0014_web_dashboard.sql — Stage 8: web dashboard (Nathan, 2026-09-13)
--
-- RUN MANUALLY after 0013. Functions only, plus one settings-key cleanup.
--
--   * shop_report()                — owner reporting for a period (reports.view)
--   * admin_list_shops()           — Zogal back office: every shop at a glance
--   * admin_set_subscription()     — back office sets status / plan / expiry
--   * admin_operational_settings() / admin_update_operational_settings()
--                                  — the §5.1 operational page, platform admins only
--
-- All admin_* functions are gated on is_platform_admin() (0013). Shop owners
-- have no path to them.
-- ============================================================================

-- 0013 moved the notebook allowance to platform_settings; drop the older
-- duplicate key from operational_settings so there is one source of truth.
update public.operational_settings
   set settings = settings - 'notebook_free_scans_monthly'
 where id = 1 and settings ? 'notebook_free_scans_monthly';

-- ----------------------------------------------------------------------------
-- 1. Owner reporting
-- ----------------------------------------------------------------------------
create or replace function public.shop_report(p_shop_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz        text;
  v_view_cost boolean;
begin
  if not public.has_permission(p_shop_id, 'reports.view') then
    raise exception 'permission denied: reports.view' using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from or (p_to - p_from) > 800 then
    raise exception 'bad range' using errcode = 'check_violation';
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_view_cost := public.has_permission(p_shop_id, 'items.view_cost');

  return (
    with s as (
      select s.*, (s.sold_at at time zone v_tz)::date as sold_on
      from public.sales s
      where s.shop_id = p_shop_id and s.status = 'completed'
        and (s.sold_at at time zone v_tz)::date between p_from and p_to
    ),
    l as (
      select l.*, s.sold_by, s.device_id, s.customer_id,
             coalesce((select sum(a.quantity * a.unit_cost) from public.sale_line_allocations a where a.sale_line_id = l.id), 0) as cogs,
             coalesce((select sum(a.quantity) from public.sale_line_allocations a where a.sale_line_id = l.id), 0) as covered
      from public.sale_lines l join s on s.id = l.sale_id
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'totals', (select jsonb_build_object(
          'sales_count', count(distinct sale_id), 'units', coalesce(sum(quantity), 0),
          'revenue', coalesce(sum(quantity * unit_price), 0),
          'gross_profit', case when v_view_cost then coalesce(sum(quantity * unit_price), 0) - coalesce(sum(cogs), 0) else null end,
          'expenses', case when v_view_cost then (select coalesce(sum(amount), 0) from public.expenses where shop_id = p_shop_id and voided_at is null and incurred_on between p_from and p_to) else null end
        ) from l),
      'by_seller', (select coalesce(jsonb_agg(jsonb_build_object(
          'user_id', u.id, 'name', u.full_name, 'sales_count', x.n, 'units', x.units, 'revenue', x.revenue,
          'gross_profit', case when v_view_cost then x.profit else null end) order by x.revenue desc), '[]'::jsonb)
        from (select sold_by, count(distinct sale_id) n, sum(quantity) units, sum(quantity * unit_price) revenue,
                     sum(quantity * unit_price) - sum(cogs) profit from l group by sold_by) x
        join public.users u on u.id = x.sold_by),
      'by_terminal', (select coalesce(jsonb_agg(jsonb_build_object(
          'device_id', d.id, 'name', d.name, 'sales_count', x.n, 'revenue', x.revenue) order by x.revenue desc), '[]'::jsonb)
        from (select device_id, count(distinct sale_id) n, sum(quantity * unit_price) revenue from l where device_id is not null group by device_id) x
        join public.devices d on d.id = x.device_id),
      'by_item', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_id', i.id, 'name', i.name, 'units', x.units, 'revenue', x.revenue,
          'gross_profit', case when v_view_cost then x.profit else null end,
          'on_hand', coalesce((select sum(quantity_remaining) from public.batches b where b.item_id = i.id), 0)) order by x.revenue desc), '[]'::jsonb)
        from (select item_id, sum(quantity) units, sum(quantity * unit_price) revenue, sum(quantity * unit_price) - sum(cogs) profit from l group by item_id) x
        join public.items i on i.id = x.item_id),
      'by_customer', (select coalesce(jsonb_agg(jsonb_build_object(
          'customer_id', c.id, 'name', c.name, 'sales_count', x.n, 'revenue', x.revenue) order by x.revenue desc), '[]'::jsonb)
        from (select customer_id, count(distinct sale_id) n, sum(quantity * unit_price) revenue from l where customer_id is not null group by customer_id) x
        join public.customers c on c.id = x.customer_id),
      'expenses_by_category', case when v_view_cost then (select coalesce(jsonb_agg(jsonb_build_object('category', category_key, 'amount', amt) order by amt desc), '[]'::jsonb)
        from (select category_key, sum(amount) amt from public.expenses where shop_id = p_shop_id and voided_at is null and incurred_on between p_from and p_to group by category_key) e) else '[]'::jsonb end,
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'revenue', coalesce((select sum(total) from s where sold_on = d::date), 0),
                                                              'count', (select count(*) from s where sold_on = d::date)) order by d), '[]'::jsonb)
        from generate_series(p_from, p_to, interval '1 day') d)
    )
  );
end $$;
revoke all on function public.shop_report(uuid, date, date) from public;
grant execute on function public.shop_report(uuid, date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Zogal back office
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_shops()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = 'insufficient_privilege';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'timezone', s.timezone, 'is_active', s.is_active, 'created_at', s.created_at,
      'subscription', (select jsonb_build_object('status', status, 'plan', plan, 'expires_at', expires_at) from public.subscriptions where shop_id = s.id),
      'owner', (select jsonb_build_object('name', u.full_name, 'email', u.email) from public.shop_members m join public.users u on u.id = m.user_id
                where m.shop_id = s.id and m.role_id = '00000000-0000-0000-0000-000000000001' and m.is_active order by m.joined_at limit 1),
      'members', (select count(*) from public.shop_members where shop_id = s.id and is_active),
      'devices', (select count(*) from public.devices where shop_id = s.id and revoked_at is null),
      'devices_online', (select count(*) from public.devices where shop_id = s.id and revoked_at is null and last_sync_at > now() - interval '5 minutes'),
      'last_sale_at', (select max(sold_at) from public.sales where shop_id = s.id),
      'sales_30d', (select coalesce(sum(total), 0) from public.sales where shop_id = s.id and status = 'completed' and sold_at > now() - interval '30 days'),
      'scans_this_month', (select count(*) from public.notebook_scans where shop_id = s.id and status <> 'failed' and created_at >= date_trunc('month', now())),
      'open_conflicts', (select count(*) from public.sync_conflicts where shop_id = s.id and resolved_at is null)
    ) order by s.created_at desc), '[]'::jsonb)
    from public.shops s
  );
end $$;
revoke all on function public.admin_list_shops() from public;
grant execute on function public.admin_list_shops() to authenticated;

create or replace function public.admin_set_subscription(p_shop_id uuid, p_status text, p_plan text, p_expires_at timestamptz)
returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare v public.subscriptions;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = 'insufficient_privilege';
  end if;
  insert into public.subscriptions (shop_id, status, plan, expires_at)
  values (p_shop_id, p_status, coalesce(p_plan, 'standard'), p_expires_at)
  on conflict (shop_id) do update set status = excluded.status, plan = excluded.plan, expires_at = excluded.expires_at
  returning * into v;
  return v;
end $$;
revoke all on function public.admin_set_subscription(uuid, text, text, timestamptz) from public;
grant execute on function public.admin_set_subscription(uuid, text, text, timestamptz) to authenticated;

create or replace function public.admin_operational_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = 'insufficient_privilege';
  end if;
  return (select jsonb_build_object('settings', settings, 'updated_at', updated_at) from public.operational_settings where id = 1);
end $$;
revoke all on function public.admin_operational_settings() from public;
grant execute on function public.admin_operational_settings() to authenticated;

-- Merge: only the keys given change; history trigger records old/new.
create or replace function public.admin_update_operational_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be an object' using errcode = 'check_violation';
  end if;
  update public.operational_settings
     set settings = settings || p_patch, updated_by = public.current_app_user_id()
   where id = 1
   returning settings into v;
  return v;
end $$;
revoke all on function public.admin_update_operational_settings(jsonb) from public;
grant execute on function public.admin_update_operational_settings(jsonb) to authenticated;

-- Platform settings: admins already have RLS access (0013); set updated_by
-- on every write so the history names who changed it.
create or replace function public.admin_set_platform_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = 'insufficient_privilege';
  end if;
  update public.platform_settings set value = p_value, updated_by = public.current_app_user_id() where key = p_key;
  if not found then
    raise exception 'unknown setting %', p_key using errcode = 'no_data_found';
  end if;
end $$;
revoke all on function public.admin_set_platform_setting(text, jsonb) from public;
grant execute on function public.admin_set_platform_setting(text, jsonb) to authenticated;
