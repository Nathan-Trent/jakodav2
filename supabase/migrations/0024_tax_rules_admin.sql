-- ============================================================================
-- 0024_tax_rules_admin.sql — §8.1 tax settings page, the write side
-- (Nathan, 2026-09-20). RUN MANUALLY after 0023.
--
-- The data model, the deterministic engine and the "estimate until verified"
-- labelling were all built in Stage 6 (0010) — this adds the one missing
-- piece TRD §8.1 calls for: "a separate, dedicated settings page in the
-- operational center" where a human (Nathan or an accountant) adds a new
-- effective-dated rule or confirms one, with nothing ever overwritten.
--
-- add_tax_rule() is the only write path for a new rule. It closes whatever
-- row was previously open for that (tax type, kind) — setting its
-- effective_to the day before the new row starts — and inserts the new one,
-- in one transaction, so a change in the law can never leave a gap (no rule
-- in force) or an overlap (two rules answering at once). The existing
-- tax_rules_history trigger (0010) logs both halves automatically.
--
-- Marking a rule verified, and editing which tax types a business category
-- maps to, are plain single-table writes from the back office's own
-- service-role client — no new SQL needed for those (same as every other
-- back-office write in this app).
-- ============================================================================

create or replace function public.add_tax_rule(
  p_tax_type_key text, p_kind text, p_effective_from date, p_params jsonb,
  p_source text, p_note text, p_created_by uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_open_from date;
begin
  if not exists (select 1 from public.tax_types where key = p_tax_type_key) then
    raise exception 'no such tax type: %', p_tax_type_key using errcode = 'no_data_found';
  end if;
  if p_kind not in ('threshold', 'rate', 'bands', 'filing_due') then
    raise exception 'invalid kind: %', p_kind using errcode = 'check_violation';
  end if;

  -- A new rule must start strictly after whatever is currently open, or the
  -- old row (its effective_from not being earlier than the new one) would
  -- stay open too — two rules answering "what's in force" at once.
  select effective_from into v_open_from from public.tax_rules
   where tax_type_key = p_tax_type_key and kind = p_kind and effective_to is null
   order by effective_from desc limit 1;
  if v_open_from is not null and p_effective_from <= v_open_from then
    raise exception 'effective_from must be after % (the rule currently in force)', v_open_from
      using errcode = 'check_violation';
  end if;

  -- Close whatever was open for this (type, kind): nothing overwritten, just
  -- given an end date the day before the new rule starts.
  update public.tax_rules
     set effective_to = p_effective_from - 1
   where tax_type_key = p_tax_type_key and kind = p_kind and effective_to is null;

  insert into public.tax_rules (tax_type_key, kind, effective_from, params, source, note, created_by)
  values (p_tax_type_key, p_kind, p_effective_from, p_params, p_source, nullif(trim(coalesce(p_note, '')), ''), p_created_by)
  returning id into v_id;

  return v_id;
end $$;
revoke all on function public.add_tax_rule(text, text, date, jsonb, text, text, uuid) from public, anon, authenticated;

-- Read side for the back office's history panel — tax_rules_history has no
-- select policy at all (0010: "revoke all ... from anon, authenticated"), so
-- it's read the same way as the other admin-only figures (ops_sales_summary,
-- secrets_status): a definer function that checks the caller's own switch.
create or replace function public.tax_rules_history_list(p_tax_type_key text default null)
returns setof public.tax_rules_history
language sql stable security definer set search_path = public as $$
  select h.* from public.tax_rules_history h
  where public.has_capability('doka.tax.manage')
    and (p_tax_type_key is null or coalesce((h.new_row->>'tax_type_key'), (h.old_row->>'tax_type_key')) = p_tax_type_key)
  order by h.changed_at desc limit 300;
$$;
revoke all on function public.tax_rules_history_list(text) from public;
grant execute on function public.tax_rules_history_list(text) to authenticated;

-- So the back office's tax screen updates itself the moment a rule changes,
-- same as everything else since the client-first rebuild — no reload needed.
alter publication supabase_realtime add table
  public.tax_types, public.business_categories, public.business_category_tax_types, public.tax_rules;
