-- ============================================================================
-- 0008_sync_subscriptions.sql — Stage 5: offline-first & sync
--
-- RUN MANUALLY after 0007.
--
-- SYNC: this is the highest-risk area in the product (TRD §10). Every object
-- here exists to make offline behaviour auditable rather than clever.
--
-- New tables:
--   * operational_settings  — TRD §4/§5.1, singleton + change history
--   * subscriptions         — per shop; what the offline gating enforces
--   * sync_conflicts        — TRD §7 "surfaced, never silently resolved"
--   * clock_anomalies       — TRD §7 "logged/flagged as a signal"
--
-- NOTE for Nathan: `subscriptions` and `sync_conflicts` are NOT in the TRD §4
-- entity list. They are required by §7 (offline subscription enforcement, and
-- conflicts surfaced on sync) and are flagged here rather than added quietly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Operational settings (TRD §5.1) — internal team tunes behaviour, no deploy
-- ----------------------------------------------------------------------------
-- Singleton by design: these are YOUR operational parameters, not a shop
-- owner's. Typed as jsonb so the §5.1 page can grow without a migration.
create table public.operational_settings (
  id          int primary key default 1 check (id = 1),
  settings    jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id)
);

insert into public.operational_settings (id, settings) values (1, jsonb_build_object(
  'manager_pin_rotation_days',   7,     -- §5.1 default: weekly
  'subscription_grace_days',     5,     -- §7: normal use past expiry
  'read_only_window_days',       7,     -- §7: read-only before fully locked
  'mandatory_sync_days',         5,     -- §7: must reconnect at least this often
  'sync_warning_days',           3,     -- start escalating warnings here
  'notebook_free_scans_monthly', 5,     -- §5.1, PRD §5.6
  'clock_skew_tolerance_hours',  6      -- divergence beyond this is flagged
));

-- Nothing overwritten silently — same principle as everywhere else.
create table public.operational_settings_history (
  id          uuid primary key default gen_random_uuid(),
  old_value   jsonb not null,
  new_value   jsonb not null,
  changed_by  uuid references public.users(id),
  created_at  timestamptz not null default now()
);

create or replace function public.log_operational_settings_change()
returns trigger language plpgsql as $$
begin
  insert into public.operational_settings_history (old_value, new_value, changed_by)
  values (old.settings, new.settings, new.updated_by);
  new.updated_at := now();
  return new;
end $$;
create trigger operational_settings_history_trg before update on public.operational_settings
  for each row execute function public.log_operational_settings_change();

alter table public.operational_settings enable row level security;
alter table public.operational_settings_history enable row level security;
-- Operational center only (Stage 9). No tenant grants at all; the values reach
-- devices through device_heartbeat(), which is SECURITY DEFINER.
revoke all on public.operational_settings from anon, authenticated;
revoke all on public.operational_settings_history from anon, authenticated;

create or replace function public.op_setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select settings -> p_key from public.operational_settings where id = 1;
$$;

-- ----------------------------------------------------------------------------
-- 2. Subscriptions — what the offline gating enforces
-- ----------------------------------------------------------------------------
-- Stage 8 (web dashboard) will own billing and set real expiry dates. Until
-- then every shop gets an open-ended active row, so the machinery below is
-- real and testable without pretending a billing system exists.
create table public.subscriptions (
  shop_id     uuid primary key references public.shops(id) on delete cascade,
  status      text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  plan        text not null default 'standard',
  -- null = no expiry (pre-billing). A date = gating applies from that moment.
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

insert into public.subscriptions (shop_id)
  select id from public.shops on conflict (shop_id) do nothing;

-- Every new shop starts subscribed.
create or replace function public.create_subscription_for_shop()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (shop_id) values (new.id) on conflict (shop_id) do nothing;
  return new;
end $$;
create trigger shops_create_subscription after insert on public.shops
  for each row execute function public.create_subscription_for_shop();

alter table public.subscriptions enable row level security;
create policy subscriptions_read on public.subscriptions for select
  using (shop_id in (select public.current_shop_ids()));
-- Writes are Stage 8 / operational center only: no insert/update/delete policy.

-- ----------------------------------------------------------------------------
-- 3. Sync conflicts — surfaced to the owner, never auto-resolved (TRD §7)
-- ----------------------------------------------------------------------------
create table public.sync_conflicts (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  device_id     uuid references public.devices(id) on delete set null,
  kind          text not null check (kind in ('stock_shortfall', 'duplicate_sale', 'below_floor', 'other')),
  sale_id       uuid references public.sales(id) on delete set null,
  item_id       uuid references public.items(id) on delete set null,
  -- what the terminal believed vs what the server found
  detail        jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null,      -- when the offline action happened
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references public.users(id),
  resolution    text
);
create index sync_conflicts_open_idx on public.sync_conflicts (shop_id, detected_at desc) where resolved_at is null;

alter table public.sync_conflicts enable row level security;
create policy sync_conflicts_read on public.sync_conflicts for select
  using (shop_id in (select public.current_shop_ids()) and public.has_permission(shop_id, 'reports.view'));
create policy sync_conflicts_resolve on public.sync_conflicts for update
  using (public.has_permission(shop_id, 'reports.view'))
  with check (public.has_permission(shop_id, 'reports.view'));
revoke update on public.sync_conflicts from anon, authenticated;
grant update (resolved_at, resolved_by, resolution) on public.sync_conflicts to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Clock anomalies — TRD §7: divergence is a signal, never silently ignored
-- ----------------------------------------------------------------------------
create table public.clock_anomalies (
  id                 uuid primary key default gen_random_uuid(),
  device_id          uuid not null references public.devices(id) on delete cascade,
  shop_id            uuid not null references public.shops(id) on delete cascade,
  -- elapsed since last sync as the monotonic counter saw it, vs the system clock
  monotonic_seconds  bigint not null,
  wall_clock_seconds bigint not null,
  divergence_seconds bigint not null,
  reported_at        timestamptz not null default now()
);
create index clock_anomalies_device_idx on public.clock_anomalies (device_id, reported_at desc);
alter table public.clock_anomalies enable row level security;
create policy clock_anomalies_read on public.clock_anomalies for select
  using (public.has_permission(shop_id, 'shop.settings'));

-- ----------------------------------------------------------------------------
-- 5. FIFO with tolerated shortfall — for replaying offline sales
-- ----------------------------------------------------------------------------
-- The goods physically left the shop, so the sale is a fact and must be
-- recorded (PRD §5.4: physical stock is the source of truth). What can be
-- missing is a BATCH to attribute cost to. This consumes what exists and
-- returns the unattributed quantity, which the caller logs as a conflict.
create or replace function public.consume_batches_fifo_partial(p_sale_line_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_line   public.sale_lines;
  v_batch  record;
  v_needed int;
  v_take   int;
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
    update public.batches set quantity_remaining = quantity_remaining - v_take where id = v_batch.id;
    insert into public.sale_line_allocations (sale_line_id, batch_id, shop_id, quantity, unit_cost)
    values (p_sale_line_id, v_batch.id, v_line.shop_id, v_take, v_batch.unit_cost);
    v_needed := v_needed - v_take;
  end loop;

  return v_needed;  -- 0 = fully attributed; >0 = shortfall to surface
end $$;
revoke all on function public.consume_batches_fifo_partial(uuid) from public;

-- ----------------------------------------------------------------------------
-- 6. Offline replay — idempotent, shortfall-tolerant
-- ----------------------------------------------------------------------------
-- SYNC: called once per queued sale on reconnect. Idempotency comes from
-- sales.client_ref (unique per shop): a replay of an already-accepted sale
-- returns that sale instead of creating a second one, so a reconnect that
-- dies halfway is safe to repeat.
--
-- Differences from record_sale():
--   * keeps the original sold_at (the sale happened then, not now)
--   * tolerates a stock shortfall and logs a sync_conflict
--   * enforces the floor as it stood AT THE TIME via p_lines floor snapshot
create or replace function public.replay_offline_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz, p_device_id uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sale     public.sales;
  v_line     jsonb;
  v_item     public.items;
  v_qty      int;
  v_price    numeric(14,2);
  v_floor    numeric(14,2);
  v_line_id  uuid;
  v_total    numeric(14,2) := 0;
  v_short    int;
  v_conflicts int := 0;
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  if p_sold_by is distinct from public.current_app_user_id() then
    raise exception 'sold_by must be the calling user' using errcode = 'insufficient_privilege';
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

    -- Floor as the terminal knew it when the sale happened; a floor raised
    -- while the terminal was offline can't retroactively void a real sale.
    v_floor := coalesce((v_line->>'floor_price_at_sale')::numeric, v_item.floor_price);
    if v_price < v_floor then
      insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, item_id, detail, occurred_at)
      values (p_shop_id, p_device_id, 'below_floor', v_sale.id, v_item.id,
              jsonb_build_object('unit_price', v_price, 'floor_at_sale', v_floor), p_sold_at);
      v_conflicts := v_conflicts + 1;
      v_floor := v_price;  -- record the sale as it actually happened
    end if;

    insert into public.sale_lines (sale_id, shop_id, item_id, quantity, unit_price, floor_price_at_sale)
    values (v_sale.id, p_shop_id, v_item.id, v_qty, v_price, v_floor)
    returning id into v_line_id;

    v_short := public.consume_batches_fifo_partial(v_line_id);
    if v_short > 0 then
      -- The units left the shop but there is no batch to cost them against:
      -- two terminals sold the same stock offline, or stock was never entered.
      insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, item_id, detail, occurred_at)
      values (p_shop_id, p_device_id, 'stock_shortfall', v_sale.id, v_item.id,
              jsonb_build_object('quantity_sold', v_qty, 'unattributed', v_short,
                                 'item_name', v_item.name), p_sold_at);
      v_conflicts := v_conflicts + 1;
    end if;

    v_total := v_total + v_qty * v_price;
  end loop;

  update public.sales set total = v_total where id = v_sale.id;
  return jsonb_build_object('sale_id', v_sale.id, 'already_synced', false, 'conflicts', v_conflicts);
end $$;
revoke all on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text) from public;
grant execute on function public.replay_offline_sale(uuid, uuid, uuid, jsonb, timestamptz, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Heartbeat v2 — carries subscription + settings to the device
-- ----------------------------------------------------------------------------
-- SYNC: called on every successful sync. Stamps last_sync_at (the server's
-- own clock, never the device's) and returns everything the device needs to
-- police itself while offline. The signed token is minted by the
-- issue-subscription-token Edge Function, which calls this and signs the
-- result; `subscription_token` here is the last one issued, so a device that
-- can reach Postgres but not the function still gets its previous token back.
drop function if exists public.device_heartbeat(uuid, text);
create or replace function public.device_heartbeat(
  p_device_id uuid, p_credential text,
  p_monotonic_seconds bigint default null,
  p_wall_clock_seconds bigint default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_device   public.devices;
  v_sub      public.subscriptions;
  v_settings jsonb;
  v_div      bigint;
  v_tol      bigint;
begin
  update public.devices d
    set last_sync_at = now()
    where d.id = p_device_id
      and d.credential_hash = sha256(convert_to(p_credential, 'UTF8'))
      and d.revoked_at is null
    returning * into v_device;
  if not found then
    raise exception 'unknown or revoked device' using errcode = 'invalid_password';
  end if;

  select * into v_sub from public.subscriptions where shop_id = v_device.shop_id;
  select settings into v_settings from public.operational_settings where id = 1;

  -- TRD §7: a system clock that disagrees with the monotonic counter is a
  -- signal. Logged, never used to block on its own.
  if p_monotonic_seconds is not null and p_wall_clock_seconds is not null then
    v_tol := ((v_settings->>'clock_skew_tolerance_hours')::bigint) * 3600;
    v_div := abs(p_wall_clock_seconds - p_monotonic_seconds);
    if v_div > v_tol then
      insert into public.clock_anomalies (device_id, shop_id, monotonic_seconds, wall_clock_seconds, divergence_seconds)
      values (p_device_id, v_device.shop_id, p_monotonic_seconds, p_wall_clock_seconds, v_div);
    end if;
  end if;

  return jsonb_build_object(
    'device_id',   v_device.id,
    'shop_id',     v_device.shop_id,
    'server_time', now(),
    'subscription', jsonb_build_object(
      'status',     coalesce(v_sub.status, 'active'),
      'plan',       coalesce(v_sub.plan, 'standard'),
      'expires_at', v_sub.expires_at
    ),
    'policy', jsonb_build_object(
      'grace_days',           v_settings->'subscription_grace_days',
      'read_only_days',       v_settings->'read_only_window_days',
      'mandatory_sync_days',  v_settings->'mandatory_sync_days',
      'sync_warning_days',    v_settings->'sync_warning_days'
    ),
    'subscription_token', v_device.subscription_token
  );
end $$;
revoke all on function public.device_heartbeat(uuid, text, bigint, bigint) from public;
grant execute on function public.device_heartbeat(uuid, text, bigint, bigint) to anon, authenticated;

-- Used only by the signing Edge Function (service-role) to store the token
-- it just minted, so a later heartbeat can hand back the same one.
create or replace function public.store_subscription_token(p_device_id uuid, p_token text)
returns void language sql security definer set search_path = public as $$
  update public.devices set subscription_token = p_token where id = p_device_id;
$$;
revoke all on function public.store_subscription_token(uuid, text) from public, anon, authenticated;
