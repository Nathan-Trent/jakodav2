-- ============================================================================
-- 0010_tax_engine.sql — Stage 6: tax engine foundation + expenses
--
-- RUN MANUALLY after 0009.
--
-- TRD §8 (locked): rules live in DATA, effective-dated and versioned; every
-- change is logged; the owner DECLARES their category; calculation is
-- deterministic and lives in the tax-engine module, not here. This file
-- gives it the tables, the seed, and the ledger totals to compute from.
--
-- TRD §8.1: exact Nigerian thresholds/rates need an accountant. The seed
-- below is a DRAFT — every row has verified = false, and the app labels its
-- figures as unconfirmed estimates until a human sets verified = true. That
-- is the "not build-blocking, but don't show a real user" rule made concrete.
--
-- PRD §6.4: expenses (rent, transport, staff, utilities, other) feed net
-- profit, which is the base for personal income tax on a sole trader.
-- PRD §5.7: a filed period LOCKS; corrections are visible amendments.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tax types — the taxes the system knows how to reason about
-- ----------------------------------------------------------------------------
create table public.tax_types (
  key          text primary key check (key ~ '^[a-z_]+$'),
  name         text not null,
  authority    text not null,                 -- who you file with
  period       text not null check (period in ('monthly', 'annual')),
  /** Which ledger figure the rules apply to. */
  basis        text not null check (basis in ('turnover', 'net_profit')),
  description  text not null,
  sort_order   int not null default 0
);

insert into public.tax_types (key, name, authority, period, basis, description, sort_order) values
  ('vat',      'Value Added Tax',           'FIRS',       'monthly', 'turnover',   'Charged on sales once registered; returns filed monthly.', 10),
  ('pit',      'Personal Income Tax',       'State IRS',  'annual',  'net_profit', 'Tax on a sole trader''s business profit for the year of assessment.', 20),
  ('cit',      'Companies Income Tax',      'FIRS',       'annual',  'net_profit', 'Tax on a registered company''s profit.', 30),
  ('dev_levy', 'Development Levy',          'FIRS',       'annual',  'net_profit', 'Levy on a registered company''s assessable profit.', 40);

-- ----------------------------------------------------------------------------
-- 2. Business categories — the maintained list the owner picks from (TRD §8)
-- ----------------------------------------------------------------------------
create table public.business_categories (
  key          text primary key check (key ~ '^[a-z_]+$'),
  name         text not null,
  description  text not null,
  sort_order   int not null default 0
);
create table public.business_category_tax_types (
  category_key  text not null references public.business_categories(key) on delete cascade,
  tax_type_key  text not null references public.tax_types(key) on delete cascade,
  primary key (category_key, tax_type_key)
);

insert into public.business_categories (key, name, description, sort_order) values
  ('sole_trader_retail', 'Sole trader — retail shop',
   'The business is run in your own name (no CAC-registered company). Profit is taxed as your personal income.', 10),
  ('company_retail',     'Registered company — retail shop',
   'The shop is a CAC-registered limited company. The company is taxed on its profit.', 20);

insert into public.business_category_tax_types values
  ('sole_trader_retail', 'vat'), ('sole_trader_retail', 'pit'),
  ('company_retail', 'vat'), ('company_retail', 'cit'), ('company_retail', 'dev_levy');

-- ----------------------------------------------------------------------------
-- 3. The shop's declaration — self-reported, never inferred (TRD §8)
-- ----------------------------------------------------------------------------
create table public.shop_tax_profiles (
  shop_id           uuid primary key references public.shops(id) on delete cascade,
  category_key      text not null references public.business_categories(key),
  /** A shop may register for VAT voluntarily before crossing the threshold. */
  vat_registered    boolean not null default false,
  tin               text,
  /** Year of assessment start month (1 = January). Calendar year by default. */
  fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12),
  declared_by       uuid references public.users(id),
  declared_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger shop_tax_profiles_updated_at before update on public.shop_tax_profiles
  for each row execute function public.set_updated_at();

alter table public.shop_tax_profiles enable row level security;
create policy tax_profiles_read on public.shop_tax_profiles for select
  using (shop_id in (select public.current_shop_ids()));
create policy tax_profiles_write on public.shop_tax_profiles for all
  using (public.has_permission(shop_id, 'shop.settings'))
  with check (public.has_permission(shop_id, 'shop.settings') and declared_by = public.current_app_user_id());

-- ----------------------------------------------------------------------------
-- 4. Tax rules — versioned, effective-dated, human-gated (TRD §8, §8.1)
-- ----------------------------------------------------------------------------
-- One row per (tax type, rule kind, effective window). A change in the law is
-- a NEW row with a new effective_from, and the old row gets effective_to set;
-- nothing is overwritten. Retrospective calculation therefore needs no extra
-- logic: pick the rows in force on the date in question.
create table public.tax_rules (
  id             uuid primary key default gen_random_uuid(),
  tax_type_key   text not null references public.tax_types(key),
  kind           text not null check (kind in ('threshold', 'rate', 'bands', 'filing_due')),
  effective_from date not null,
  effective_to   date,                          -- null = still in force
  params         jsonb not null,
  /** TRD §8.1: false until an accountant confirms. The app labels figures
   *  computed from unverified rules as estimates. */
  verified       boolean not null default false,
  verified_by    uuid references public.users(id),
  verified_at    timestamptz,
  source         text not null,                 -- where this value came from
  note           text,
  created_by     uuid references public.users(id),
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index tax_rules_lookup_idx on public.tax_rules (tax_type_key, kind, effective_from desc);

-- Every change retains the prior value and when it changed.
create table public.tax_rules_history (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid not null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  old_row     jsonb,
  new_row     jsonb,
  changed_by  uuid references public.users(id),
  changed_at  timestamptz not null default now()
);
create or replace function public.log_tax_rule_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.tax_rules_history (rule_id, action, old_row, new_row, changed_by)
  values (coalesce(new.id, old.id), lower(tg_op),
          case when tg_op = 'INSERT' then null else to_jsonb(old) end,
          case when tg_op = 'DELETE' then null else to_jsonb(new) end,
          public.current_app_user_id());
  return coalesce(new, old);
end $$;
create trigger tax_rules_history_trg after insert or update or delete on public.tax_rules
  for each row execute function public.log_tax_rule_change();

-- Tenants read the rules (they need them to compute); only the operational
-- centre writes them (Stage 9). No tenant write policy at all.
alter table public.tax_rules enable row level security;
alter table public.tax_rules_history enable row level security;
alter table public.tax_types enable row level security;
alter table public.business_categories enable row level security;
alter table public.business_category_tax_types enable row level security;
create policy tax_rules_read on public.tax_rules for select using (true);
create policy tax_types_read on public.tax_types for select using (true);
create policy business_categories_read on public.business_categories for select using (true);
create policy bctt_read on public.business_category_tax_types for select using (true);
revoke all on public.tax_rules_history from anon, authenticated;

-- ---- DRAFT SEED — verified = false on every row. -----------------------------
-- Values as best understood from the Nigeria Tax Act 2025 (effective 1 Jan
-- 2026). TRD §8.1 says sources conflict and an accountant must confirm; the
-- app will say so until they do.
insert into public.tax_rules (tax_type_key, kind, effective_from, params, source, note) values
  -- VAT: 7.5%; small businesses under ₦25M turnover need not register/charge.
  ('vat', 'rate',       '2026-01-01', '{"rate": 0.075}',
   'Nigeria Tax Act 2025 (draft reading)', 'Standard rate. Confirm.'),
  ('vat', 'threshold',  '2026-01-01', '{"amount": 25000000, "basis": "annual_turnover", "below": "exempt"}',
   'Nigeria Tax Act 2025 (draft reading)', 'Small-business VAT threshold. Sources also cite ₦50M/₦100M for other purposes — confirm which applies to VAT registration.'),
  ('vat', 'filing_due', '2026-01-01', '{"day": 21, "months_after": 1}',
   'FIRS VAT return practice', 'Monthly return by the 21st of the following month. Confirm.'),

  -- PIT (sole trader): progressive bands on annual net profit; first ₦800k free.
  ('pit', 'bands',      '2026-01-01',
   '{"basis": "annual_net_profit", "bands": [
      {"upto": 800000,   "rate": 0.00},
      {"upto": 3000000,  "rate": 0.15},
      {"upto": 12000000, "rate": 0.18},
      {"upto": 25000000, "rate": 0.21},
      {"upto": 50000000, "rate": 0.23},
      {"upto": null,     "rate": 0.25}]}',
   'Nigeria Tax Act 2025 (draft reading)', 'Personal income tax bands from 2026. Confirm bands and whether reliefs apply before the bands.'),
  ('pit', 'filing_due', '2026-01-01', '{"month": 3, "day": 31, "years_after": 1}',
   'PITA practice', 'Annual return by 31 March of the following year. Confirm for the relevant state.'),

  -- CIT (registered company): small company (≤ ₦50M turnover) 0%, else 30%.
  ('cit', 'threshold',  '2026-01-01', '{"amount": 50000000, "basis": "annual_turnover", "below": "exempt"}',
   'Nigeria Tax Act 2025 (draft reading)', 'Small company exemption. Also has a fixed-asset test not modelled here. Confirm.'),
  ('cit', 'rate',       '2026-01-01', '{"rate": 0.30}',
   'Nigeria Tax Act 2025 (draft reading)', 'Standard company rate above the small-company threshold. Confirm.'),
  ('cit', 'filing_due', '2026-01-01', '{"month": 6, "day": 30, "years_after": 1}',
   'CITA practice', 'Within six months of year end for a calendar-year company. Confirm.'),

  -- Development levy: 4% of assessable profit (companies).
  ('dev_levy', 'rate',  '2026-01-01', '{"rate": 0.04}',
   'Nigeria Tax Act 2025 (draft reading)', 'Consolidated levy replacing several earlier ones. Confirm applicability to small companies.'),
  ('dev_levy', 'filing_due', '2026-01-01', '{"month": 6, "day": 30, "years_after": 1}',
   'Filed with CIT', 'Confirm.');

-- ----------------------------------------------------------------------------
-- 5. Expenses (PRD §6.4) — categorised, feed net profit
-- ----------------------------------------------------------------------------
create table public.expense_categories (
  key         text primary key,
  name        text not null,
  sort_order  int not null default 0
);
insert into public.expense_categories values
  ('rent', 'Rent', 10), ('transport', 'Transport', 20), ('staff', 'Staff', 30),
  ('utilities', 'Utilities', 40), ('other', 'Other', 90);
alter table public.expense_categories enable row level security;
create policy expense_categories_read on public.expense_categories for select using (true);

create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  category_key  text not null references public.expense_categories(key),
  amount        numeric(14,2) not null check (amount > 0),
  incurred_on   date not null default current_date,
  note          text check (note is null or length(note) <= 500),
  recorded_by   uuid references public.users(id),
  device_id     uuid references public.devices(id) on delete set null,
  /** Set when this expense is a visible correction to an already-filed period. */
  amendment_id  uuid,
  voided_at     timestamptz,
  voided_by     uuid references public.users(id),
  void_reason   text,
  created_at    timestamptz not null default now()
);
create index expenses_shop_date_idx on public.expenses (shop_id, incurred_on desc) where voided_at is null;

alter table public.expenses enable row level security;
create policy expenses_read on public.expenses for select
  using (public.has_permission(shop_id, 'expenses.view') or public.has_permission(shop_id, 'expenses.create'));
create policy expenses_insert on public.expenses for insert
  with check (public.has_permission(shop_id, 'expenses.create') and recorded_by = public.current_app_user_id());
-- Expenses are not edited; they are voided (with a reason) and re-entered.
create policy expenses_void on public.expenses for update
  using (public.has_permission(shop_id, 'expenses.create'))
  with check (public.has_permission(shop_id, 'expenses.create'));
revoke update on public.expenses from anon, authenticated;
grant update (voided_at, voided_by, void_reason) on public.expenses to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Filing periods — self-reported, lock on filing, amendments layered
-- ----------------------------------------------------------------------------
create table public.tax_periods (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  tax_type_key   text not null references public.tax_types(key),
  period_start   date not null,
  period_end     date not null,
  status         text not null default 'filed' check (status in ('filed')),
  filed_at       timestamptz not null default now(),
  filed_by       uuid references public.users(id),
  /** The FIRS Document Identification Number (or state equivalent). */
  reference      text not null check (length(trim(reference)) >= 4),
  evidence_note  text,
  /** Snapshot of the figures at the moment of filing. */
  figures        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (shop_id, tax_type_key, period_start),
  check (period_end >= period_start)
);
create index tax_periods_shop_idx on public.tax_periods (shop_id, tax_type_key, period_start desc);

-- A correction to a filed period: a visible layer, never a silent edit.
create table public.tax_period_amendments (
  id           uuid primary key default gen_random_uuid(),
  period_id    uuid not null references public.tax_periods(id) on delete cascade,
  shop_id      uuid not null references public.shops(id) on delete cascade,
  reason       text not null check (length(trim(reason)) >= 5),
  created_by   uuid references public.users(id),
  created_at   timestamptz not null default now()
);
alter table public.expenses
  add constraint expenses_amendment_fk foreign key (amendment_id) references public.tax_period_amendments(id);

alter table public.tax_periods enable row level security;
alter table public.tax_period_amendments enable row level security;
create policy tax_periods_read on public.tax_periods for select
  using (public.has_permission(shop_id, 'tax.view'));
create policy tax_periods_file on public.tax_periods for insert
  with check (public.has_permission(shop_id, 'tax.mark_filed') and filed_by = public.current_app_user_id());
-- Filed is filed: no update/delete policy. Corrections go through amendments.
create policy amendments_read on public.tax_period_amendments for select
  using (public.has_permission(shop_id, 'tax.view'));
create policy amendments_insert on public.tax_period_amendments for insert
  with check (public.has_permission(shop_id, 'tax.mark_filed') and created_by = public.current_app_user_id());

-- Is this date inside a period the shop has filed (for any of its taxes)?
create or replace function public.period_is_locked(p_shop_id uuid, p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tax_periods
    where shop_id = p_shop_id and p_date between period_start and period_end
  );
$$;

-- PRD §5.7: no edits inside a filed period. An expense dated into a locked
-- period must be an amendment. (Sales are immutable already; a late offline
-- sale that lands in a locked period is surfaced as a sync conflict below.)
create or replace function public.enforce_expense_period_lock()
returns trigger language plpgsql as $$
begin
  if new.amendment_id is null and public.period_is_locked(new.shop_id, new.incurred_on) then
    raise exception 'period_locked: % falls in a filed tax period; record it as an amendment', new.incurred_on
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger expenses_period_lock before insert on public.expenses
  for each row execute function public.enforce_expense_period_lock();

-- Backdating a sale into a filed period online is refused outright.
create or replace function public.enforce_sale_period_lock()
returns trigger language plpgsql as $$
begin
  if public.period_is_locked(new.shop_id, (new.sold_at at time zone 'Africa/Lagos')::date) then
    raise exception 'period_locked: this sale is dated inside a filed tax period'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
-- Only for direct/online inserts; replay_offline_sale bypasses via the flag below.
create trigger sales_period_lock before insert on public.sales
  for each row when (current_setting('app.offline_replay', true) is distinct from '1')
  execute function public.enforce_sale_period_lock();

-- sync_conflicts learns a new kind for the late-sale case.
alter table public.sync_conflicts drop constraint sync_conflicts_kind_check;
alter table public.sync_conflicts add constraint sync_conflicts_kind_check
  check (kind in ('stock_shortfall', 'duplicate_sale', 'below_floor', 'locked_period', 'other'));

-- Offline replay: allow the insert, but surface it — the owner filed without
-- knowing about this sale, and may need to amend.
create or replace function public.replay_offline_sale(
  p_shop_id uuid, p_client_ref uuid, p_sold_by uuid, p_lines jsonb,
  p_sold_at timestamptz, p_device_id uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sale      public.sales;
  v_line      jsonb;
  v_item      public.items;
  v_qty       int;
  v_price     numeric(14,2);
  v_floor     numeric(14,2);
  v_line_id   uuid;
  v_total     numeric(14,2) := 0;
  v_short     int;
  v_conflicts int := 0;
begin
  if not public.has_permission(p_shop_id, 'sales.create') then
    raise exception 'permission denied: sales.create' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.shop_members where shop_id = p_shop_id and user_id = p_sold_by) then
    raise exception 'seller is not a member of this shop' using errcode = 'insufficient_privilege';
  end if;

  select * into v_sale from public.sales where shop_id = p_shop_id and client_ref = p_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale.id, 'already_synced', true, 'conflicts', 0);
  end if;

  if p_device_id is not null and not exists (
    select 1 from public.devices where id = p_device_id and shop_id = p_shop_id and revoked_at is null
  ) then
    raise exception 'device is not an active device of this shop' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('app.offline_replay', '1', true);
  insert into public.sales (shop_id, client_ref, sold_by, sold_at, note, device_id)
  values (p_shop_id, p_client_ref, p_sold_by, p_sold_at, p_note, p_device_id)
  returning * into v_sale;
  perform set_config('app.offline_replay', '', true);

  if public.period_is_locked(p_shop_id, (p_sold_at at time zone 'Africa/Lagos')::date) then
    insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, detail, occurred_at)
    values (p_shop_id, p_device_id, 'locked_period', v_sale.id,
            jsonb_build_object('note', 'Sale arrived after its tax period was filed'), p_sold_at);
    v_conflicts := v_conflicts + 1;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty   := (v_line->>'quantity')::int;
    v_price := (v_line->>'unit_price')::numeric;
    select * into v_item from public.items where id = (v_line->>'item_id')::uuid and shop_id = p_shop_id;
    if not found then
      raise exception 'item % not found in shop', v_line->>'item_id' using errcode = 'no_data_found';
    end if;
    v_floor := coalesce((v_line->>'floor_price_at_sale')::numeric, v_item.floor_price);
    if v_price < v_floor then
      insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, item_id, detail, occurred_at)
      values (p_shop_id, p_device_id, 'below_floor', v_sale.id, v_item.id,
              jsonb_build_object('unit_price', v_price, 'floor_at_sale', v_floor, 'item_name', v_item.name), p_sold_at);
      v_conflicts := v_conflicts + 1;
      v_floor := v_price;
    end if;
    insert into public.sale_lines (sale_id, shop_id, item_id, quantity, unit_price, floor_price_at_sale)
    values (v_sale.id, p_shop_id, v_item.id, v_qty, v_price, v_floor)
    returning id into v_line_id;
    v_short := public.consume_batches_fifo_partial(v_line_id);
    if v_short > 0 then
      insert into public.sync_conflicts (shop_id, device_id, kind, sale_id, item_id, detail, occurred_at)
      values (p_shop_id, p_device_id, 'stock_shortfall', v_sale.id, v_item.id,
              jsonb_build_object('quantity_sold', v_qty, 'unattributed', v_short, 'item_name', v_item.name), p_sold_at);
      v_conflicts := v_conflicts + 1;
    end if;
    v_total := v_total + v_qty * v_price;
  end loop;

  update public.sales set total = v_total where id = v_sale.id;
  return jsonb_build_object('sale_id', v_sale.id, 'already_synced', false, 'conflicts', v_conflicts);
end $$;

-- ----------------------------------------------------------------------------
-- 7. Reliefs / refunds — data model present, calculation OFF (TRD §8)
-- ----------------------------------------------------------------------------
create table public.tax_relief_inputs (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  kind         text not null check (kind in ('charitable_donation', 'pension_contribution', 'withholding_tax_credit', 'other')),
  amount       numeric(14,2) not null check (amount > 0),
  incurred_on  date not null,
  reference    text,
  note         text,
  recorded_by  uuid references public.users(id),
  created_at   timestamptz not null default now()
);
alter table public.tax_relief_inputs enable row level security;
create policy relief_inputs_rw on public.tax_relief_inputs for all
  using (public.has_permission(shop_id, 'tax.view'))
  with check (public.has_permission(shop_id, 'tax.mark_filed') and recorded_by = public.current_app_user_id());

-- ----------------------------------------------------------------------------
-- 8. Ledger totals for a window — what the engine computes from (PRD §6.7)
-- ----------------------------------------------------------------------------
-- Deterministic, from the ledger, server-side. Gated on tax.view. The engine
-- (packages/tax-engine) applies the rules to these numbers; this function
-- knows nothing about tax law.
create or replace function public.shop_tax_summary(p_shop_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_out jsonb;
begin
  if not public.has_permission(p_shop_id, 'tax.view') then
    raise exception 'permission denied: tax.view' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id;

  with sales_in as (
    select s.id, s.total from public.sales s
    where s.shop_id = p_shop_id and s.status = 'completed'
      and (s.sold_at at time zone v_tz)::date between p_from and p_to
  ),
  cogs as (
    select coalesce(sum(a.quantity * a.unit_cost), 0) as v
    from public.sale_line_allocations a
    join public.sale_lines l on l.id = a.sale_line_id
    join sales_in s on s.id = l.sale_id
  ),
  exp as (
    select category_key, coalesce(sum(amount), 0) as v
    from public.expenses
    where shop_id = p_shop_id and voided_at is null and incurred_on between p_from and p_to
    group by category_key
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'turnover',      (select coalesce(sum(total), 0) from sales_in),
    'sales_count',   (select count(*) from sales_in),
    'cogs',          (select v from cogs),
    'expenses',      (select coalesce(jsonb_object_agg(category_key, v), '{}'::jsonb) from exp),
    'expenses_total',(select coalesce(sum(v), 0) from exp)
  ) into v_out;

  return v_out || jsonb_build_object(
    'gross_profit', (v_out->>'turnover')::numeric - (v_out->>'cogs')::numeric,
    'net_profit',   (v_out->>'turnover')::numeric - (v_out->>'cogs')::numeric - (v_out->>'expenses_total')::numeric
  );
end $$;
revoke all on function public.shop_tax_summary(uuid, date, date) from public;
grant execute on function public.shop_tax_summary(uuid, date, date) to authenticated;
