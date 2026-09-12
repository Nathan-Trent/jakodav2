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
  (`npm run tauri -w @zogal/desktop -- icon <png>`).
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
- TS `@zogal/auth-permissions`: `AuthRepository` covering all of the above
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
Status: DONE (2026-09-11) — 0005 applied; palette settled on Zogal's greens
after trying an emerald-teal variant and a zinc/gold + cut-corner direction
(both reverted at Nathan's call).
Not in the TRD sequence as a stage; Nathan asked for the product to read as
a system (navigation, owner overview, role-aware views, honest "coming
soon" sections) before barcodes, and for Zogal's design system to be used
as Zogal ERP's (different brand, same system).

**Built (2026-09-11):**
- Product renamed **Zogal ERP** (was "JakoDav"); npm scope `@zogal/*`.
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
Status: DONE except hardware test (2026-09-11) — 0006 applied; generation,
scan → cart, unknown-code path, and label print verified with simulated
scanner keystrokes. **Real USB scanner test pending** — Nathan is getting
a scanner; if it types slower than 35 ms/key, raise `maxGapMs` in
`useBarcodeScanner`.
Scanning, multi-terminal support, barcode generation with uniqueness
checking, label printing.

**Built (2026-09-11):**
- `0006_barcodes.sql`: `generate_barcode(item)` — EAN-13 with GS1 in-store
  prefix `2` + check digit (`ean13_check_digit`), unique per shop, retries
  on collision; `lookup_barcode(shop, code)` (RLS → foreign codes are just
  "not recognised"); `barcodes_delete` policy; `set_item_prices()` atomic
  floor/suggested change writing `price_changes` (floor needs
  `items.edit_floor_price`); direct price updates on `items` revoked.
- Scanner: `useBarcodeScanner` — keyboard-wedge burst detection (≤35 ms
  between keys, Enter-terminated), swallows the burst so it never lands in
  a focused input. Active on Sell and Purchases.
- Sell: scan → add to cart; unknown code → "not recognised" only. SYNC:
  per-shop Supabase **broadcast** channel `shop:<id>:stock` — a terminal
  announces after sale/restock, others refetch quantities; 30 s polling
  fallback. (Chose broadcast over postgres_changes because RLS would hide
  other terminals' sales from a salesperson.)
- Items: barcode column, nudge when items lack one; `ItemDialog` —
  generate / attach manufacturer code (EAN-13 check-digit validated) /
  remove (confirm) / **print labels** (JsBarcode → SVG → print dialog; A4
  38×21 mm sheet or 50×30 mm roll; "Save as PDF" via the OS dialog) /
  edit selling prices with reason.
- Purchases screen: scan or pick items, qty + cost, one immutable batch per
  line; cost-change detection → after saving, PRD §6.3 dialog asks whether
  to apply new selling prices (logged, all stock); recent batches table
  (view_cost only).
- UX pass (Norman/Nielsen, standing rule from Nathan): `lib/errors.ts` maps
  DB errors to plain language + recovery step; `lib/feedback.tsx`
  (`notifyError/Success/Info`); `Alert` (persistent inline) and
  `ConfirmDialog` (named actions, safe default) replace browser
  alert/confirm; all screens migrated. Collapsible sidebar (icon rail,
  remembered, Ctrl+B); connection status dot always visible.
- Tests: EAN-13 validation + manual-code schema (12 tests total green).

**Not done:**
- Real USB scanner not yet tested on hardware — Nathan to test when he has one.
- Multi-terminal broadcast verified in code only; needs two terminals.

**Added (2026-09-11, after Nathan's review):**
- **One barcode per item** — `0007_one_barcode_per_item.sql` (**to run**):
  dedupes existing rows (keeps oldest), unique index on `barcodes(item_id)`,
  `generate_barcode` raises `item_has_barcode`. UI: Generate/Attach are
  disabled with the reason shown and the path forward (remove first).
- **Cost correction UI** — `CostCorrectionDialog` from the Purchases batch
  table (`purchases.correct_cost`): required reason, warns how many units
  already sold keep their recorded cost; calls `correct_batch_cost()`.

## Stage 5 — Offline-first & sync
Status: IN PROGRESS — built; `0008_sync_subscriptions.sql` NOT YET APPLIED,
Edge Function NOT YET DEPLOYED.

**Built (2026-09-11):**
- `0008_sync_subscriptions.sql` (**to run**): `operational_settings`
  (singleton + history, TRD §5.1 defaults), `subscriptions` (per shop, auto
  on shop create, open-ended until Stage 8 billing), `sync_conflicts`,
  `clock_anomalies`; `consume_batches_fifo_partial()` (shortfall-tolerant),
  `replay_offline_sale()` (idempotent on client_ref, keeps original sold_at,
  honours the floor as it stood at sale time, raises conflicts),
  `device_heartbeat` v2 (returns subscription + policy, logs clock
  divergence), `store_subscription_token()`.
  *Flagged:* `subscriptions` and `sync_conflicts` are not in the TRD §4
  entity list — required by §7, called out rather than added quietly.
- Edge Function `issue-subscription-token` + `keygen.ts` (**to deploy**):
  Ed25519 signing with the private key in Supabase secrets; the app ships
  only the public key, so it can verify but never forge or extend a token.
- `@zogal/sync`: `queue` (IndexedDB outbox, durable, ordered, idempotent),
  `clock` (monotonic accumulator + wall ratchet — see below), `token`
  (Ed25519 verify; every failure means *less* access), `gating`
  (grace → read-only → locked from BOTH expiry and sync cadence, stricter
  wins), `engine`, `conflicts`. 21 unit tests.
- Desktop: `SyncProvider` + `useSync`; `SyncBadge` in the sidebar (online,
  unsent count, gate state); `GateBanner` + full-screen `LockedScreen`;
  offline checkout enqueues and decrements local stock; Sync-issues screen
  for owners to review and annotate conflicts.

**Design notes worth keeping:**
- Clock: an early version kept an absolute wall-clock high-water mark. Tests
  caught that ONE bad clock reading (set to 2099) would poison it and lock a
  terminal forever. Now the ratchet is anchored to the last sync and reset by
  it; in-session forward jumps beyond the measured delta are flagged, not
  trusted, while the startup gap (app closed) is accepted.
- IndexedDB over SQLite for the outbox: durable and transactional with no
  Rust plugin. Trade-off: readable from devtools, so the device credential
  should still move to native storage before shipping.
- Stock refresh uses a broadcast channel, not postgres_changes, because RLS
  hides other terminals' sales from a salesperson.

**Fixed after first live test (2026-09-11):**
- **CORS**: the Edge Function had no CORS headers and answered the browser's
  OPTIONS preflight with 405, so every call from the app was blocked before
  it began. curl passed throughout because curl ignores CORS — a reminder
  that testing an endpoint is not testing the client's path to it.
- **Gating was too strict, in the exact way I said it must never be.** An
  unverifiable token forced read-only even while the terminal was online and
  the server had just accepted it. The token exists to police the OFFLINE
  case; while syncing, the server is the authority. Now: unverifiable +
  recently synced → full use with a visible warning; unverifiable + not
  syncing → read-only. Two tests pin this.

**Offline READS added (2026-09-11, after Nathan's live test) — the missing half:**
Stage 5 shipped an offline *outbox* but every read still went to the network,
so offline the app showed no items, no history and no figures, and Purchases
raised "No connection". Nathan's point: being offline means the terminal
cannot learn about changes made elsewhere — it does NOT mean it forgets what
it already downloaded. Fixed:
- `sync/cache.ts`: IndexedDB read cache (DB v2, same store as the outbox),
  `readThrough()` — fetch when possible, serve the last copy when not.
- `lib/shopData.tsx`: the terminal's **working set** (items, barcodes, stock,
  stock value, batches, recent sales, dashboard). Hydrates from IndexedDB
  instantly, then refreshes opportunistically. Every screen renders from
  this, never straight from the network.
- Offline sales decrement the working set locally, so the next sale sees the
  right stock; the server reconciles on replay.
- Scanner resolves against the cached barcode list first, so scanning works
  offline.
- `StaleNotice`: a quiet "Offline — showing data as of 14:32" line with a
  retry, replacing error toasts. Offline is a normal state in a Nigerian
  shop, not a fault; a red banner every few seconds was the "constantly
  complaining" failure.
- Purchases deliberately still needs a connection (it creates immutable
  batches and can shift selling prices — queuing it would let two terminals
  invent conflicting batch histories). It now says so plainly and keeps the
  list, instead of throwing a network error.

**Not done:**
- Offline end-to-end still unverified by a real outage test.
- Expenses/purchases not queued offline (deliberate for purchases).
- Device credential still in localStorage.
- Offline path not yet exercised end to end against a real outage.
- Device credential still in localStorage.
- Purchases/expenses are not queued offline yet — only sales.

## Stage 6 — Tax engine foundation
Status: DONE (2026-09-12) — `0010_tax_engine.sql` applied.
Config-driven rules table, category selection, live threshold widget;
refunds/reliefs data model present but inactive.

**The one decision that shapes this stage:** TRD §8.1 says the exact
Nigerian figures need an accountant and the widget shouldn't face a real
user until confirmed. That is baked into the data: every `tax_rules` row
has `verified = false` in the seed; the engine propagates it; the UI labels
every figure "Draft — not yet confirmed by an accountant" until a human
flips the flag. Nothing to rebuild when the numbers are confirmed.

**Built:**
- `0010_tax_engine.sql` (**to run**): `tax_types` (vat, pit, cit, dev_levy),
  `business_categories` + category→tax-type map (sole trader / registered
  company), `shop_tax_profiles` (the owner's DECLARATION — never inferred,
  TRD §8; includes voluntary VAT registration + TIN + fiscal year start),
  `tax_rules` (effective-dated, versioned, `verified`, source cited) with
  `tax_rules_history` (every change logged), `expenses` +
  `expense_categories` (PRD §6.4; voided-never-edited), `tax_periods`
  (self-reported filing with the FIRS reference; filed = locked, PRD §5.7),
  `tax_period_amendments` (visible corrections), `tax_relief_inputs` (data
  model only, calculation OFF per TRD §8), `shop_tax_summary()` (ledger
  totals for a window: turnover, COGS, expenses by category, gross/net
  profit — gated tax.view). Period lock: an expense dated into a filed
  period is refused unless it's an amendment; backdating a sale online is
  refused; a late OFFLINE sale into a filed period is accepted and raised
  as a `locked_period` sync conflict.
- DRAFT seed (all unverified, source noted per row): VAT 7.5% / ₦25M
  threshold / 21st of following month; PIT bands from NTA 2025
  (0% ≤₦800k … 25% >₦50M) / 31 March; CIT ₦50M small-company exemption /
  30%; Dev levy 4%. §8.1 warns sources conflict on the thresholds.
- `@zogal/tax-engine` (pure, 15 tests): `periods` (month/year windows with
  fiscal-year start, due dates, period enumeration), `engine`
  (`computeObligations` — threshold test on YEAR turnover, rate or
  progressive bands on the basis, verified propagation, plain-language
  notes; `periodStatuses` — outstanding vs filed with due/overdue),
  `repo` (loaders + declare/file/expense/amendment writes).
- Working set caches the tax slice (reference, profile, year+month ledger,
  filings) and expenses, so the whole tax view computes OFFLINE; unsent
  sales are folded into turnover/profit for the live figure.
- Screens: **Tax** (declare category → per-tax status cards with threshold
  bar, estimate, next due → outstanding-vs-filed list with "Mark filed"
  dialog that stores the reference and a figures snapshot → reliefs
  explained as recorded-not-applied), **Expenses** (record by category,
  month totals, void with reason, amendment flow when the date is in a
  filed period, terminal filter), **dashboard tax widget** (ambient, no
  button — one line per tax with threshold progress or estimate + due date).
- Read-only gating hides tax figures (TRD §7) via `financialsVisible`.

**Not done / notes:**
- Figures are DRAFT until an accountant verifies (`update tax_rules set
  verified = true, verified_by = …`). The §8.1 settings page to do that
  in-app is Stage 9.
- Documents/exports "matching required filing formats" (PRD §6.7) — the
  figures snapshot is stored with each filing; the export itself is Stage 8.
- Input VAT (VAT paid on purchases) isn't tracked, so the VAT estimate is
  output VAT only — said so in the UI.
- `shop.timezone` is used server-side; the client uses the terminal's day
  for "this month" — same result unless a terminal is set to a far timezone.

## Post-Stage-6 polish (Nathan's feedback, 2026-09-12)
Status: BUILT — `0011_dashboard_range.sql` NOT YET APPLIED.

- **Add stock is a two-step wizard, one save.** Step 1 quantity + cost →
  *Next*; step 2 floor + suggested (always shown, pre-filled, margin
  against the NEW cost, floor ≤ suggested validated) → *Save*. Nothing is
  written until Save: `recordPurchase`, then `setItemPrices` only if the
  prices actually changed (logged reason "Restock: cost A → B"), one
  success toast. Root cause of "it clears before I can think": the reset
  effect depended on `lastCost`, which changed when the batch list refreshed
  after the first save — now keyed on the item id only.
- **Period picker** (`lib/periods.ts`, `components/PeriodPicker.tsx`):
  Today / Yesterday / Last 7 / Last 30 / This month / Last month / This
  year / Last year / Custom range.
  - Dashboard: "Today" stays on the offline working set (includes unsent
    sales). Any other period calls `shop_dashboard(shop, from, to)` and
    caches the answer per window (`dashboard:<from>:<to>`), so a period
    looked at before still shows offline with the "as last downloaded"
    note. Headline stats switch to the range, gross profit shows net after
    expenses, the chart renders the range series (weekly buckets > 92 days).
  - Expenses: totals, category tiles and the list filter to the range
    (default This month). Client-side over the cached list.
- `0011_dashboard_range.sql` (**to run**): 3-arg `shop_dashboard` with
  `range` / `series` / `bucket`; 1-arg form delegates to today. Max 800
  days. No table changes.

## Sales history, Sell cleanup, Customers (Nathan, 2026-09-12)
Status: BUILT — `0012_customers.sql` NOT YET APPLIED. 0011 applied.

- **Sell does one job.** "Recent sales" removed from the till. The screen is
  scan/tap → cart → total → Record sale, plus an optional Customer row at the
  top of the cart ("Walk-in" until changed).
- **Sales screen** (`screens/SalesScreen.tsx`, new sidebar entry for
  everyone — RLS scopes a cashier to their own): period picker, search
  (item / customer / seller), seller + terminal filters (owner), totals strip
  (takings, count, units, average, gross profit with `items.view_cost`), one
  row per sale with an items summary ("Indomie ×3, Peak Milk ×1 · 2 more"),
  click → detail dialog (lines, seller, terminal, customer, cost + profit).
  SYNC: fetched per window and cached (`sales:<from>:<to>`); unsent sales
  from the outbox are merged on top, so the list is never behind the till.
  Dashboard "All sales" now goes here.
- **Customers** (`0012_customers.sql`, `packages/inventory-batches/src/customers.ts`,
  `screens/CustomersScreen.tsx`, `components/CustomerPicker.tsx`):
  `customers` table (name, optional unique-per-shop phone, note, active),
  `sales.customer_id` nullable, new permission `customers.manage` (owner +
  manager). Anyone who can sell may attach or add a customer at the till;
  editing/deactivating needs `customers.manage`. Customers screen = list,
  search, add/edit/deactivate, click → purchase history (embedded Sales
  screen filtered to them). `record_sale` gained `p_customer_id`;
  `replay_offline_sale` gained `p_customer` jsonb — SYNC: an offline sale
  carries `{id}` for a known customer or `{name, phone}` for one added
  offline; replay matches by phone in the shop first so two terminals adding
  the same regular offline produce one record. Customers added offline
  appear in the picker immediately (composeView overlays them from pending
  sales). Never fails a sale over a customer: an unknown id records a walk-in.
- Deliberately NOT built (own units of work): customer credit / "book",
  customer-specific prices, receipts/SMS to customers, loyalty.
- Until 0012 is applied: customers list is empty (fetch fails soft), the
  Customer row on Sell shows but recording a sale with a customer will fail
  (record_sale has no `p_customer_id` yet) — apply 0012 before using it.

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
- **2026-09-11** — Renamed the product to **Zogal ERP** (Nathan: same brand
  family as zogal.app, which is also fintech). `@zogal/*` scope,
  `app.zogal.erp`, `zogal-erp-desktop`. Brand assets COPIED into
  `apps/desktop/public/brand` so this repo is independent of zogal.app: the
  ribbon-Z mark, and the six landing-page leaves — which were 1–1.8 MB raster
  images inside SVG wrappers, extracted and downscaled to 13–20 KB PNGs
  (93 KB for the set instead of 9 MB). Leaves drift on signed-out screens
  only; the breathing mark is the one loading state. localStorage keys
  migrate from the old names so activated terminals stay bound.
  Repo folder and GitHub remote are still `jakodav2` — say the word and
  I'll rename them.
- **2026-09-11** — Stage 5 built (see above). Next: apply 0008, generate the
  keypair, deploy the Edge Function, then test a real outage.
- **2026-09-12** — Stage 6 built: tax engine (pure, 15 tests), 0010
  migration with draft-flagged seed, Tax + Expenses screens, dashboard
  widget. Handed to Nathan to apply. 64 tests green.
- **2026-09-12** — 0010 applied (Stage 6 DONE). Add-stock rebuilt as a
  two-step wizard with a single save; period picker on Dashboard and
  Expenses; `0011_dashboard_range.sql` handed to Nathan.
- **2026-09-12** — 0011 applied. Sell screen trimmed to selling only; Sales
  history screen; optional Customers module (0012, handed to Nathan). Next:
  Stage 7.
- **2026-09-11** — Nathan's offline test: selling worked but nothing else
  reflected it. Rebuilt reads as snapshot + overlay; add-stock journey;
  per-user attribution on shared terminals (0009, approved). 43 tests.
- **2026-09-11** — Stage 4 built: barcodes (EAN-13 generation, scanner hook,
  labels), Purchases screen with cost-change price prompt, live stock via
  broadcast, collapsible sidebar, UX layer (errors/feedback/Alert/Confirm).
  `0006_barcodes.sql` applied. Simulated-scanner verification passed.
  Fixed toast background (sonner vars need `hsl()` around HSL triplets).
  Tauri binary rebuilt as `zogal-erp-desktop.exe`. Next: cost-correction UI,
  then Stage 5 (offline-first & sync).
- **2026-09-11** — Stage 3b: rename to Zogal ERP; Zogal design system applied;
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
