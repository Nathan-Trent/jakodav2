-- ============================================================================
-- 0023_shop_preferences.sql — owner-set shop preferences (2026-09-20).
-- RUN MANUALLY after 0022.
--
--   shops.preferences: small owner choices about how THEIR shop runs, as
--   opposed to Zogal's operational settings (back office). First key:
--     payment_type_mode: 'optional' (default — sales record as cash unless
--                        the cashier changes it) | 'required' (the cashier
--                        must choose how the customer paid on every sale).
--   Reaches the apps through get_my_context() (to_jsonb(shop)); owners
--   update it under the existing shops_update policy (shop.settings).
-- ============================================================================
alter table public.shops add column if not exists preferences jsonb not null default '{}'::jsonb;
alter table public.shops add constraint shops_preferences_shape check (
  jsonb_typeof(preferences) = 'object'
  and (preferences ->> 'payment_type_mode') is null
   or (preferences ->> 'payment_type_mode') in ('optional', 'required'));
