-- ============================================================================
-- 0012_customers.sql — optional customer on a sale (Nathan, 2026-09-12)
--
-- RUN MANUALLY after 0011.
--
-- A sale is anonymous ("walk-in") unless the cashier attaches a customer.
-- Customers are a plain per-shop list: name, optional phone, note. Nothing
-- here changes stock, prices or money. No credit, no customer prices — those
-- are separate decisions (see BUILD_LOG).
--
-- Permissions: anyone who can sell may attach or add a customer at the till
-- (the till must never be blocked). Editing / deactivating needs the new
-- `customers.manage` (owner + manager by default).
-- ============================================================================

-- 1. Permission -------------------------------------------------------------
insert into public.permissions (key, description, sort_order) values
  ('customers.manage', 'Edit or deactivate customers', 13)
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_key) values
  ('00000000-0000-0000-0000-000000000001', 'customers.manage'),
  ('00000000-0000-0000-0000-000000000002', 'customers.manage')
on conflict do nothing;

-- 2. Table ------------------------------------------------------------------
create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  phone       text check (phone is null or phone ~ '^\+?[0-9]{7,15}$'),
  note        text,
  is_active   boolean not null default true,
  created_by  uuid references public.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index customers_shop_name_idx on public.customers (shop_id, lower(name));
-- One customer per phone per shop; phone is how a cashier finds a regular.
create unique index customers_shop_phone_uq on public.customers (shop_id, phone) where phone is not null;
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

alter table public.customers enable row level security;
create policy customers_read on public.customers for select
  using (shop_id in (select public.current_shop_ids()));
create policy customers_insert on public.customers for insert
  with check ((public.has_permission(shop_id, 'sales.create') or public.has_permission(shop_id, 'customers.manage'))
              and created_by = public.current_app_user_id());
create policy customers_update on public.customers for update
  using (public.has_permission(shop_id, 'customers.manage'))
  with check (public.has_permission(shop_id, 'customers.manage'));

-- 3. Sale → customer (nullable = walk-in) -------------------------------------
alter table public.sales add column customer_id uuid references public.customers(id);
create index sales_customer_idx on public.sales (customer_id, sold_at desc) where customer_id is not null;

-- 4. record_sale: optional p_customer_id ------------------------------------
-- Old signature dropped so PostgREST sees one overload.
drop function if exists public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid);

create or replace function public.record_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz default now(), p_note text default null,
  p_device_id uuid default null, p_customer_id uuid default null
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
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a sale needs at least one line' using errcode = 'check_violation';
  end if;

  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id, customer_id)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id, p_customer_id)
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
revoke all on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid) from public;
grant execute on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text, uuid, uuid) to authenticated;

-- 5. replay_offline_sale: optional p_customer ---------------------------------
-- SYNC: a sale made offline may reference a customer that already exists
-- ({"id": ...}) or one the cashier created offline ({"name": ..., "phone": ...}).
-- The latter is matched by phone in this shop first, so two terminals adding
-- the same regular offline end up with one record, not two.
drop function if exists public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text);

create or replace function public.replay_offline_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz, p_device_id uuid, p_note text default null,
  p_customer jsonb default null
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

  perform set_config('app.offline_replay', '1', true);
  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id, customer_id)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id, v_customer)
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
revoke all on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb) from public;
grant execute on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text, jsonb) to authenticated;
