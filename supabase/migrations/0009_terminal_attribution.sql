-- ============================================================================
-- 0009_terminal_attribution.sql — who did what, on which terminal
--
-- RUN MANUALLY after 0008. Approved by Nathan 2026-09-11.
--
--   1. purchases.device_id — so the admin can filter purchases by terminal,
--      the way sales already can.
--   2. replay_offline_sale() accepts the ORIGINAL seller. A shared terminal
--      changes hands between shifts; the person signed in when the outbox
--      finally uploads is not necessarily the one who made the sale.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Purchases know their terminal
-- ----------------------------------------------------------------------------
alter table public.purchases
  add column device_id uuid references public.devices(id) on delete set null;
create index purchases_device_idx on public.purchases (device_id, purchased_at desc);

-- ----------------------------------------------------------------------------
-- 2. Offline replay keeps the real seller
-- ----------------------------------------------------------------------------
-- SYNC: before this, the replay stamped whoever was signed in at upload time.
-- Now the terminal reports who was signed in when the sale HAPPENED, and the
-- server accepts that provided:
--   * the caller is an active member of the shop with sales.create
--   * the named seller is (or was) an active member of the same shop
--   * the device is genuinely that shop's
-- Trade-off, stated plainly: someone with sales rights could attribute a sale
-- to a colleague. The terminal id, client_ref and timestamps are all in the
-- audit trail, so within one shop that is accepted.
create or replace function public.replay_offline_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz, p_device_id uuid, p_note text default null
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
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;

  -- The seller must belong to this shop. (Not necessarily still active: a
  -- salesperson who left on Friday still made Thursday's offline sales.)
  if not exists (select 1 from public.shop_members where shop_id = p_shop_id and user_id = p_sold_by) then
    raise exception 'seller is not a member of this shop' using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent: already replayed?
  select * into v_sale from public.sales where shop_id = p_shop_id and client_ref = p_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale.id, 'already_synced', true, 'conflicts', 0);
  end if;

  if p_device_id is not null and not exists (
    select 1 from public.devices where id = p_device_id and shop_id = p_shop_id and revoked_at is null
  ) then
    raise exception 'device is not an active device of this shop' using errcode = 'insufficient_privilege';
  end if;

  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id)
  returning * into v_sale;

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
