-- ============================================================================
-- 0006_barcodes.sql — Stage 4: barcode system + price changes + realtime
--
-- RUN MANUALLY after 0005. No table changes; functions + one policy.
--
--   * generate_barcode(item_id)   — store-scoped EAN-13, uniqueness-checked
--   * set_item_prices(...)         — atomic floor/suggested update + log
--   * items price columns locked   — floor changes need items.edit_floor_price
--
-- SYNC note: multi-terminal stock refresh uses a Supabase broadcast channel
-- per shop (client-side, no RLS dependency, no schema) + polling fallback.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Barcode generation
-- ----------------------------------------------------------------------------
-- EAN-13 with a GS1 "in-store" prefix (20–29), so any off-the-shelf scanner
-- reads it as a normal retail barcode. Layout: 2 + 11 random digits + check
-- digit. Uniqueness is per shop (barcodes_shop_id_code_key); we loop on the
-- rare collision. Codes are NOT globally unique across tenants by design
-- (PRD §5.3) — RLS makes another shop's code simply "not recognised".
create or replace function public.ean13_check_digit(p_12 text)
returns text language sql immutable as $$
  select ((10 - (
    (select sum(case when (i % 2) = 1 then d else d * 3 end)
     from unnest(string_to_array(p_12, null)) with ordinality as t(ch, i),
          lateral (select ch::int as d) x)
  ) % 10) % 10)::text;
$$;

create or replace function public.generate_barcode(p_item_id uuid)
returns public.barcodes
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_item  public.items;
  v_body  text;
  v_code  text;
  v_row   public.barcodes;
  v_bytes bytea;
  v_try   int := 0;
begin
  select * into v_item from public.items where id = p_item_id;
  if not found then
    raise exception 'item not found' using errcode = 'no_data_found';
  end if;
  if not public.has_permission(v_item.shop_id, 'items.create') then
    raise exception 'permission denied: items.create' using errcode = 'insufficient_privilege';
  end if;

  loop
    -- "2" + 11 digits from 5 random bytes (40 bits > 10^11)
    v_bytes := gen_random_bytes(5);
    v_body := '2' || lpad(((get_byte(v_bytes, 0)::bigint << 32
                          | get_byte(v_bytes, 1)::bigint << 24
                          | get_byte(v_bytes, 2)::bigint << 16
                          | get_byte(v_bytes, 3)::bigint << 8
                          | get_byte(v_bytes, 4)::bigint) % 100000000000)::text, 11, '0');
    v_code := v_body || public.ean13_check_digit(v_body);
    begin
      insert into public.barcodes (shop_id, item_id, code, source)
      values (v_item.shop_id, p_item_id, v_code, 'generated')
      returning * into v_row;
      return v_row;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 10 then raise; end if;
    end;
  end loop;
end $$;
revoke all on function public.generate_barcode(uuid) from public;
grant execute on function public.generate_barcode(uuid) to authenticated;

-- Lookup used by the scanner: only this shop's codes are visible (RLS), so a
-- foreign code returns nothing — the UI says "not recognised", nothing more.
-- (A plain select with RLS does this already; the function exists so the
-- client has one stable call and we can add scan logging later.)
create or replace function public.lookup_barcode(p_shop_id uuid, p_code text)
returns table (item_id uuid, name text, floor_price numeric, suggested_price numeric, is_active boolean)
language sql stable security definer set search_path = public as $$
  select i.id, i.name, i.floor_price, i.suggested_price, i.is_active
  from public.barcodes b join public.items i on i.id = b.item_id
  where b.shop_id = p_shop_id and b.code = trim(p_code)
    and p_shop_id in (select public.current_shop_ids());
$$;
revoke all on function public.lookup_barcode(uuid, text) from public;
grant execute on function public.lookup_barcode(uuid, text) to authenticated;

-- Barcodes are removable (a mistyped manufacturer code); items.create covers it.
create policy barcodes_delete on public.barcodes for delete
  using (public.has_permission(shop_id, 'items.create'));

-- ----------------------------------------------------------------------------
-- 2. Selling-price changes — atomic, logged (PRD §5.2, TRD §4 price_changes)
-- ----------------------------------------------------------------------------
create or replace function public.set_item_prices(
  p_item_id uuid, p_floor numeric, p_suggested numeric, p_reason text default null
) returns public.items
language plpgsql security definer set search_path = public as $$
declare
  v_item public.items;
  v_user uuid := public.current_app_user_id();
begin
  select * into v_item from public.items where id = p_item_id for update;
  if not found then
    raise exception 'item not found' using errcode = 'no_data_found';
  end if;
  if not public.has_permission(v_item.shop_id, 'items.edit') then
    raise exception 'permission denied: items.edit' using errcode = 'insufficient_privilege';
  end if;
  if p_floor <> v_item.floor_price and not public.has_permission(v_item.shop_id, 'items.edit_floor_price') then
    raise exception 'permission denied: items.edit_floor_price' using errcode = 'insufficient_privilege';
  end if;
  if p_suggested < p_floor then
    raise exception 'suggested price must be at least the floor price' using errcode = 'check_violation';
  end if;

  if p_floor <> v_item.floor_price then
    insert into public.price_changes (shop_id, item_id, field, old_value, new_value, reason, changed_by)
    values (v_item.shop_id, p_item_id, 'floor_price', v_item.floor_price, p_floor, p_reason, v_user);
  end if;
  if p_suggested <> v_item.suggested_price then
    insert into public.price_changes (shop_id, item_id, field, old_value, new_value, reason, changed_by)
    values (v_item.shop_id, p_item_id, 'suggested_price', v_item.suggested_price, p_suggested, p_reason, v_user);
  end if;

  update public.items set floor_price = p_floor, suggested_price = p_suggested
    where id = p_item_id returning * into v_item;
  return v_item;
end $$;
revoke all on function public.set_item_prices(uuid, numeric, numeric, text) from public;
grant execute on function public.set_item_prices(uuid, numeric, numeric, text) to authenticated;

-- Direct item updates may no longer touch prices (go through set_item_prices).
revoke update on public.items from anon, authenticated;
grant update (name, is_active) on public.items to authenticated;
