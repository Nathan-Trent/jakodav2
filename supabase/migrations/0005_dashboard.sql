-- ============================================================================
-- 0005_dashboard.sql — App shell: dashboard overview in one call
--
-- RUN MANUALLY after 0004. Function only, no table changes.
--
-- shop_dashboard(shop_id) returns a permission-aware overview:
--   * sales figures respect sales.view_all (else: caller's own sales only)
--   * gross_profit / stock_value are null unless caller has items.view_cost
--   * "today" and the 7-day series use the shop's timezone
-- ============================================================================

create or replace function public.shop_dashboard(p_shop_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_user      uuid := public.current_app_user_id();
  v_tz        text;
  v_today     date;
  v_view_all  boolean;
  v_view_cost boolean;
  v_result    jsonb;
begin
  if p_shop_id not in (select public.current_shop_ids()) then
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;

  select timezone into v_tz from public.shops where id = p_shop_id;
  v_today     := (now() at time zone v_tz)::date;
  v_view_all  := public.has_permission(p_shop_id, 'sales.view_all');
  v_view_cost := public.has_permission(p_shop_id, 'items.view_cost');

  with visible_sales as (
    select s.* from public.sales s
    where s.shop_id = p_shop_id and s.status = 'completed'
      and (v_view_all or s.sold_by = v_user)
  ),
  today_sales as (
    select * from visible_sales where (sold_at at time zone v_tz)::date = v_today
  ),
  today_lines as (
    select l.* from public.sale_lines l join today_sales s on s.id = l.sale_id
  ),
  today_cogs as (
    select coalesce(sum(a.quantity * a.unit_cost), 0) as cogs
    from public.sale_line_allocations a join today_lines l on l.id = a.sale_line_id
  ),
  week as (
    select d::date as day,
           coalesce((select sum(total) from visible_sales
                     where (sold_at at time zone v_tz)::date = d::date), 0) as total,
           coalesce((select count(*) from visible_sales
                     where (sold_at at time zone v_tz)::date = d::date), 0) as count
    from generate_series(v_today - 6, v_today, interval '1 day') d
  ),
  stock as (
    select count(distinct i.id) as items,
           coalesce(sum(b.quantity_remaining), 0) as units,
           coalesce(sum(b.quantity_remaining * b.unit_cost), 0) as value
    from public.items i
    left join public.batches b on b.item_id = i.id and b.quantity_remaining > 0
    where i.shop_id = p_shop_id and i.is_active
  ),
  -- Low stock = 2 or fewer on hand. Threshold becomes a §5.1 setting later.
  low_stock as (
    select count(*) as low
    from public.items i
    where i.shop_id = p_shop_id and i.is_active
      and coalesce((select sum(x.quantity_remaining) from public.batches x where x.item_id = i.id), 0) <= 2
  ),
  devices as (
    select count(*) filter (where revoked_at is null) as total,
           count(*) filter (where revoked_at is null and last_sync_at > now() - interval '5 minutes') as online
    from public.devices where shop_id = p_shop_id
  ),
  staff as (
    select count(*) as total from public.shop_members where shop_id = p_shop_id and is_active
  )
  select jsonb_build_object(
    'today', jsonb_build_object(
      'date', v_today,
      'sales_count', (select count(*) from today_sales),
      'sales_total', (select coalesce(sum(total), 0) from today_sales),
      'units_sold', (select coalesce(sum(quantity), 0) from today_lines),
      'gross_profit', case when v_view_cost
        then (select coalesce(sum(quantity * unit_price), 0) from today_lines) - (select cogs from today_cogs)
        else null end
    ),
    'week', (select jsonb_agg(jsonb_build_object('day', day, 'total', total, 'count', count) order by day) from week),
    'stock', jsonb_build_object(
      'items', (select items from stock),
      'units', (select units from stock),
      'value', case when v_view_cost then (select value from stock) else null end,
      'low_stock', (select low from low_stock)
    ),
    'devices', (select jsonb_build_object('total', total, 'online', online) from devices),
    'staff', (select jsonb_build_object('total', total) from staff),
    'scope', case when v_view_all then 'shop' else 'mine' end
  ) into v_result;

  return v_result;
end $$;
revoke all on function public.shop_dashboard(uuid) from public;
grant execute on function public.shop_dashboard(uuid) to authenticated;
