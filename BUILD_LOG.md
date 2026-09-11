# Build Log

## Stage 1 — Foundation
Status: DONE (2026-09-10) — migration 0001 applied to Supabase, smoke-tested
Multi-tenant schema; core tables for shops, users, roles/permissions;
batch/FIFO inventory logic.

**Built (2026-09-10):**
- Repo scaffold: npm workspaces modular monolith (TRD §3). `packages/shared`,
  `packages/auth-permissions`, `packages/inventory-batches`, `packages/sync`
  (placeholder), `packages/tax-engine` (placeholder), `apps/desktop`
  (Vite + React 19 + Tauri 2). Root `tsc -b`, ESLint 9, Vitest. All green.
- `.gitignore`, `.env.example` (anon key client-side only; service-role key
  never `VITE_`-prefixed).
- `supabase/migrations/0001_foundation.sql` — **hand to Nathan to run**:
  - `shops`, `users` (no FK to auth.users — portability), `permissions`
    (fixed list, 20 keys), `roles` (3 system roles with fixed UUIDs + custom
    per-shop roles), `role_permissions`, `shop_members`,
    `member_permission_overrides` (per-person grant/revoke),
    `member_permissions()` resolver.
  - `items`, `barcodes` (unique per shop only), `price_changes`
    (append-only, trigger-enforced).
  - `purchases`, `batches` (immutability trigger: only `quantity_remaining`
    may change; `unit_cost` only via `correct_batch_cost()`),
    `purchase_cost_corrections` (append-only, reason required).
  - `sales` (with `client_ref` for idempotent offline replay — SYNC),
    `sale_lines` (floor snapshot), `sale_line_allocations` (COGS truth,
    append-only).
  - `consume_batches_fifo()` — oldest-first under `FOR UPDATE` row locks;
    `record_sale()` — atomic sale, floor-price check, permission check;
    `item_stock` view.
  - Thin RLS: tenant isolation via `current_shop_ids()`; cost data gated
    by `items.view_cost`; writes gated by permission; `auth.uid()` isolated
    to one helper function.
- TS: `allocateFifo()` mirrors the SQL for offline use (Stage 5) with tests;
  `InventoryRepository` (createItem / recordPurchase / recordSale /
  correctBatchCost / stockOnHand); `resolvePermissions()` mirrors
  `member_permissions()`; kobo-based money helpers.

**Verified in Supabase SQL editor (as postgres, RLS bypassed):** seed roles +
membership + `member_permissions()` + `item_stock` view; `consume_batches_fifo`
took 3 @₦500 then 1 @₦700 for a 4-unit line with cost snapshotted per
allocation. `record_sale()` not yet exercised — it requires a real
`auth.uid()`, which arrives in Stage 2.

**Not done in Stage 1:**
- Rust toolchain not installed on dev machine —
  `src-tauri` written but uncompiled. Icons not generated
  (`npm run tauri -w @jakoda/desktop -- icon <png>`).
- No `expenses`, `tax_rules`, `tax_periods`, `manager_pins` tables yet —
  they belong to Stages 2/6 and were deliberately left out.
- `sales.void` permission exists but no void function/path yet (Stage 3).
- Hand-written row types in `packages/shared/src/db-types.ts`; swap for
  `supabase gen types` output once the migration is applied.

**Next:** Stage 2.

## Stage 2 — Auth & roles end to end
Status: DONE (2026-09-10) — 0002 + 0003 applied; signup → users row →
create_shop → Owner membership → get_my_context → device activation all
verified with a real auth user via the Stage 3 UI. Invitations, custom
roles, and manager PIN paths exist in SQL + TS but have no UI yet and are
untested with a second user (Stage 8 dashboard / later).
Supabase Auth wired to own permission tables; default roles + custom role
creation; weekly rotating manager PIN.

**Built (2026-09-10):**
- `supabase/migrations/0002_auth_roles.sql` — **hand to Nathan to run after 0001**:
  - `auth.users` insert/email-change triggers → `public.users` (only auth-schema touchpoint).
  - `create_shop()` — caller becomes Owner; `enforce_last_owner` trigger.
  - `shop_invitations` (email + role, 7-day TTL) + `accept_my_invitations()`
    auto-joins on login using the JWT-verified email. *(Added beyond the
    one-line stage spec — needed to get staff into a shop without a
    server-side service-role key.)*
  - `create_custom_role()` — atomic role + permissions from the fixed list.
  - `manager_pins` — 6-digit CSPRNG, per manager per shop, lazy weekly
    rotation in `get_my_manager_pin()` (interval is a function default until
    §5.1 settings exist). Stored in clear, zero table grants, definer-only
    access — see SECURITY NOTE in the file. `authorize_override()` verifies,
    logs to `manager_overrides` (append-only), refuses self-approval,
    brakes after 5 failures / 15 min.
  - `devices` + `device_activation_codes`: `create_device_activation_code()`
    (8-char unambiguous, 10-min, hashed) → `activate_device()` (anon-callable,
    returns a 32-byte credential once) → `device_heartbeat()` (SYNC: stamps
    `last_sync_at`, returns subscription token slot for Stage 5).
    `device_status` view (online = synced < 5 min).
  - `get_my_context()` — user + memberships + effective permissions in one call.
  - **Fix to 0001**: `item_stock` view now `security_invoker` (views ran as
    owner and bypassed RLS — cross-tenant + cost leak). `device_status` same.
  - Column-level grants: `users` (name/phone only), `devices`
    (credential_hash never readable), `shop_invitations` (revoke only).
- TS `@jakoda/auth-permissions`: `AuthRepository` covering all of the above
  + typed `MyContext`, device/invitation/override row types.

**Not done / notes:**
- `enforce_last_owner` will block a hard `delete from shops` (cascade). Shops
  are soft-deleted via `is_active`; fine for now.
- `activate_device` is anon-callable with no rate limit (40-bit code, 10-min
  TTL). Add an attempt log if abuse becomes a concern.
- `sales.device_id` not added — Stage 3 will need it (flag: schema change).
- No UI yet; login/activation screens come with Stage 3's desktop skeleton.
- Not verified end-to-end against a real auth user yet.

## Stage 3 — Desktop app skeleton
Status: DONE (2026-09-11) — sales flow verified against real DB; native
Tauri window compiles and runs (VS 2022 Build Tools + Windows SDK installed,
12.5 min cold build). UI on shadcn/ui with placeholder palette pending
Nathan's design elements.
Real sales flow against one shop (add item → sell → hits database).

**Built (2026-09-10):**
- `0004_sales_device.sql` (applied): `sales.device_id`, `record_sale(...,
  p_device_id)`, `shop_stock()` (quantities for all members, no costs),
  `device_status.is_online` coalesce.
- `apps/desktop`: Tailwind 4 (Zogal token structure, placeholder palette),
  `SessionProvider` (auth state → `get_my_context`, device binding in
  localStorage), screens: Login/Signup, Setup (create shop / activate
  terminal as owner / enter code), POS (items + stock, add item with
  initial batch, cart with floor enforcement + stock check, record sale,
  recent sales; cost + margin shown only with `items.view_cost`).
- Verified with Nathan's real account: sale of 2 × ₦90,000 from a ₦62,000
  batch → allocation row, gross profit ₦56,000, stock 3 → 1, device_id set.
- Placeholder icons generated (`src-tauri/icons`).

- shadcn/ui adopted (Zogal conventions: `components.json`, `@/` alias,
  `cn()`, `ui/` components, oklch tokens). Font: Inter for now.

**Not done / notes:**
- Dev tip: run cargo/tauri from PowerShell, not Git Bash (Git's `link`
  shadows MSVC `link.exe`). `npm run desktop:tauri` needs port 1420 free.
- Design is placeholder — Nathan will supply design elements before the
  UI is styled properly.
- Device credential in localStorage (Stage 5 moves it to native store).
- Vercel is wrongly pointed at `apps/desktop` — pause until Stage 8.

## Stage 3b — App shell, dashboard, design system (added at Nathan's request)
Status: IN PROGRESS — built; `0005_dashboard.sql` NOT YET APPLIED
Not in the TRD sequence as a stage; Nathan asked for the product to read as
a system (navigation, owner overview, role-aware views, honest "coming
soon" sections) before barcodes, and for Zogal's design system to be used
as Jakoda's (different brand, same system).

**Built (2026-09-11):**
- Product renamed **Jakoda** (was "JakoDav"); npm scope `@jakoda/*`.
- Design system from `zogal.app/docs/design_system.md`: Manrope, green
  hierarchy (Forest/Deep/Action/Signal/Mint), solid cards + elevation (no
  blur), 16px cards / 10px buttons / pill badges, tabular-num money at 800,
  Tabler outline icons, sentence case. Light default, `.dark` tokens present.
- `AppShell` (Forest sidebar, role-gated nav from `lib/nav.ts`; unbuilt
  sections marked "soon" and render `ComingSoonScreen` with stage + scope).
- `DashboardScreen`: takings, gross profit (view_cost only), stock on hand
  + value, low stock, 7-day bars, terminals online, staff count, recent
  sales with seller + lines. Salesperson variant: own sales + quick actions.
- `ItemsScreen` (table, search, stock badges, avg cost/value gated),
  `DevicesScreen` (online status, revoke), `PosScreen` refit into shell,
  `AuthFrame` for login/setup.
- `0005_dashboard.sql`: `shop_dashboard(shop_id)` — one permission-aware
  RPC (sales.view_all → shop vs own; items.view_cost → profit/value).

**Not done:** Dark-mode toggle UI; Purchases/Expenses/Staff/Reports/Tax/
Settings are placeholders by design (their stages). Dashboard shows zeros
until 0005 is applied.

## Stage 4 — Barcode system
Status: NOT STARTED
Scanning, multi-terminal support, barcode generation with uniqueness
checking, label printing. (`barcodes` table exists; generation logic does not.)

## Stage 5 — Offline-first & sync
Status: NOT STARTED
Includes offline subscription enforcement (monotonic clock, signed token,
grace period, progressive gating).
Hooks already in place: `sales.client_ref` idempotency key; TS
`allocateFifo()` mirrors SQL for local allocation.

## Stage 6 — Tax engine foundation
Status: NOT STARTED
Config-driven rules table, category selection, live threshold widget;
refunds/reliefs data model present but inactive.

## Stage 7 — Notebook photo capture
Status: NOT STARTED

## Stage 8 — Web dashboard
Status: NOT STARTED
Owner control tower: subscriptions, user/role management, device
activation flow, reporting, device online/offline status.

## Stage 9 — Operational center
Status: NOT STARTED
Includes §5.1 operational settings page and §8.1 tax settings page.

---
## Log
(Append entries here as work happens — date, what was done, what's next.)

- **2026-09-10** — Stage 1 scaffold + `0001_foundation.sql` written and
  verified locally (`tsc -b`, 8 unit tests, eslint, `vite build` all pass).
  Migration handed to Nathan; not applied. Rust not installed — Tauri
  native layer uncompiled. Noted doc drift between BUILD_LOG and
  `docs/TRD.md` (resolved same day — see next entry).
  Next: apply migration, then Stage 2.
- **2026-09-10** — Docs-only fix: `docs/TRD.md` replaced with the corrected,
  complete version. Restored missing locked-spec content: §5.1 Operational
  settings page, §8.1 Tax settings page, §7 offline subscription enforcement
  (signed token, monotonic-clock elapsed tracking, 5-day mandatory sync,
  grace → read-only → fully-locked gating), plus §1 device activation flow,
  §4 `devices` / `operational_settings` entities, §6 Tauri locked, §11
  collapsed to timeline only. BUILD_LOG Stage 5 / Stage 9 wording verified
  against the new section numbers — unchanged; Stage 2 note's "§11.3"
  pointer updated to §1. **No code or migration affected**: Stage 1 does not
  touch §5.1, §7 offline enforcement, or §8.1. (`devices`,
  `operational_settings`, `expenses`, `tax_*`, `manager_pins` remain
  deliberately absent from `0001_foundation.sql` — later stages.)
- **2026-09-10** — Nathan applied `0001_foundation.sql` (RLS enabled) and ran
  smoke tests: stock view, permission resolver, and FIFO allocation all
  correct. **Stage 1 DONE.** Next: Stage 2 (Auth & roles).
- **2026-09-10** — Stage 2 written: `0002_auth_roles.sql` + `AuthRepository`.
  Decisions (Nathan: "go with your recommendations"): auth.users trigger for
  user linking; lazy PIN rotation (no pg_cron); device activation as
  SECURITY DEFINER SQL (no server). Found + fixed an RLS bypass in 0001's
  `item_stock` view. `tsc -b` / eslint / 8 tests green. Migration handed to
  Nathan; not applied. Next: apply 0002, smoke-test with a real signup.
- **2026-09-11** — Stage 3b: rename to Jakoda; Zogal design system applied;
  app shell + dashboard + items + terminals pages; `0005_dashboard.sql`
  handed to Nathan. Verified in browser. Dev note: Tabler icons is ~12k
  files — never run two npm installs concurrently (corrupted once, Vite
  optimizer cache had to be cleared).
- **2026-09-11** — Stage 3 DONE. 0004 applied; real sale verified in DB
  (2 × ₦90,000 from ₦62,000 batch, profit ₦56,000, device_id set).
  shadcn/ui adopted. Disk-full blocked Build Tools install (3.4 GB free)
  → Nathan cleared space → VS 2022 Build Tools + SDK installed → Rust
  shell compiled and native window runs. Next: Nathan's design elements,
  then Stage 4 (barcodes).
- **2026-09-10** — Nathan applied 0002. Runtime error: `gen_random_bytes`
  not found — Supabase keeps pgcrypto in the `extensions` schema and the
  definer functions pinned `search_path = public`. Fixed in-repo 0002 and
  shipped `0003_pgcrypto_search_path.sql` (applied). Device activation
  smoke test passed. `device_status.is_online` returned null for
  never-synced devices — `coalesce(..., false)` fixed in-repo 0002; will
  ship in the Stage 3 migration. Rule going forward: any function touching
  pgcrypto uses `search_path = public, extensions`. Git repo initialised;
  committing after every unit of work from now on (Nathan's request).
