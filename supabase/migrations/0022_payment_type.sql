-- ============================================================================
-- 0022_payment_type.sql — how the customer paid (Nathan, 2026-09-20).
-- RUN MANUALLY after 0021.
--
--   sales.payment_type: cash | transfer | card | pos. Chosen at the terminal
--   when the sale is recorded (cash preselected, one tap to change). Carried
--   through the offline queue (SYNC: replay_offline_sale gains the parameter;
--   old queued entries replay as cash). Reports split takings by type.
--   No split payments in this pass. This is how the SHOP was paid — it has
--   nothing to do with Zogal's subscription billing.
-- ============================================================================

alter table public.sales add column if not exists payment_type text not null default 'cash'
  check (payment_type in ('cash', 'transfer', 'card', 'pos'));
create index if not exists sales_shop_payment_idx on public.sales (shop_id, payment_type, sold_at desc);

-- Old signatures go so PostgREST resolves one function per name.
drop function if exists public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid);
drop function if exists public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb);

create or replace function public.record_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz default now(), p_note text default null,
  p_device_id uuid default null, p_customer_id uuid default null,
  p_payment_type text default 'cash'
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  v_sale   public.sales;
  v_line   jsonb;
  v_item   public.items;
  v_qty    int;
  v_price  numeric(14,2);
  v_line_id uuid;
  v_total  numeric(14,2) := 0;
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  if p_sold_by is distinct from public.current_app_user_id() then
    raise exception 'sold_by must be the calling user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is not null and not exists (
    select 1 from public.devices where id = p_device_id and shop_id = p_shop_id and revoked_at is null
  ) then
    raise exception 'device is not an active device of this shop' using errcode = 'insufficient_privilege';
  end if;
  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and shop_id = p_shop_id
  ) then
    raise exception 'customer not found in this shop' using errcode = 'no_data_found';
  end if;
  if p_payment_type not in ('cash', 'transfer', 'card', 'pos') then
    raise exception 'payment_type must be cash, transfer, card or pos' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a sale needs at least one line' using errcode = 'check_violation';
  end if;

  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id, customer_id, payment_type)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id, p_customer_id, p_payment_type)
  returning * into v_sale;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty   := (v_line->>'quantity')::int;
    v_price := (v_line->>'unit_price')::numeric;

    select * into v_item from public.items
      where id = (v_line->>'item_id')::uuid and shop_id = p_shop_id and is_active;
    if not found then
      raise exception 'item % not found in shop', v_line->>'item_id' using errcode = 'no_data_found';
    end if;
    if v_price < v_item.floor_price then
      raise exception 'below_floor: % sold at % (floor %)', v_item.name, v_price, v_item.floor_price
        using errcode = 'check_violation';
    end if;

    insert into public.sale_lines (sale_id, shop_id, item_id, quantity, unit_price, floor_price_at_sale)
    values (v_sale.id, p_shop_id, v_item.id, v_qty, v_price, v_item.floor_price)
    returning id into v_line_id;

    perform public.consume_batches_fifo(v_line_id);
    v_total := v_total + v_qty * v_price;
  end loop;

  update public.sales set total = v_total where id = v_sale.id returning * into v_sale;
  return v_sale;
end $$;
revoke all on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid, text) from public;
grant execute on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid, text) to authenticated;

create or replace function public.replay_offline_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz, p_device_id uuid, p_note text default null,
  p_customer jsonb default null, p_payment_type text default 'cash'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sale      public.sales;
  v_line      jsonb;
  v_item      public.items;
  v_qty       int;
  v_price     numeric(14,2);
  v_floor     numeric(14,2);
  v_line_id   uuid;
  v_total     numeric(14,2) := 0;
  v_short     int;
  v_conflicts int := 0;
  v_customer  uuid := null;
  v_phone     text;
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.shop_members where shop_id = p_shop_id and user_id = p_sold_by) then
    raise exception 'seller is not a member of this shop' using errcode = 'insufficient_privilege';
  end if;

  select * into v_sale from public.sales where shop_id = p_shop_id and client_ref = p_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale.id, 'already_synced', true, 'conflicts', 0);
  end if;

  if p_device_id is not null and not exists (
    select 1 from public.devices where id = p_device_id and shop_id = p_shop_id and revoked_at is null
  ) then
    raise exception 'device is not an active device of this shop' using errcode = 'insufficient_privilege';
  end if;

  -- Resolve the customer, if any. Never fail the sale over a customer:
  -- an unknown id simply records a walk-in.
  if p_customer is not null then
    if p_customer ? 'id' then
      select id into v_customer from public.customers
        where id = (p_customer->>'id')::uuid and shop_id = p_shop_id;
    elsif nullif(trim(coalesce(p_customer->>'name', '')), '') is not null then
      v_phone := nullif(trim(coalesce(p_customer->>'phone', '')), '');
      if v_phone is not null then
        select id into v_customer from public.customers where shop_id = p_shop_id and phone = v_phone;
      end if;
      if v_customer is null then
        insert into public.customers (shop_id, name, phone, created_by)
        values (p_shop_id, trim(p_customer->>'name'), v_phone, p_sold_by)
        returning id into v_customer;
      end if;
    end if;
  end if;

  -- Never fail a queued sale over the payment type: an unknown value records as cash.
  perform set_config('app.offline_replay', '1', true);
  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id, customer_id, payment_type)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id, v_customer,
          case when p_payment_type in ('cash', 'transfer', 'card', 'pos') then p_payment_type else 'cash' end)
  returning * into v_sale;
  perform set_config('app.offline_replay', '', true);

  if public.period_is_locked(p_shop_id, (p_sold_at at time zone 'Africa/Lagos')::date) then
    insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, detail, occurred_at)
    values (p_shop_id, p_device_id, 'locked_period', v_sale.id,
            jsonb_build_object('note', 'Sale arrived after its tax period was filed'), p_sold_at);
    v_conflicts := v_conflicts + 1;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty   := (v_line->>'quantity')::int;
    v_price := (v_line->>'unit_price')::numeric;
    select * into v_item from public.items where id = (v_line->>'item_id')::uuid and shop_id = p_shop_id;
    if not found then
      raise exception 'item % not found in shop', v_line->>'item_id' using errcode = 'no_data_found';
    end if;
    v_floor := coalesce((v_line->>'floor_price_at_sale')::numeric, v_item.floor_price);
    if v_price < v_floor then
      insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, item_id, detail, occurred_at)
      values (p_shop_id, p_device_id, 'below_floor', v_sale.id, v_item.id,
              jsonb_build_object('unit_price', v_price, 'floor_at_sale', v_floor, 'item_name', v_item.name), p_sold_at);
      v_conflicts := v_conflicts + 1;
      v_floor := v_price;
    end if;
    insert into public.sale_lines (sale_id, shop_id, item_id, quantity, unit_price, floor_price_at_sale)
    values (v_sale.id, p_shop_id, v_item.id, v_qty, v_price, v_floor)
    returning id into v_line_id;
    v_short := public.consume_batches_fifo_partial(v_line_id);
    if v_short > 0 then
      insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, item_id, detail, occurred_at)
      values (p_shop_id, p_device_id, 'stock_shortfall', v_sale.id, v_item.id,
              jsonb_build_object('quantity_sold', v_qty, 'unattributed', v_short, 'item_name', v_item.name), p_sold_at);
      v_conflicts := v_conflicts + 1;
    end if;
    v_total := v_total + v_qty * v_price;
  end loop;

  update public.sales set total = v_total where id = v_sale.id;
  return jsonb_build_object('sale_id', v_sale.id, 'already_synced', false, 'conflicts', v_conflicts);
end $$;
revoke all on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb, text) from public;
grant execute on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb, text) to authenticated;

-- Takings by payment type for a date range (owner reports; permission checked inside).
create or replace function public.takings_by_payment_type(p_shop_id uuid, p_from timestamptz, p_to timestamptz)
returns table (payment_type text, receipts bigint, total numeric)
language sql stable security definer set search_path = public as $$
  select s.payment_type, count(*), coalesce(sum(s.total), 0)
  from public.sales s
  where s.shop_id = p_shop_id and s.status = 'completed' and s.sold_at >= p_from and s.sold_at < p_to
    and public.has_permission(p_shop_id, 'reports.view')
  group by s.payment_type order by 3 desc;
$$;
revoke all on function public.takings_by_payment_type(uuid, timestamptz, timestamptz) from public;
grant execute on function public.takings_by_payment_type(uuid, timestamptz, timestamptz) to authenticated;
