-- ============================================================================
-- 0001_foundation.sql — Stage 1: multi-tenant schema + core tables + FIFO
--
-- RUN MANUALLY in the Supabase SQL editor. Claude Code never runs this.
--
-- Portability rule (TRD §2): plain SQL only. The only Supabase-specific
-- construct is auth.uid() inside the thin RLS helper at the bottom — swap
-- that one function if Supabase Auth is ever replaced.
--
-- Money is stored as numeric(14,2) NGN (exact, no float drift).
-- Every tenant table carries shop_id and is RLS-scoped to it.
-- ============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- 0. Utilities
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Generic guard for append-only tables (price_changes, corrections, etc.).
create or replace function public.reject_write()
returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end $$;

-- ----------------------------------------------------------------------------
-- 1. Tenant root
-- ----------------------------------------------------------------------------

create table public.shops (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 120),
  timezone     text not null default 'Africa/Lagos',
  currency     char(3) not null default 'NGN',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger shops_updated_at before update on public.shops
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Identity — own tables; Supabase Auth is the login mechanism ONLY
-- ----------------------------------------------------------------------------

-- Deliberately NO foreign key to auth.users: keeps the schema portable.
-- auth_user_id is the bridge; if the auth provider changes, only this column's
-- meaning changes.
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,
  email         text unique,
  full_name     text not null check (length(trim(full_name)) between 1 and 120),
  phone         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- Fixed, system-defined permission list (TRD §5). Custom roles are built by
-- selecting from this list — never free-form. Extend by INSERT, not by code.
create table public.permissions (
  key          text primary key check (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  description  text not null,
  sort_order   int  not null default 0
);

insert into public.permissions (key, description, sort_order) values
  ('sales.create',            'Record a sale at point of sale',                       10),
  ('sales.void',              'Void a sale (manager approval)',                       11),
  ('sales.view_all',          'View sales made by everyone, not just own',            12),
  ('items.create',            'Add new items',                                        20),
  ('items.edit',              'Edit item name / suggested price',                     21),
  ('items.edit_floor_price',  'Change an item''s floor price',                        22),
  ('items.view_cost',         'See batch cost prices',                                23),
  ('items.view_margin',       'See profit / margin figures',                          24),
  ('purchases.create',        'Record a purchase / restock (creates a batch)',        30),
  ('purchases.correct_cost',  'Correct a mistyped batch cost (logged override)',      31),
  ('expenses.create',         'Log an expense',                                       40),
  ('expenses.view',           'View expenses',                                        41),
  ('reports.view',            'View reports (sales, profit, stock)',                  50),
  ('reports.view_staff_perf', 'View per-salesperson performance',                     51),
  ('tax.view',                'View tax status and computed figures',                 60),
  ('tax.mark_filed',          'Mark a tax period as filed (locks it)',                61),
  ('users.manage',            'Invite / remove staff, assign roles & permissions',    70),
  ('roles.manage',            'Create and edit custom roles',                         71),
  ('shop.settings',           'Edit shop settings',                                   72),
  ('overrides.approve',       'Approve manager-PIN overrides (cart removal etc.)',    80);

-- System roles have shop_id NULL and are shared by every tenant.
-- Custom roles belong to one shop.
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid references public.shops(id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        text not null,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- system roles: shop_id must be null; custom roles: must have a shop
  check ((is_system and shop_id is null) or (not is_system and shop_id is not null))
);
-- key unique per shop; NULLs are distinct in unique indexes, so system keys
-- need their own partial index
create unique index roles_shop_key_uidx on public.roles (shop_id, key) where shop_id is not null;
create unique index roles_system_key_uidx on public.roles (key) where shop_id is null;
create trigger roles_updated_at before update on public.roles
  for each row execute function public.set_updated_at();

create table public.role_permissions (
  role_id         uuid not null references public.roles(id) on delete cascade,
  permission_key  text not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

-- Default roles (TRD §5). Owner = everything; Manager = everything operational
-- minus tenancy admin; Salesperson = sell + see floor/suggested only.
insert into public.roles (id, key, name, is_system) values
  ('00000000-0000-0000-0000-000000000001', 'owner',       'Owner / Admin', true),
  ('00000000-0000-0000-0000-000000000002', 'manager',     'Manager',       true),
  ('00000000-0000-0000-0000-000000000003', 'salesperson', 'Salesperson',   true);

insert into public.role_permissions (role_id, permission_key)
  select '00000000-0000-0000-0000-000000000001', key from public.permissions;

insert into public.role_permissions (role_id, permission_key)
  select '00000000-0000-0000-0000-000000000002', key from public.permissions
  where key not in ('users.manage', 'roles.manage', 'shop.settings', 'tax.mark_filed');

insert into public.role_permissions (role_id, permission_key) values
  ('00000000-0000-0000-0000-000000000003', 'sales.create');

-- Membership: a user belongs to a shop with one role. A user may belong to
-- several shops (the owner of two shops, or your support staff).
create table public.shop_members (
  shop_id     uuid not null references public.shops(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  role_id     uuid not null references public.roles(id) on delete restrict,
  is_active   boolean not null default true,
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index shop_members_user_idx on public.shop_members (user_id);
create trigger shop_members_updated_at before update on public.shop_members
  for each row execute function public.set_updated_at();

-- Per-person tweaks on top of the role (PRD §4: "admin decides exactly what
-- each person can see"). allowed=true grants, allowed=false revokes.
create table public.member_permission_overrides (
  shop_id         uuid not null,
  user_id         uuid not null,
  permission_key  text not null references public.permissions(key) on delete cascade,
  allowed         boolean not null,
  set_by          uuid references public.users(id),
  created_at      timestamptz not null default now(),
  primary key (shop_id, user_id, permission_key),
  foreign key (shop_id, user_id) references public.shop_members(shop_id, user_id) on delete cascade
);

-- Effective permission set for a member = role permissions ± overrides.
-- Single source of truth used by RLS helpers and application code.
create or replace function public.member_permissions(p_shop_id uuid, p_user_id uuid)
returns setof text language sql stable as $$
  select rp.permission_key
  from public.shop_members m
  join public.role_permissions rp on rp.role_id = m.role_id
  where m.shop_id = p_shop_id and m.user_id = p_user_id and m.is_active
    and not exists (
      select 1 from public.member_permission_overrides o
      where o.shop_id = m.shop_id and o.user_id = m.user_id
        and o.permission_key = rp.permission_key and o.allowed = false)
  union
  select o.permission_key
  from public.member_permission_overrides o
  join public.shop_members m on m.shop_id = o.shop_id and m.user_id = o.user_id and m.is_active
  where o.shop_id = p_shop_id and o.user_id = p_user_id and o.allowed = true;
$$;

-- ----------------------------------------------------------------------------
-- 3. Catalogue
-- ----------------------------------------------------------------------------

create table public.items (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 200),
  floor_price      numeric(14,2) not null check (floor_price >= 0),
  suggested_price  numeric(14,2) not null check (suggested_price >= floor_price),
  is_active        boolean not null default true,
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index items_shop_idx on public.items (shop_id) where is_active;
create trigger items_updated_at before update on public.items
  for each row execute function public.set_updated_at();

-- Barcodes are unique PER SHOP only (PRD §5.3). The unique index is on
-- (shop_id, code), so the same code can exist in two shops. RLS guarantees a
-- Store B scan of a Store A code simply finds nothing.
create table public.barcodes (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  item_id     uuid not null references public.items(id) on delete cascade,
  code        text not null check (length(code) between 4 and 64),
  source      text not null check (source in ('manufacturer', 'generated')),
  created_at  timestamptz not null default now(),
  unique (shop_id, code)
);
create index barcodes_item_idx on public.barcodes (item_id);

-- Append-only selling-price history (TRD §4). Every floor/suggested change is
-- logged here by application code in the same transaction as the item update.
create table public.price_changes (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  item_id     uuid not null references public.items(id) on delete cascade,
  field       text not null check (field in ('floor_price', 'suggested_price')),
  old_value   numeric(14,2),
  new_value   numeric(14,2) not null,
  reason      text,
  changed_by  uuid references public.users(id),
  created_at  timestamptz not null default now()
);
create index price_changes_item_idx on public.price_changes (item_id, created_at desc);
create trigger price_changes_append_only before update or delete on public.price_changes
  for each row execute function public.reject_write();

-- ----------------------------------------------------------------------------
-- 4. Purchases & batches (immutable cost layer)
-- ----------------------------------------------------------------------------

create table public.purchases (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  supplier_name  text,
  note           text,
  purchased_at   timestamptz not null default now(),
  created_by     uuid references public.users(id),
  created_at     timestamptz not null default now()
);
create index purchases_shop_idx on public.purchases (shop_id, purchased_at desc);

-- One batch per (purchase, item, cost). Frozen forever except:
--   * quantity_remaining — decremented by FIFO consumption
--   * unit_cost          — only via correct_batch_cost() (logged override)
create table public.batches (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  item_id             uuid not null references public.items(id) on delete restrict,
  purchase_id         uuid references public.purchases(id) on delete restrict,
  quantity_received   int not null check (quantity_received > 0),
  quantity_remaining  int not null check (quantity_remaining >= 0),
  unit_cost           numeric(14,2) not null check (unit_cost >= 0),
  purchased_at        timestamptz not null default now(),
  created_by          uuid references public.users(id),
  created_at          timestamptz not null default now(),
  check (quantity_remaining <= quantity_received)
);
-- The FIFO scan: oldest open batch for an item. Partial index keeps it tiny.
create index batches_fifo_idx on public.batches (item_id, purchased_at, id)
  where quantity_remaining > 0;
create index batches_shop_idx on public.batches (shop_id);

create or replace function public.enforce_batch_immutability()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'batches are immutable; cannot delete batch %', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.shop_id <> old.shop_id or new.item_id <> old.item_id
     or new.purchase_id is distinct from old.purchase_id
     or new.quantity_received <> old.quantity_received
     or new.purchased_at <> old.purchased_at
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'batch % is immutable (only quantity_remaining may change)', old.id
      using errcode = 'restrict_violation';
  end if;
  -- unit_cost may only change inside correct_batch_cost(), which sets this
  -- transaction-local flag to the batch id being corrected.
  if new.unit_cost <> old.unit_cost
     and current_setting('app.batch_cost_correction', true) is distinct from old.id::text then
    raise exception 'batch cost is frozen; use correct_batch_cost() to log a correction'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger batches_immutable before update or delete on public.batches
  for each row execute function public.enforce_batch_immutability();

-- Admin override for a mistyped batch cost (TRD §4). Original stays here.
create table public.purchase_cost_corrections (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  batch_id       uuid not null references public.batches(id) on delete restrict,
  old_unit_cost  numeric(14,2) not null,
  new_unit_cost  numeric(14,2) not null check (new_unit_cost >= 0),
  reason         text not null check (length(trim(reason)) >= 5),
  corrected_by   uuid references public.users(id),
  created_at     timestamptz not null default now()
);
create index cost_corrections_batch_idx on public.purchase_cost_corrections (batch_id);
create trigger cost_corrections_append_only before update or delete on public.purchase_cost_corrections
  for each row execute function public.reject_write();

-- The ONLY path that changes a batch's unit_cost. Correction row first, then
-- the batch, both in one transaction. Already-sold units keep the cost that
-- was snapshotted on their allocation rows — history is never rewritten.
-- (Permission check lives inside because SECURITY DEFINER bypasses RLS;
-- has_permission() is defined in §6 — plpgsql resolves it at call time.)
create or replace function public.correct_batch_cost(
  p_batch_id uuid, p_new_unit_cost numeric, p_reason text, p_corrected_by uuid
) returns public.purchase_cost_corrections
language plpgsql security definer set search_path = public as $$
declare
  v_batch public.batches;
  v_row   public.purchase_cost_corrections;
begin
  select * into v_batch from public.batches where id = p_batch_id for update;
  if not found then
    raise exception 'batch % not found', p_batch_id using errcode = 'no_data_found';
  end if;
  if not public.has_permission(v_batch.shop_id, 'purchases.correct_cost') then
    raise exception 'permission denied: purchases.correct_cost' using errcode = 'insufficient_privilege';
  end if;
  if p_corrected_by is distinct from public.current_app_user_id() then
    raise exception 'corrected_by must be the calling user' using errcode = 'insufficient_privilege';
  end if;
  if v_batch.unit_cost = p_new_unit_cost then
    raise exception 'new cost equals current cost' using errcode = 'check_violation';
  end if;

  insert into public.purchase_cost_corrections
    (shop_id, batch_id, old_unit_cost, new_unit_cost, reason, corrected_by)
  values (v_batch.shop_id, p_batch_id, v_batch.unit_cost, p_new_unit_cost, p_reason, p_corrected_by)
  returning * into v_row;

  perform set_config('app.batch_cost_correction', p_batch_id::text, true);
  update public.batches set unit_cost = p_new_unit_cost where id = p_batch_id;
  perform set_config('app.batch_cost_correction', '', true);

  return v_row;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Sales + FIFO allocation
-- ----------------------------------------------------------------------------

create table public.sales (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  -- SYNC: client-generated id so an offline sale replayed twice on reconnect
  -- is idempotent (unique per shop). Stage 5 relies on this.
  client_ref  uuid not null,
  sold_by     uuid references public.users(id),
  sold_at     timestamptz not null default now(),
  status      text not null default 'completed' check (status in ('completed', 'voided')),
  total       numeric(14,2) not null default 0 check (total >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (shop_id, client_ref)
);
create index sales_shop_time_idx on public.sales (shop_id, sold_at desc);
create index sales_sold_by_idx on public.sales (sold_by, sold_at desc);
create trigger sales_updated_at before update on public.sales
  for each row execute function public.set_updated_at();

create table public.sale_lines (
  id                   uuid primary key default gen_random_uuid(),
  sale_id              uuid not null references public.sales(id) on delete cascade,
  shop_id              uuid not null references public.shops(id) on delete cascade,
  item_id              uuid not null references public.items(id) on delete restrict,
  quantity             int not null check (quantity > 0),
  unit_price           numeric(14,2) not null check (unit_price >= 0),
  -- Snapshot of the floor at the moment of sale, so a later floor change
  -- can't make an old sale look like a violation (or hide one).
  floor_price_at_sale  numeric(14,2) not null,
  created_at           timestamptz not null default now(),
  check (unit_price >= floor_price_at_sale)
);
create index sale_lines_sale_idx on public.sale_lines (sale_id);
create index sale_lines_item_idx on public.sale_lines (item_id);

-- Which batch units a sale line consumed, and at what cost. This is the COGS
-- ground truth: true profit = sum(unit_price*qty) - sum(unit_cost*qty).
-- One line may span several batches (TRD §4).
create table public.sale_line_allocations (
  id            uuid primary key default gen_random_uuid(),
  sale_line_id  uuid not null references public.sale_lines(id) on delete cascade,
  batch_id      uuid not null references public.batches(id) on delete restrict,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  quantity      int not null check (quantity > 0),
  unit_cost     numeric(14,2) not null,
  created_at    timestamptz not null default now()
);
create index sla_line_idx on public.sale_line_allocations (sale_line_id);
create index sla_batch_idx on public.sale_line_allocations (batch_id);
create trigger sla_append_only before update or delete on public.sale_line_allocations
  for each row execute function public.reject_write();

-- Core FIFO consumer (TRD §7). Locks the oldest open batches for the item in
-- order, decrements them, writes allocation rows. Row locks make two online
-- terminals selling the last unit at once serialise correctly — the second
-- one gets 'insufficient_stock' rather than a double-sell.
--
-- SYNC: the offline path (Stage 5) runs the same algorithm locally against
-- cached batches; on reconnect it replays through this function, and a
-- shortfall here is what gets surfaced to the owner as a conflict.
create or replace function public.consume_batches_fifo(
  p_sale_line_id uuid
) returns setof public.sale_line_allocations
language plpgsql security definer set search_path = public as $$
declare
  v_line     public.sale_lines;
  v_batch    record;
  v_needed   int;
  v_take     int;
begin
  select * into v_line from public.sale_lines where id = p_sale_line_id;
  if not found then
    raise exception 'sale line % not found', p_sale_line_id using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.sale_line_allocations where sale_line_id = p_sale_line_id) then
    raise exception 'sale line % already allocated', p_sale_line_id using errcode = 'unique_violation';
  end if;

  v_needed := v_line.quantity;

  for v_batch in
    select id, quantity_remaining, unit_cost
    from public.batches
    where item_id = v_line.item_id and shop_id = v_line.shop_id and quantity_remaining > 0
    order by purchased_at, id
    for update
  loop
    exit when v_needed = 0;
    v_take := least(v_batch.quantity_remaining, v_needed);

    update public.batches
      set quantity_remaining = quantity_remaining - v_take
      where id = v_batch.id;

    return query
      insert into public.sale_line_allocations (sale_line_id, batch_id, shop_id, quantity, unit_cost)
      values (p_sale_line_id, v_batch.id, v_line.shop_id, v_take, v_batch.unit_cost)
      returning *;

    v_needed := v_needed - v_take;
  end loop;

  if v_needed > 0 then
    -- Rolls back the whole transaction (batch decrements + partial allocations).
    raise exception 'insufficient_stock: item % short by % unit(s)', v_line.item_id, v_needed
      using errcode = 'check_violation';
  end if;
end $$;

-- Record a whole sale atomically. Lines as JSON:
--   [{"item_id": "...", "quantity": 2, "unit_price": 1500.00}, ...]
-- Enforces the floor price from the current item record and checks
-- sales.create inside (SECURITY DEFINER bypasses RLS).
create or replace function public.record_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz default now(), p_note text default null
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
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a sale needs at least one line' using errcode = 'check_violation';
  end if;

  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note)
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


-- Stock on hand and weighted cost of what's left, per item.
create or replace view public.item_stock as
  select i.shop_id, i.id as item_id, i.name,
         coalesce(sum(b.quantity_remaining), 0)::int as on_hand,
         coalesce(sum(b.quantity_remaining * b.unit_cost), 0)::numeric(14,2) as stock_value
  from public.items i
  left join public.batches b on b.item_id = i.id and b.quantity_remaining > 0
  group by i.shop_id, i.id, i.name;

-- ----------------------------------------------------------------------------
-- 6. Row-level security — thin, configuration only (TRD §2)
-- ----------------------------------------------------------------------------

-- The single Supabase-specific touchpoint. Replace auth.uid() if the login
-- provider changes; nothing else in this file needs to move.
create or replace function public.current_app_user_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.users where auth_user_id = auth.uid() and is_active;
$$;

create or replace function public.current_shop_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select shop_id from public.shop_members
  where user_id = public.current_app_user_id() and is_active;
$$;

create or replace function public.has_permission(p_shop_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.member_permissions(p_shop_id, public.current_app_user_id()) p
    where p = p_permission);
$$;

-- Tenant tables: members can read their own shops' rows. Writes go through
-- the SECURITY DEFINER functions above (record_sale, correct_batch_cost) or
-- through permission-checked policies below.
do $$
declare t text;
begin
  foreach t in array array[
    'shops','items','barcodes','price_changes','purchases','batches',
    'purchase_cost_corrections','sales','sale_lines','sale_line_allocations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

alter table public.users enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.shop_members enable row level security;
alter table public.member_permission_overrides enable row level security;
alter table public.permissions enable row level security;

-- reads
create policy shops_read on public.shops for select
  using (id in (select public.current_shop_ids()));
create policy users_read_self on public.users for select
  using (id = public.current_app_user_id()
      or id in (select user_id from public.shop_members where shop_id in (select public.current_shop_ids())));
create policy permissions_read on public.permissions for select using (true);
create policy roles_read on public.roles for select
  using (shop_id is null or shop_id in (select public.current_shop_ids()));
create policy role_permissions_read on public.role_permissions for select
  using (role_id in (select id from public.roles where shop_id is null or shop_id in (select public.current_shop_ids())));
create policy shop_members_read on public.shop_members for select
  using (shop_id in (select public.current_shop_ids()));
create policy overrides_read on public.member_permission_overrides for select
  using (shop_id in (select public.current_shop_ids()));

create policy items_read on public.items for select
  using (shop_id in (select public.current_shop_ids()));
create policy barcodes_read on public.barcodes for select
  using (shop_id in (select public.current_shop_ids()));
create policy price_changes_read on public.price_changes for select
  using (shop_id in (select public.current_shop_ids()));
create policy purchases_read on public.purchases for select
  using (shop_id in (select public.current_shop_ids()));
create policy sales_read on public.sales for select
  using (shop_id in (select public.current_shop_ids())
         and (public.has_permission(shop_id, 'sales.view_all') or sold_by = public.current_app_user_id()));
create policy sale_lines_read on public.sale_lines for select
  using (shop_id in (select public.current_shop_ids()));
-- Cost data is gated: salespeople never see batch costs by default (PRD §4).
create policy batches_read on public.batches for select
  using (public.has_permission(shop_id, 'items.view_cost'));
create policy corrections_read on public.purchase_cost_corrections for select
  using (public.has_permission(shop_id, 'items.view_cost'));
create policy allocations_read on public.sale_line_allocations for select
  using (public.has_permission(shop_id, 'items.view_cost'));

-- writes (permission-gated; append-only tables get insert only)
create policy items_insert on public.items for insert
  with check (public.has_permission(shop_id, 'items.create'));
create policy items_update on public.items for update
  using (public.has_permission(shop_id, 'items.edit'))
  with check (public.has_permission(shop_id, 'items.edit'));
create policy barcodes_insert on public.barcodes for insert
  with check (public.has_permission(shop_id, 'items.create'));
create policy price_changes_insert on public.price_changes for insert
  with check (public.has_permission(shop_id, 'items.edit'));
create policy purchases_insert on public.purchases for insert
  with check (public.has_permission(shop_id, 'purchases.create'));
create policy batches_insert on public.batches for insert
  with check (public.has_permission(shop_id, 'purchases.create'));
create policy shop_members_manage on public.shop_members for all
  using (public.has_permission(shop_id, 'users.manage'))
  with check (public.has_permission(shop_id, 'users.manage'));
create policy overrides_manage on public.member_permission_overrides for all
  using (public.has_permission(shop_id, 'users.manage'))
  with check (public.has_permission(shop_id, 'users.manage'));
create policy roles_manage on public.roles for all
  using (shop_id is not null and public.has_permission(shop_id, 'roles.manage'))
  with check (shop_id is not null and not is_system and public.has_permission(shop_id, 'roles.manage'));
create policy role_permissions_manage on public.role_permissions for all
  using (role_id in (select id from public.roles r where r.shop_id is not null and public.has_permission(r.shop_id, 'roles.manage')))
  with check (role_id in (select id from public.roles r where r.shop_id is not null and public.has_permission(r.shop_id, 'roles.manage')));
create policy shops_update on public.shops for update
  using (public.has_permission(id, 'shop.settings'))
  with check (public.has_permission(id, 'shop.settings'));

-- Sales are written only via record_sale() (SECURITY DEFINER), so no direct
-- insert policy on sales / sale_lines / sale_line_allocations. Lock down the
-- function to callers who hold sales.create in that shop.
revoke all on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text) from public;
revoke all on function public.consume_batches_fifo(uuid) from public;
revoke all on function public.correct_batch_cost(uuid, numeric, text, uuid) from public;
grant execute on function public.record_sale(uuid, uuid, uuid, jsonb, timestamptz, text) to authenticated;
grant execute on function public.correct_batch_cost(uuid, numeric, text, uuid) to authenticated;
-- consume_batches_fifo is internal — only record_sale calls it (owner-executed).

