-- ============================================================================
-- 0007_one_barcode_per_item.sql — one barcode per item (Nathan, 2026-09-11)
--
-- RUN MANUALLY after 0006.
--
-- A product carries exactly one code. To change it, remove the old one
-- first — a deliberate step, never an accidental second label in the wild.
-- Enforced here so no code path (UI, API, SQL) can create a duplicate.
-- ============================================================================

-- Existing duplicates: keep the oldest code per item, drop the rest.
-- (Only the test shop is affected today.)
delete from public.barcodes b
using public.barcodes keep
where keep.item_id = b.item_id
  and keep.created_at < b.created_at;

create unique index barcodes_one_per_item_uidx on public.barcodes (item_id);

-- Friendlier failure than a raw unique_violation.
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
  if exists (select 1 from public.barcodes where item_id = p_item_id) then
    raise exception 'item_has_barcode' using errcode = 'unique_violation';
  end if;

  loop
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
      -- code collision within the shop (item uniqueness was checked above)
      v_try := v_try + 1;
      if v_try > 10 then raise; end if;
    end;
  end loop;
end $$;
