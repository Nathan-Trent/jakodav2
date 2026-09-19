-- ============================================================================
-- 0021_site_content.sql — Marketing slice (2026-09-20). RUN MANUALLY after 0020.
--
--   site_content        every sentence on business.getzogal.com, keyed by
--                       page + key. LIVE — the site reads it with the anon key.
--   site_content_draft  what Marketing is editing. publish_site(page) copies
--                       draft → live for one page and bumps a version.
--   contact_messages    the site's contact form → the back office inbox.
--                       Anyone may submit (through a function that checks
--                       shape and rate); staff with marketing.inbox read and
--                       answer.
-- The site ships its own copy of every field as a fallback, so an empty or
-- unreachable table never blanks a page.
-- ============================================================================

create table public.site_content (
  page       text not null check (page ~ '^[a-z][a-z0-9_]{0,39}$'),
  key        text not null check (key ~ '^[a-z][a-z0-9_.]{0,79}$'),
  value      jsonb not null,                 -- string, string[] or {..}[] — the editor knows which from the schema
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now(),
  primary key (page, key)
);
create table public.site_content_draft (like public.site_content including all);
create table public.site_publish (
  id           bigserial primary key,
  page         text not null,
  version      int not null,
  published_by uuid references public.users(id),
  published_at timestamptz not null default now(),
  note         text
);
alter table public.site_content enable row level security;
alter table public.site_content_draft enable row level security;
alter table public.site_publish enable row level security;
-- Live copy is public (it is the website).
grant select on public.site_content to anon, authenticated;
create policy site_content_public_read on public.site_content for select using (true);
-- Draft and history: Marketing staff only.
grant select on public.site_content_draft, public.site_publish to authenticated;
create policy site_draft_staff_read on public.site_content_draft for select using (public.has_capability('marketing.view'));
create policy site_publish_staff_read on public.site_publish for select using (public.has_capability('marketing.view'));

create or replace function public.publish_site(p_page text, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_version int;
begin
  insert into public.site_content (page, key, value, updated_by, updated_at)
  select page, key, value, updated_by, now() from public.site_content_draft where page = p_page
  on conflict (page, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  delete from public.site_content where page = p_page and key not in (select key from public.site_content_draft where page = p_page);
  select coalesce(max(version), 0) + 1 into v_version from public.site_publish where page = p_page;
  insert into public.site_publish (page, version, note) values (p_page, v_version, p_note);
  return v_version;
end $$;
revoke all on function public.publish_site(text, text) from public, anon, authenticated;

-- Contact form → inbox
create table public.contact_messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  phone       text,
  message     text not null,
  source      text not null default 'site',      -- which page
  product     text,                              -- 'doka' when sent from the Doka page
  status      text not null default 'new' check (status in ('new', 'answered', 'archived')),
  reply       text,
  answered_by uuid references public.users(id),
  answered_at timestamptz,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index contact_messages_status_idx on public.contact_messages (status, created_at desc);
alter table public.contact_messages enable row level security;
grant select on public.contact_messages to authenticated;
create policy contact_staff_read on public.contact_messages for select using (public.has_capability('marketing.inbox'));

-- The only door in: shape-checked, 5 per IP per hour.
create or replace function public.submit_contact(p_name text, p_email text, p_phone text, p_message text, p_source text, p_product text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_ip inet; v_id uuid;
begin
  if length(trim(p_name)) < 2 or length(trim(p_name)) > 80 then raise exception 'name'; end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_email) > 200 then raise exception 'email'; end if;
  if length(trim(p_message)) < 10 or length(p_message) > 4000 then raise exception 'message'; end if;
  begin v_ip := split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)::inet; exception when others then v_ip := null; end;
  if v_ip is not null and (select count(*) from public.contact_messages where ip = v_ip and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too many messages — try again in an hour';
  end if;
  insert into public.contact_messages (name, email, phone, message, source, product, ip)
  values (trim(p_name), lower(trim(p_email)), nullif(trim(coalesce(p_phone, '')), ''), trim(p_message), coalesce(p_source, 'site'), p_product, v_ip)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.submit_contact(text, text, text, text, text, text) from public;
grant execute on function public.submit_contact(text, text, text, text, text, text) to anon, authenticated;

alter publication supabase_realtime add table public.site_content, public.site_content_draft, public.site_publish, public.contact_messages;
