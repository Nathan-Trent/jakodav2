-- ============================================================================
-- 0004_sales_device.sql — Stage 3: desktop skeleton
--
-- RUN MANUALLY after 0003.
--   * sales.device_id — which terminal recorded the sale (multi-terminal
--     reporting; SYNC: also the key for attributing offline replays)
--   * record_sale() gains p_device_id
--   * device_status.is_online: false instead of null for never-synced devices
--   * shop_stock(shop_id) — on-hand quantities for all members (no costs)
-- ============================================================================

alter table public.sales
  add column device_id uuid references public.devices(id) on delete set null;
create index sales_device_idx on public.sales (device_id, sold_at desc);

-- Drop the old signature so PostgREST doesn't see two overloads.
drop function if exists public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text);

create or replace function public.record_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz default now(), p_note text default null,
  p_device_id uuid default null
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
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a sale needs at least one line' using errcode = 'check_violation';
  end if;

  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id)
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
revoke all on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid) from public;
grant execute on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid) to authenticated;

-- Stock on hand for everyone in the shop — quantities only, no costs.
-- (item_stock exposes stock_value and stays gated by items.view_cost via
-- the batches RLS; this function bypasses that RLS deliberately and returns
-- nothing cost-related.)
create or replace function public.shop_stock(p_shop_id uuid)
returns table (item_id uuid, on_hand int)
language sql stable security definer set search_path = public as $$
  select i.id, coalesce(sum(b.quantity_remaining), 0)::int
  from public.items i
  left join public.batches b on b.item_id = i.id and b.quantity_remaining > 0
  where i.shop_id = p_shop_id
    and p_shop_id in (select public.current_shop_ids())
  group by i.id;
$$;
revoke all on function public.shop_stock(uuid) from public;
grant execute on function public.shop_stock(uuid) to authenticated;

create or replace view public.device_status with (security_invoker = true) as
  select id, shop_id, name, last_sync_at, revoked_at,
         coalesce(revoked_at is null and last_sync_at > now() - interval '5 minutes', false) as is_online
  from public.devices;
