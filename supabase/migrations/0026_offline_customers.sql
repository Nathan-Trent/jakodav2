-- ============================================================================
-- 0026_offline_customers.sql — customers are offline-first (Nathan, 2026-09-19)
-- RUN MANUALLY after 0025.
--
-- Until now a customer added at the till only existed as a name riding on the
-- sale: it was created when the sale was recorded (or replayed), and vanished
-- if the sale was cancelled, held, or the app restarted. Customers → Add saved
-- straight away. Two behaviours for one thing.
--
-- Now a customer is a queued record of its own, like a sale: added on the
-- terminal whether online or not, shown at once, uploaded by the sync engine
-- (outbox kind 'customer'), and merged into the shop's list for every
-- terminal and the dashboard. `client_ref` makes that upload idempotent, so
-- retries never make duplicates; a phone that already exists merges into the
-- existing customer instead.
--
-- SCHEMA ADDITION: customers.client_ref.
-- ============================================================================

alter table public.customers add column client_ref uuid;
create unique index customers_shop_client_ref_uq on public.customers (shop_id, client_ref) where client_ref is not null;

-- ----------------------------------------------------------------------------
-- resolve_offline_customer(): {id} | {client_ref,name,phone} | {name,phone}
-- → customers.id or null. Shared by the customer replay and the sale replay.
-- Never raises over a customer — an unknown id simply means walk-in.
-- ----------------------------------------------------------------------------
create or replace function public.resolve_offline_customer(p_shop_id uuid, p_customer jsonb, p_created_by uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := null;
  v_ref   uuid := null;
  v_phone text;
  v_name  text;
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

  -- 1. Same offline record, already uploaded (retry or a later sale referencing it).
  if v_ref is not null then
    select id into v_id from public.customers where shop_id = p_shop_id and client_ref = v_ref;
    if v_id is not null then return v_id; end if;
  end if;
  -- 2. Same phone → the same regular; adopt the client_ref so later lookups are direct.
  if v_phone is not null then
    select id into v_id from public.customers where shop_id = p_shop_id and phone = v_phone;
    if v_id is not null then
      if v_ref is not null then update public.customers set client_ref = coalesce(client_ref, v_ref) where id = v_id; end if;
      return v_id;
    end if;
  end if;
  -- 3. New.
  insert into public.customers (shop_id, name, phone, note, created_by, client_ref)
  values (p_shop_id, left(v_name, 120), v_phone, nullif(trim(coalesce(p_customer->>'note', '')), ''), p_created_by, v_ref)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.resolve_offline_customer(uuid, jsonb, uuid) from public;

-- ----------------------------------------------------------------------------
-- replay_offline_customer(): the outbox 'customer' entry. Idempotent.
-- Returns the customer's server id so the terminal can swap 'pending:' for it.
-- ----------------------------------------------------------------------------
create or replace function public.replay_offline_customer(
  p_shop_id uuid, p_client_ref uuid, p_created_by uuid, p_name text, p_phone text default null, p_note text default null
) returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not (public.has_permission(p_shop_id, 'sales.create') or public.has_permission(p_shop_id, 'customers.manage')) then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.shop_members where shop_id = p_shop_id and user_id = p_created_by) then
    raise exception 'creator is not a member of this shop' using errcode = 'insufficient_privilege';
  end if;
  if p_phone is not null and p_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phone must be 7-15 digits' using errcode = 'check_violation';
  end if;
  return public.resolve_offline_customer(p_shop_id,
    jsonb_build_object('client_ref', p_client_ref, 'name', p_name, 'phone', p_phone, 'note', p_note), p_created_by);
end $$;
revoke all on function public.replay_offline_customer(uuid, uuid, uuid, text, text, text) from public;
grant execute on function public.replay_offline_customer(uuid, uuid, uuid, text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- replay_offline_sale(): same body as 0022, customer resolution via the helper
-- (so a sale queued against a not-yet-uploaded customer finds it by client_ref).
-- ----------------------------------------------------------------------------
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

  -- Resolve the customer, if any (0026 helper). Never fail the sale over a customer.
  v_customer := public.resolve_offline_customer(p_shop_id, p_customer, p_sold_by);

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
