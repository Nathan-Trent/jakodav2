-- ============================================================================
-- 0029_document_scan_kinds.sql — the AI page scan becomes an entry type on
-- every flow that takes rows (Nathan, 2026-09-20). RUN MANUALLY after 0028.
--
-- 0013 built the pipeline for one page kind: a handwritten SALES page →
-- sales. Nathan's framing: a photo is just another way to fill the form
-- you're already on, and the two places it matters most are onboarding —
-- "here is my stock ledger" (items + opening stock) and "here is today's
-- sales book" — plus supplier invoices (a purchase) and receipts (expenses).
--
-- Same table, same quota (plan entitlement `notebook_scans`, 0027), same
-- "photo never stored" rule. What changes: `page_kind` grows, the begin RPC
-- checks the permission for THAT kind, and the close RPC records whatever
-- was created (sales, items, a purchase, expenses) in `created_ids`.
-- ============================================================================

alter table public.notebook_scans drop constraint if exists notebook_scans_page_kind_check;
alter table public.notebook_scans add constraint notebook_scans_page_kind_check
  check (page_kind in ('sales', 'items', 'purchase', 'expenses'));
alter table public.notebook_scans add column if not exists created_ids uuid[];
comment on column public.notebook_scans.sale_ids is 'Kept for sales pages (pre-0029 readers); created_ids carries every kind.';

drop function if exists public.notebook_scan_begin(uuid, uuid);
create or replace function public.notebook_scan_begin(p_shop_id uuid, p_device_id uuid default null, p_page_kind text default 'sales')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_quota jsonb; v_id uuid; v_perm text;
begin
  v_perm := case p_page_kind
    when 'sales' then 'sales.create' when 'items' then 'items.create'
    when 'purchase' then 'purchases.create' when 'expenses' then 'expenses.create' end;
  if v_perm is null then
    raise exception 'unknown page kind %', p_page_kind using errcode = 'check_violation';
  end if;
  if not public.has_permission(p_shop_id, v_perm) then
    raise exception 'permission denied: %', v_perm using errcode = 'insufficient_privilege';
  end if;
  -- The kind's own feature must be on the plan too (a shop without expenses can't scan receipts).
  if p_page_kind = 'expenses' then perform public.require_entitlement(p_shop_id, 'expenses', 0); end if;
  perform public.rate_limit_hit('scan:' || public.current_app_user_id(), 30, interval '10 minutes');
  v_quota := public.notebook_scan_quota(p_shop_id);
  if not (v_quota->>'enabled')::boolean then
    raise exception 'plan_limit: Document scans are not included in your plan. Upgrade to use them.' using errcode = 'check_violation';
  end if;
  perform public.require_entitlement(p_shop_id, 'notebook_scans');
  insert into public.notebook_scans (shop_id, requested_by, device_id, page_kind)
  values (p_shop_id, public.current_app_user_id(), p_device_id, p_page_kind)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.notebook_scan_begin(uuid, uuid, text) from public;
grant execute on function public.notebook_scan_begin(uuid, uuid, text) to authenticated;

create or replace function public.notebook_scan_close(p_scan_id uuid, p_status text, p_sale_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare v public.notebook_scans; v_perm text;
begin
  if p_status not in ('confirmed', 'discarded') then
    raise exception 'status must be confirmed or discarded' using errcode = 'check_violation';
  end if;
  select * into v from public.notebook_scans where id = p_scan_id;
  v_perm := case v.page_kind when 'items' then 'items.create' when 'purchase' then 'purchases.create' when 'expenses' then 'expenses.create' else 'sales.create' end;
  if v.shop_id is null or not public.has_permission(v.shop_id, v_perm) then
    raise exception 'permission denied' using errcode = 'insufficient_privilege';
  end if;
  update public.notebook_scans
     set status = p_status, created_ids = p_sale_ids,
         sale_ids = case when page_kind = 'sales' then p_sale_ids else sale_ids end,
         confirmed_at = now()
   where id = p_scan_id and status = 'parsed';
end $$;

-- Catalogue wording: it's every kind of page now.
update public.feature_catalogue
   set name = 'Document scans',
       description = 'Photograph a stock ledger, a day''s sales page, a supplier invoice or a receipt and have it read into rows.'
 where product = 'doka' and key = 'notebook_scans';
