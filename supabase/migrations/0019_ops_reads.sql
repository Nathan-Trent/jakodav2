-- ============================================================================
-- 0019_ops_reads.sql — gated figures for the back office (2026-09-19).
-- RUN MANUALLY after 0018.
--
-- The client holds the small tables in memory and Realtime keeps them fresh
-- (0018). Three things are too big or too sensitive to push wholesale —
-- sales, notebook scans, per-user effective permissions — so they come
-- through these functions when a screen opens. Each checks the caller's
-- switch itself; the service role is never needed for a read.
-- ============================================================================

-- 30-day sales per shop, 24-hour sale count, and "sales through Doka" total.
create or replace function public.ops_sales_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.has_capability('doka.ops.view') then jsonb_build_object(
    'total_30d', (select coalesce(sum(total), 0) from public.sales where status = 'completed' and sold_at >= now() - interval '30 days'),
    'count_24h', (select count(*) from public.sales where status = 'completed' and sold_at >= now() - interval '24 hours'),
    'last_sale_at', (select max(sold_at) from public.sales where status = 'completed'),
    'by_shop', (select coalesce(jsonb_object_agg(shop_id, jsonb_build_object('total', t, 'receipts', n)), '{}'::jsonb)
                from (select shop_id, sum(total) t, count(*) n from public.sales
                      where status = 'completed' and sold_at >= now() - interval '30 days' group by shop_id) x))
  else null end;
$$;
revoke all on function public.ops_sales_summary() from public;
grant execute on function public.ops_sales_summary() to authenticated;

-- One person: effective permissions per shop (role ± overrides), their last
-- sales, the terminals they used.
create or replace function public.ops_user_detail(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.has_capability('doka.users.view') then jsonb_build_object(
    'permissions', (select coalesce(jsonb_object_agg(m.shop_id, (
        select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from (
          select rp.permission_key k from public.role_permissions rp where rp.role_id = m.role_id
          union select o.permission_key from public.member_permission_overrides o where o.shop_id = m.shop_id and o.user_id = m.user_id and o.allowed
          except select o.permission_key from public.member_permission_overrides o where o.shop_id = m.shop_id and o.user_id = m.user_id and not o.allowed) p)), '{}'::jsonb)
      from public.shop_members m where m.user_id = p_user_id),
    'overrides', (select coalesce(jsonb_agg(jsonb_build_object('shop_id', shop_id, 'permission_key', permission_key, 'allowed', allowed)), '[]'::jsonb)
      from public.member_permission_overrides where user_id = p_user_id),
    'sales', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'total', s.total, 'sold_at', s.sold_at, 'shop_id', s.shop_id, 'terminal', d.name) order by s.sold_at desc), '[]'::jsonb)
      from (select * from public.sales where sold_by = p_user_id and status = 'completed' order by sold_at desc limit 10) s
      left join public.devices d on d.id = s.device_id),
    'terminals', (select coalesce(jsonb_agg(distinct d.name), '[]'::jsonb) from public.sales s join public.devices d on d.id = s.device_id where s.sold_by = p_user_id))
  else null end;
$$;
revoke all on function public.ops_user_detail(uuid) from public;
grant execute on function public.ops_user_detail(uuid) to authenticated;

-- Health facts the client cannot see directly (sales, scans). Everything else
-- on the Health screen is computed from the in-memory tables.
create or replace function public.ops_health_facts()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.has_capability('company.health.view') then jsonb_build_object(
    'last_sale_at', (select max(sold_at) from public.sales where status = 'completed'),
    'last_scan', (select jsonb_build_object('status', status, 'created_at', created_at, 'error', error) from public.notebook_scans order by created_at desc limit 1),
    'db_now', now())
  else null end;
$$;
revoke all on function public.ops_health_facts() from public;
grant execute on function public.ops_health_facts() to authenticated;
