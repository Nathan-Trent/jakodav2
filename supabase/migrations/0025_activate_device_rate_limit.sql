-- ============================================================================
-- 0025_activate_device_rate_limit.sql — rate-limit activate_device()
-- (Nathan, 2026-09-20). RUN MANUALLY after 0024.
--
-- activate_device() is anon-callable by design (a new till has no session
-- yet) with an 8-character code from a 32-letter alphabet — a real keyspace
-- (2^40), but nothing stopped a script hammering it from one source with no
-- authentication at all, a pure availability/hygiene gap noted since Stage 2
-- and never closed. Same shape as the rate limit authorize_override() (PIN
-- overrides, 0002) and submit_contact() (0021) already use: count recent
-- attempts from the caller's IP, refuse before checking the code, log the
-- outcome either way. Nothing changes for a real cashier typing a real code.
-- ============================================================================

create table public.device_activation_attempts (
  id         bigserial primary key,
  ip         inet,
  succeeded  boolean not null,
  created_at timestamptz not null default now()
);
create index device_activation_attempts_ip_idx on public.device_activation_attempts (ip, created_at desc);
alter table public.device_activation_attempts enable row level security;
revoke all on public.device_activation_attempts from anon, authenticated;

create or replace function public.activate_device(p_code text, p_device_name text)
returns table (device_id uuid, shop_id uuid, credential text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code   public.device_activation_codes;
  v_cred   text;
  v_device public.devices;
  v_ip     inet;
begin
  begin v_ip := split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)::inet; exception when others then v_ip := null; end;

  if v_ip is not null and (select count(*) from public.device_activation_attempts
      where ip = v_ip and not succeeded and created_at > now() - interval '15 minutes') >= 10 then
    raise exception 'too many attempts; wait 15 minutes and try again' using errcode = 'too_many_connections';
  end if;

  select * into v_code from public.device_activation_codes
    where code_hash = sha256(convert_to(upper(trim(p_code)), 'UTF8'))
      and used_at is null and expires_at > now()
    for update;
  if not found then
    insert into public.device_activation_attempts (ip, succeeded) values (v_ip, false);
    raise exception 'invalid or expired activation code' using errcode = 'invalid_password';
  end if;

  v_cred := encode(gen_random_bytes(32), 'hex');

  insert into public.devices (shop_id, name, credential_hash, activated_by)
  values (v_code.shop_id, p_device_name, sha256(convert_to(v_cred, 'UTF8')), v_code.created_by)
  returning * into v_device;

  update public.device_activation_codes
    set used_at = now(), device_id = v_device.id where id = v_code.id;

  insert into public.device_activation_attempts (ip, succeeded) values (v_ip, true);
  return query select v_device.id, v_device.shop_id, v_cred;
end $$;
revoke all on function public.activate_device(text, text) from public;
grant execute on function public.activate_device(text, text) to anon, authenticated;
