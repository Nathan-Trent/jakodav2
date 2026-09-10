-- ============================================================================
-- 0002_auth_roles.sql — Stage 2: Auth & roles end to end
--
-- RUN MANUALLY in the Supabase SQL editor, AFTER 0001. Claude Code never
-- runs this.
--
-- Adds: auth.users → public.users linking, shop creation, invitations,
-- last-owner guard, manager PINs (lazy weekly rotation) + override log,
-- devices + one-time activation codes, and get_my_context() for the client.
--
-- Supabase-specific touchpoints (portability, TRD §2): the trigger on
-- auth.users (§1) and auth.uid()/auth.jwt() inside current_app_user_id()
-- (already in 0001) and current_auth_email() (§1). Everything else is
-- plain SQL.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Auth linking — Supabase Auth is the login mechanism only
-- ----------------------------------------------------------------------------

-- Create the app-side user row the moment an auth user is created.
-- full_name comes from signup metadata ({ data: { full_name } }) or falls
-- back to the email local-part; the user can edit it later.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (auth_user_id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1), 'User')
  )
  on conflict (auth_user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Keep email in sync if it changes in Auth (email change confirmation flow).
create or replace function public.handle_auth_user_email_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.users set email = new.email where auth_user_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_auth_user_email_change();

-- Email of the caller as asserted by the auth provider (not user-editable).
create or replace function public.current_auth_email()
returns text language sql stable security definer set search_path = public as $$
  select lower(nullif(auth.jwt()->>'email', ''));
$$;

-- Users may edit their own profile row — name/phone only (email is owned by
-- the auth provider; is_active by shop admins later).
create policy users_update_self on public.users for update
  using (id = public.current_app_user_id())
  with check (id = public.current_app_user_id());
revoke update on public.users from anon, authenticated;
grant update (full_name, phone) on public.users to authenticated;

-- FIX from 0001: views run as their owner by default and therefore bypass
-- RLS. item_stock must run as the caller so tenant isolation and the
-- items.view_cost gate on batches hold. (PG15+.)
alter view public.item_stock set (security_invoker = true);

-- ----------------------------------------------------------------------------
-- 2. Shop creation + last-owner guard
-- ----------------------------------------------------------------------------

-- Any logged-in app user can open a shop and becomes its Owner. (Whether shop
-- creation later moves behind a subscription check is a Stage 8 decision.)
create or replace function public.create_shop(p_name text)
returns public.shops
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := public.current_app_user_id();
  v_shop public.shops;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  insert into public.shops (name) values (p_name) returning * into v_shop;
  insert into public.shop_members (shop_id, user_id, role_id)
  values (v_shop.id, v_user, '00000000-0000-0000-0000-000000000001');
  return v_shop;
end $$;
revoke all on function public.create_shop(text) from public;
grant execute on function public.create_shop(text) to authenticated;

-- A shop can never be left without an active Owner.
create or replace function public.enforce_last_owner()
returns trigger language plpgsql as $$
declare
  v_shop uuid := coalesce(old.shop_id, new.shop_id);
begin
  if not exists (
    select 1 from public.shop_members
    where shop_id = v_shop and is_active
      and role_id = '00000000-0000-0000-0000-000000000001'
      and not (tg_op = 'DELETE' and user_id = old.user_id)
      and not (tg_op = 'UPDATE' and user_id = old.user_id
               and (not new.is_active or new.role_id <> '00000000-0000-0000-0000-000000000001'))
  ) then
    raise exception 'a shop must keep at least one active Owner' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger shop_members_last_owner before update or delete on public.shop_members
  for each row execute function public.enforce_last_owner();

-- ----------------------------------------------------------------------------
-- 3. Invitations — how staff get into a shop without a server-side key
-- ----------------------------------------------------------------------------

create table public.shop_invitations (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  email        text not null check (email = lower(email) and email like '%@%'),
  role_id      uuid not null references public.roles(id) on delete restrict,
  invited_by   uuid references public.users(id),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid references public.users(id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index shop_invitations_open_uidx on public.shop_invitations (shop_id, email)
  where accepted_at is null and revoked_at is null;
create index shop_invitations_email_idx on public.shop_invitations (email)
  where accepted_at is null and revoked_at is null;

alter table public.shop_invitations enable row level security;
create policy invitations_read on public.shop_invitations for select
  using (public.has_permission(shop_id, 'users.manage'));
create policy invitations_insert on public.shop_invitations for insert
  with check (public.has_permission(shop_id, 'users.manage')
              and invited_by = public.current_app_user_id()
              -- role must be a system role or one of this shop's custom roles
              and role_id in (select id from public.roles r where r.shop_id is null or r.shop_id = shop_invitations.shop_id));
-- revoke = set revoked_at; any admin may revoke, not only the inviter
create policy invitations_update on public.shop_invitations for update
  using (public.has_permission(shop_id, 'users.manage'))
  with check (public.has_permission(shop_id, 'users.manage'));
revoke update on public.shop_invitations from anon, authenticated;
grant update (revoked_at) on public.shop_invitations to authenticated;

-- Called by the client right after login. Any open, unexpired invitation
-- addressed to the caller's verified auth email becomes a membership.
-- Returns the shops joined.
create or replace function public.accept_my_invitations()
returns setof public.shop_members
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid := public.current_app_user_id();
  v_email text := public.current_auth_email();
  v_inv   public.shop_invitations;
  v_member public.shop_members;
begin
  if v_user is null or v_email is null then return; end if;

  for v_inv in
    select * from public.shop_invitations
    where email = v_email and accepted_at is null and revoked_at is null and expires_at > now()
    for update skip locked
  loop
    insert into public.shop_members (shop_id, user_id, role_id)
    values (v_inv.shop_id, v_user, v_inv.role_id)
    on conflict (shop_id, user_id) do update
      set role_id = excluded.role_id, is_active = true
    returning * into v_member;

    update public.shop_invitations
      set accepted_at = now(), accepted_by = v_user where id = v_inv.id;

    return next v_member;
  end loop;
end $$;
revoke all on function public.accept_my_invitations() from public;
grant execute on function public.accept_my_invitations() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Custom roles — atomic create (role + permissions) from the fixed list
-- ----------------------------------------------------------------------------

create or replace function public.create_custom_role(
  p_shop_id uuid, p_key text, p_name text, p_permissions text[]
) returns public.roles
language plpgsql security definer set search_path = public as $$
declare
  v_role public.roles;
  v_bad  text;
begin
  if not public.has_permission(p_shop_id, 'roles.manage') then
    raise exception 'permission denied: roles.manage' using errcode = 'insufficient_privilege';
  end if;
  select p into v_bad from unnest(p_permissions) p
    where not exists (select 1 from public.permissions where key = p) limit 1;
  if v_bad is not null then
    raise exception 'unknown permission: %', v_bad using errcode = 'check_violation';
  end if;

  insert into public.roles (shop_id, key, name, is_system)
  values (p_shop_id, p_key, p_name, false) returning * into v_role;

  insert into public.role_permissions (role_id, permission_key)
  select v_role.id, p from unnest(p_permissions) p;

  return v_role;
end $$;
revoke all on function public.create_custom_role(uuid, text, text, text[]) from public;
grant execute on function public.create_custom_role(uuid, text, text, text[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Manager PINs — per-manager, rotates weekly, visible only to its owner
-- ----------------------------------------------------------------------------

-- SECURITY NOTE: `pin` is stored in clear so the manager can re-view it during
-- the week (TRD §5). Mitigations: NO table grants to anon/authenticated (only
-- the definer functions below can touch this table), weekly rotation, and the
-- PIN only authorises in-shop overrides — it is not a login credential.
-- Upgrade path: replace the column with a Vault/pgp-encrypted value; only
-- get_my_manager_pin() and authorize_override() would change.
create table public.manager_pins (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  pin         char(6) not null check (pin ~ '^[0-9]{6}$'),
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  check (expires_at > issued_at)
);
-- one live PIN per manager per shop; PIN unique among live PINs in a shop
create unique index manager_pins_live_uidx on public.manager_pins (shop_id, user_id) where revoked_at is null;
create unique index manager_pins_code_uidx on public.manager_pins (shop_id, pin) where revoked_at is null;

alter table public.manager_pins enable row level security;
revoke all on public.manager_pins from anon, authenticated;

-- Every override attempt (success or failure) against a shop.
create table public.manager_overrides (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  requested_by   uuid references public.users(id),
  manager_id     uuid references public.users(id),   -- null on failure
  pin_id         uuid references public.manager_pins(id),
  action         text not null check (length(action) between 1 and 60),
  reference_id   uuid,                                 -- e.g. the sale/cart id
  succeeded      boolean not null,
  created_at     timestamptz not null default now()
);
create index manager_overrides_shop_idx on public.manager_overrides (shop_id, created_at desc);
alter table public.manager_overrides enable row level security;
create policy overrides_read on public.manager_overrides for select
  using (public.has_permission(shop_id, 'sales.view_all'));
create trigger manager_overrides_append_only before update or delete on public.manager_overrides
  for each row execute function public.reject_write();

-- Returns the caller's current PIN for the shop, minting a new one if none is
-- live or the current one has expired (lazy rotation — no scheduler needed).
-- p_rotation is a default until §5.1 operational settings exist (Stage 9).
create or replace function public.get_my_manager_pin(
  p_shop_id uuid, p_rotation interval default interval '7 days'
) returns table (pin text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := public.current_app_user_id();
  v_row   public.manager_pins;
  v_pin   text;
  v_bytes bytea;
  v_try   int := 0;
begin
  if not public.has_permission(p_shop_id, 'overrides.approve') then
    raise exception 'permission denied: overrides.approve' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.manager_pins
    where shop_id = p_shop_id and user_id = v_user and revoked_at is null
    for update;

  if found and v_row.expires_at > now() then
    return query select v_row.pin::text, v_row.expires_at;
    return;
  end if;

  if found then
    update public.manager_pins set revoked_at = now() where id = v_row.id;
  end if;

  -- 6 random digits from a CSPRNG; retry on the (rare) in-shop collision.
  loop
    v_bytes := gen_random_bytes(3);
    v_pin := lpad((((get_byte(v_bytes, 0) << 16) | (get_byte(v_bytes, 1) << 8) | get_byte(v_bytes, 2))
                   % 1000000)::text, 6, '0');
    begin
      insert into public.manager_pins (shop_id, user_id, pin, expires_at)
      values (p_shop_id, v_user, v_pin, now() + p_rotation)
      returning * into v_row;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 10 then raise; end if;
    end;
  end loop;

  return query select v_row.pin::text, v_row.expires_at;
end $$;
revoke all on function public.get_my_manager_pin(uuid, interval) from public;
grant execute on function public.get_my_manager_pin(uuid, interval) to authenticated;

-- A salesperson enters a manager's PIN to authorise an action. Verifies the
-- PIN against live PINs of managers who currently hold overrides.approve in
-- that shop, logs the attempt either way, and returns the manager's user id.
-- Simple brute-force brake: >5 failures in the shop in 15 minutes → refuse.
create or replace function public.authorize_override(
  p_shop_id uuid, p_pin text, p_action text, p_reference_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid := public.current_app_user_id();
  v_pin_row public.manager_pins;
  v_manager uuid;
begin
  if v_user is null or p_shop_id not in (select public.current_shop_ids()) then
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;

  if (select count(*) from public.manager_overrides
      where shop_id = p_shop_id and not succeeded and created_at > now() - interval '15 minutes') > 5 then
    raise exception 'too many failed PIN attempts; try again later' using errcode = 'too_many_connections';
  end if;

  select mp.* into v_pin_row from public.manager_pins mp
    where mp.shop_id = p_shop_id and mp.pin = p_pin
      and mp.revoked_at is null and mp.expires_at > now()
      and mp.user_id <> v_user  -- can't approve your own action
      and exists (select 1 from public.member_permissions(p_shop_id, mp.user_id) p where p = 'overrides.approve');

  v_manager := v_pin_row.user_id;

  insert into public.manager_overrides (shop_id, requested_by, manager_id, pin_id, action, reference_id, succeeded)
  values (p_shop_id, v_user, v_manager, v_pin_row.id, p_action, p_reference_id, v_manager is not null);

  if v_manager is null then
    raise exception 'invalid PIN' using errcode = 'invalid_password';
  end if;
  return v_manager;
end $$;
revoke all on function public.authorize_override(uuid, text, text, uuid) from public;
grant execute on function public.authorize_override(uuid, text, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Devices + activation (TRD §1 flow, §4 `devices`)
-- ----------------------------------------------------------------------------

create table public.devices (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  name                text not null check (length(trim(name)) between 1 and 80),
  -- sha256 of the device credential; the plaintext lives only on the device
  credential_hash     bytea not null unique,
  activated_by        uuid references public.users(id),
  activated_at        timestamptz not null default now(),
  last_sync_at        timestamptz,
  -- SYNC / subscription: signed token last issued to this device (Stage 5)
  subscription_token  text,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index devices_shop_idx on public.devices (shop_id) where revoked_at is null;

alter table public.devices enable row level security;
create policy devices_read on public.devices for select
  using (shop_id in (select public.current_shop_ids()));
create policy devices_manage on public.devices for update
  using (public.has_permission(shop_id, 'shop.settings'))
  with check (public.has_permission(shop_id, 'shop.settings'));
-- Column privileges are additive, so drop the table-level grants and re-grant
-- only what the client needs: credential_hash never leaves the database, and
-- admins can only rename or revoke a device.
revoke all on public.devices from anon, authenticated;
grant select (id, shop_id, name, activated_by, activated_at, last_sync_at, revoked_at, created_at)
  on public.devices to authenticated;
grant update (name, revoked_at) on public.devices to authenticated;

-- Online = synced within the last 5 minutes (heartbeat cadence is Stage 5).
-- security_invoker so the devices_read policy applies to the view.
create or replace view public.device_status with (security_invoker = true) as
  select id, shop_id, name, last_sync_at, revoked_at,
         coalesce(revoked_at is null and last_sync_at > now() - interval '5 minutes', false) as is_online
  from public.devices;

-- One-time codes: 8 chars from an unambiguous alphabet (no 0/O/1/I), 10-min
-- TTL, single use. Stored hashed so a DB read can't redeem them.
create table public.device_activation_codes (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  code_hash   bytea not null unique,
  created_by  uuid references public.users(id),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz,
  device_id   uuid references public.devices(id),
  created_at  timestamptz not null default now()
);
alter table public.device_activation_codes enable row level security;
revoke all on public.device_activation_codes from anon, authenticated;

create or replace function public.create_device_activation_code(p_shop_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_bytes bytea := gen_random_bytes(8);
  v_row public.device_activation_codes;
  i int;
begin
  if not public.has_permission(p_shop_id, 'shop.settings') then
    raise exception 'permission denied: shop.settings' using errcode = 'insufficient_privilege';
  end if;
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.device_activation_codes (shop_id, code_hash, created_by)
  values (p_shop_id, sha256(convert_to(v_code, 'UTF8')), public.current_app_user_id())
  returning * into v_row;
  return query select v_code, v_row.expires_at;
end $$;
revoke all on function public.create_device_activation_code(uuid) from public;
grant execute on function public.create_device_activation_code(uuid) to authenticated;

-- Called by the desktop app on first run — BEFORE any user is logged in, so
-- it is callable by anon. Redeems the code, mints a device credential, and
-- returns it exactly once. The device persists the credential locally.
create or replace function public.activate_device(p_code text, p_device_name text)
returns table (device_id uuid, shop_id uuid, credential text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code   public.device_activation_codes;
  v_cred   text;
  v_device public.devices;
begin
  select * into v_code from public.device_activation_codes
    where code_hash = sha256(convert_to(upper(trim(p_code)), 'UTF8'))
      and used_at is null and expires_at > now()
    for update;
  if not found then
    raise exception 'invalid or expired activation code' using errcode = 'invalid_password';
  end if;

  v_cred := encode(gen_random_bytes(32), 'hex');

  insert into public.devices (shop_id, name, credential_hash, activated_by)
  values (v_code.shop_id, p_device_name, sha256(convert_to(v_cred, 'UTF8')), v_code.created_by)
  returning * into v_device;

  update public.device_activation_codes
    set used_at = now(), device_id = v_device.id where id = v_code.id;

  return query select v_device.id, v_device.shop_id, v_cred;
end $$;
revoke all on function public.activate_device(text, text) from public;
grant execute on function public.activate_device(text, text) to anon, authenticated;

-- SYNC: the desktop calls this on every successful sync. Proves possession of
-- the device credential, stamps last_sync_at, returns the device's shop and
-- (from Stage 5) the signed subscription token.
create or replace function public.device_heartbeat(p_device_id uuid, p_credential text)
returns table (shop_id uuid, subscription_token text, server_time timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_device public.devices;
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
  return query select v_device.shop_id, v_device.subscription_token, now();
end $$;
revoke all on function public.device_heartbeat(uuid, text) from public;
grant execute on function public.device_heartbeat(uuid, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Client bootstrap — everything the app needs after login in one call
-- ----------------------------------------------------------------------------

create or replace function public.get_my_context()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user', (select to_jsonb(u) - 'auth_user_id' from public.users u where u.id = public.current_app_user_id()),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'shop', to_jsonb(s),
        'role', jsonb_build_object('id', r.id, 'key', r.key, 'name', r.name, 'is_system', r.is_system),
        'permissions', (select coalesce(jsonb_agg(p), '[]'::jsonb) from public.member_permissions(m.shop_id, m.user_id) p)
      ) order by s.name)
      from public.shop_members m
      join public.shops s on s.id = m.shop_id
      join public.roles r on r.id = m.role_id
      where m.user_id = public.current_app_user_id() and m.is_active and s.is_active
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.get_my_context() from public;
grant execute on function public.get_my_context() to authenticated;
