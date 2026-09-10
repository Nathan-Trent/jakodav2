-- ============================================================================
-- 0003_pgcrypto_search_path.sql — hotfix for 0002
--
-- RUN MANUALLY after 0002. Supabase installs pgcrypto in the `extensions`
-- schema; the three functions using gen_random_bytes() pinned
-- search_path = public and failed at runtime. No table changes.
-- (0002 has been corrected in-repo too; a fresh database only needs 0001+0002.)
-- ============================================================================

alter function public.get_my_manager_pin(uuid, interval)
  set search_path = public, extensions;
alter function public.create_device_activation_code(uuid)
  set search_path = public, extensions;
alter function public.activate_device(text, text)
  set search_path = public, extensions;
