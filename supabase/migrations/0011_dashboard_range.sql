-- ============================================================================
-- 0011_dashboard_range.sql — figures for any period (Nathan, 2026-09-12)
--
-- RUN MANUALLY after 0010. Function only, no table changes.
--
-- shop_dashboard(shop_id) knew one window: today. Owners want yesterday,
-- last 7 days, last month, last year. This adds shop_dashboard(shop_id,
-- from, to) returning the same shape plus a `range` block and a per-day
-- `series` for the window. The one-argument form stays and means "today".
-- Same permission gating as before: sales.view_all → shop vs own;
-- items.view_cost → profit/value.
-- ============================================================================

create or replace function public.shop_dashboard(p_shop_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_user      uuid := public.current_app_user_id();
  v_tz        text;
  v_today     date;
  v_view_all  boolean;
  v_view_cost boolean;
  v_days      int;
  v_result    jsonb;
begin
  if p_shop_id not in (select public.current_shop_ids()) then
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from then
    raise exception 'range end is before its start' using errcode = 'check_violation';
  end if;
  v_days := (p_to - p_from) + 1;
  if v_days > 800 then
    raise exception 'range too long (max 800 days)' using errcode = 'check_violation';
  end if;

  select timezone into v_tz from public.shops where id = p_shop_id;
  v_today     := (now() at time zone v_tz)::date;
  v_view_all  := public.has_permission(p_shop_id, 'sales.view_all');
  v_view_cost := public.has_permission(p_shop_id, 'items.view_cost');

  with visible_sales as (
    select s.*, (s.sold_at at time zone v_tz)::date as sold_on
    from public.sales s
    where s.shop_id = p_shop_id and s.status = 'completed'
      and (v_view_all or s.sold_by = v_user)
  ),
  in_range as (select * from visible_sales where sold_on between p_from and p_to),
  range_lines as (select l.*, s.sold_on from public.sale_lines l join in_range s on s.id = l.sale_id),
  range_cogs as (
    select coalesce(sum(a.quantity * a.unit_cost), 0) as cogs
    from public.sale_line_allocations a join range_lines l on l.id = a.sale_line_id
  ),
  today_sales as (select * from visible_sales where sold_on = v_today),
  today_lines as (select l.* from public.sale_lines l join today_sales s on s.id = l.sale_id),
  today_cogs as (
    select coalesce(sum(a.quantity * a.unit_cost), 0) as cogs
    from public.sale_line_allocations a join today_lines l on l.id = a.sale_line_id
  ),
  -- Per-day series over the window. Days are bucketed weekly beyond 90
  -- days so a year still renders as a readable chart.
  buckets as (
    select case when v_days <= 92 then d::date else date_trunc('week', d)::date end as day
    from generate_series(p_from, p_to, interval '1 day') d
    group by 1
  ),
  series as (
    select b.day,
           coalesce((select sum(total) from in_range s
                     where (case when v_days <= 92 then s.sold_on else date_trunc('week', s.sold_on)::date end) = b.day), 0) as total,
           coalesce((select count(*) from in_range s
                     where (case when v_days <= 92 then s.sold_on else date_trunc('week', s.sold_on)::date end) = b.day), 0) as count
    from buckets b
  ),
  stock as (
    select count(distinct i.id) as items,
           coalesce(sum(b.quantity_remaining), 0) as units,
           coalesce(sum(b.quantity_remaining * b.unit_cost), 0) as value
    from public.items i
    left join public.batches b on b.item_id = i.id and b.quantity_remaining > 0
    where i.shop_id = p_shop_id and i.is_active
  ),
  low_stock as (
    select count(*) as low from public.items i
    where i.shop_id = p_shop_id and i.is_active
      and coalesce((select sum(x.quantity_remaining) from public.batches x where x.item_id = i.id), 0) <= 2
  ),
  devices as (
    select count(*) filter (where revoked_at is null) as total,
           count(*) filter (where revoked_at is null and last_sync_at > now() - interval '5 minutes') as online
    from public.devices where shop_id = p_shop_id
  ),
  staff as (select count(*) as total from public.shop_members where shop_id = p_shop_id and is_active),
  range_expenses as (
    select coalesce(sum(amount), 0) as v from public.expenses
    where shop_id = p_shop_id and voided_at is null and incurred_on between p_from and p_to
  )
  select jsonb_build_object(
    'today', jsonb_build_object(
      'date', v_today,
      'sales_count', (select count(*) from today_sales),
      'sales_total', (select coalesce(sum(total), 0) from today_sales),
      'units_sold',  (select coalesce(sum(quantity), 0) from today_lines),
      'gross_profit', case when v_view_cost
        then (select coalesce(sum(quantity * unit_price), 0) from today_lines) - (select cogs from today_cogs)
        else null end
    ),
    'range', jsonb_build_object(
      'from', p_from, 'to', p_to, 'days', v_days,
      'sales_count', (select count(*) from in_range),
      'sales_total', (select coalesce(sum(total), 0) from in_range),
      'units_sold',  (select coalesce(sum(quantity), 0) from range_lines),
      'gross_profit', case when v_view_cost
        then (select coalesce(sum(quantity * unit_price), 0) from range_lines) - (select cogs from range_cogs)
        else null end,
      'expenses', case when v_view_cost then (select v from range_expenses) else null end,
      'net_profit', case when v_view_cost
        then (select coalesce(sum(quantity * unit_price), 0) from range_lines) - (select cogs from range_cogs) - (select v from range_expenses)
        else null end
    ),
    'series', (select jsonb_agg(jsonb_build_object('day', day, 'total', total, 'count', count) order by day) from series),
    'bucket', case when v_days <= 92 then 'day' else 'week' end,
    -- kept for callers that still read `week`
    'week', (select jsonb_agg(jsonb_build_object('day', day, 'total', total, 'count', count) order by day)
             from (select d::date as day,
                          coalesce((select sum(total) from visible_sales where sold_on = d::date), 0) as total,
                          coalesce((select count(*) from visible_sales where sold_on = d::date), 0) as count
                   from generate_series(v_today - 6, v_today, interval '1 day') d) w),
    'stock', jsonb_build_object(
      'items', (select items from stock), 'units', (select units from stock),
      'value', case when v_view_cost then (select value from stock) else null end,
      'low_stock', (select low from low_stock)
    ),
    'devices', (select jsonb_build_object('total', total, 'online', online) from devices),
    'staff', (select jsonb_build_object('total', total) from staff),
    'scope', case when v_view_all then 'shop' else 'mine' end
  ) into v_result;

  return v_result;
end $$;
revoke all on function public.shop_dashboard(uuid, date, date) from public;
grant execute on function public.shop_dashboard(uuid, date, date) to authenticated;

-- The one-argument form now delegates: "today".
create or replace function public.shop_dashboard(p_shop_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_today date;
begin
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_today := (now() at time zone v_tz)::date;
  return public.shop_dashboard(p_shop_id, v_today, v_today);
end $$;
