-- ============================================================================
-- 0028_barcodes_generated_plus_scanned.sql — one GENERATED barcode per item,
-- any number of SCANNED (manufacturer) ones (Nathan, 2026-09-20).
-- RUN MANUALLY after 0027.
--
-- 0007 allowed exactly one barcode of any kind per item. Real products
-- arrive with their own code on the pack — sometimes several (inner/outer
-- pack, old/new packaging). The owner should scan those in as they are and
-- only ask us to generate a label for things that have none. Rule now:
--   • at most ONE generated code per item (delete it to regenerate — same
--     deliberate step as before, no accidental second label in the wild);
--   • any number of manufacturer codes, each still unique within the shop.
-- The scanner path is the ordinary keyboard-wedge scanner; nothing here
-- involves the AI document scan.
-- ============================================================================

drop index if exists public.barcodes_one_per_item_uidx;
create unique index barcodes_one_generated_per_item_uidx on public.barcodes (item_id) where source = 'generated';

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
  if exists (select 1 from public.barcodes where item_id = p_item_id and source = 'generated') then
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
      v_try := v_try + 1;
      if v_try > 10 then raise; end if;
    end;
  end loop;
end $$;
