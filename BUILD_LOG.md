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
Status: BUILT (2026-09-12) — 0013 applied 2026-09-13.
**PENDING (waiting on Nathan's Anthropic API key):** Edge Function
`parse-notebook-page` is NOT deployed. The Scan-a-page screen shows the
allowance and refuses cleanly ("Could not read the page right now") until
it is. When the key is ready:
  npx supabase secrets set ANTHROPIC_API_KEY=<key>
  npx supabase functions deploy parse-notebook-page
Not type-checked locally (no Deno on this machine) — first deploy will tell;
paste any error back.

**Nathan's rule (2026-09-12): platform keys are set by the BUSINESS back
office, not the shop owner, and not in .env.** Built as `platform_settings`
(+ `platform_settings_history`, `platform_admins`, `is_platform_admin()`).
Shops read through `platform_setting(key)`; only platform admins can write.
The admin UI lands with the web dashboard (Stage 8); until then values
change via SQL (comment at the top of 0013). Seeded: `notebook.enabled`,
`notebook.free_scans_per_month` (5), `notebook.model` (claude-opus-5),
`notebook.max_rows_per_page` (60). Nathan must add himself to
`platform_admins` (one insert, given with the migration).

**Built:**
- `notebook_scans` (one row per page; image never stored), `notebook_scan_quota()`
  (per-shop, per shop-local month; failed scans don't count),
  `notebook_scan_begin()` (as the user: sales.create + quota, refuses BEFORE
  any model call so an exhausted allowance costs nothing),
  `notebook_scan_close()` (confirmed / discarded + sale ids).
- Edge Function `supabase/functions/parse-notebook-page`: the only place
  the system calls an AI model. Runs as the signed-in user for the begin +
  item list (RLS), service role only to store the result. Claude Opus 5,
  adaptive thinking, effort medium, structured output (zod schema: page
  date, rows {item_text, item_id, quantity, unit_price, line_total,
  confidence, note}, warnings). Item ids returned by the model are checked
  against the shop's real items. Prompt is cached. Image ≤ 4 MB, JPEG/PNG/WebP.
- `packages/inventory-batches/src/notebook.ts`: `fetchScanQuota`,
  `parseNotebookPage` (surfaces the server's reason; 402 = allowance
  exhausted), `closeScan`.
- Desktop `NotebookScreen` ("Scan a page", anyone with sales.create):
  allowance badge always visible; choose photo (downscaled to ≤1600px JPEG
  client-side) → "Reading the page…" → review: photo beside an editable
  table (item select pre-matched, qty, price, per-row confidence + note,
  per-row problems: choose item / qty / price / below floor / stock), one
  date for the page (read from the page if written) → "Record N sales" =
  one ordinary `record_sale` per row, then the scan is closed with the sale
  ids. Discard asks first. Online only.

**Not done / notes:**
- Purchases from photos — sales only for now.
- Paid scans beyond the allowance — refused with a message; billing is Stage 8.
- Camera capture on desktop uses the OS file picker; `capture="environment"`
  will open the camera on a phone/tablet browser when the web build exists.
- No feedback loop from corrections back to the prompt yet.

## Infrastructure (Nathan, 2026-09-13) — updater, URLs, partner build
Status: BUILT. Waiting on Nathan: updater keypair + GitHub secrets;
second Vercel project for the partner POS; subdomains.

- **Desktop auto-updater**: `tauri-plugin-updater` + `plugin-process`;
  checks `github.com/Nathan-Trent/jakodav2/releases/latest/download/latest.json`
  on launch + every 6 h; signature-verified; `UpdateBanner` lets the cashier
  choose when to restart. Inert in a browser build. Public key in
  `tauri.conf.json` is a PLACEHOLDER until Nathan runs the keygen
  (docs/RELEASING.md). Version bumped to 0.2.0.
- **Release pipeline**: `.github/workflows/release-desktop.yml` — push tag
  `v*` → Windows NSIS build on GitHub, signed, published as a Release with
  updater JSON. Supabase URL/anon key + subscription public key come from
  GitHub secrets, baked at build; nothing reads Nathan's machine. `ci.yml`
  runs types/lint/tests on every push.
- **URLs**: `/` shop dashboard; `/admin` is now its OWN entry (own login
  "Zogal back office", own menu, refuses non-admins) — the back office no
  longer appears inside the shop dashboard; an admin gets a small link each
  way. Partner POS = the desktop app as a website: `npm run pos:build` →
  `apps/desktop/dist`, second Vercel project (docs/RELEASING.md).
- Terminals: default name "Front counter" (was "Terminal (Win32)"), rename
  from the dashboard, stale "stage 5" text gone.
- Naming: brand lockup now says "Zogal Business" / "Zogal Back office";
  product name still to be decided by Nathan (Zogal Shop recommended).

## Naming, pricing, marketing site (Nathan, 2026-09-17/18)
Status: BUILT — `0015_pricing_pos_web.sql` NOT YET APPLIED.

- **Product name: Doka by Zogal.** Zogal → Zogal Business (sub-brand) →
  Doka (this product). `.com` = marketing, `.app` = the product.
  Lockup/window/installer renamed; identifier `app.zogal.doka`.
- URLs: `business.getzogal.com` (sub-brand landing) and
  `business.getzogal.com/doka` (product page, pricing, sign-up →
  `doka.zogal.app`). Marketing site is a SEPARATE repo:
  github.com/Nathan-Trent/zogalbusiness (Next.js, Vercel).
- 0015: `pricing_plans` (public read, admin write, 3 seeded plans — Nathan
  edits in back office → Pricing) and `pos_web.enabled` kill switch for the
  partner web till (`WebTillGate` checks `pos_web_enabled()` before login;
  installed desktop never gated; cached answer offline).
- Release workflow now builds macOS (arm64 + x86_64) alongside Windows;
  unsigned until Apple Developer secrets exist (docs/RELEASING.md).

## Doka brand across all properties (Nathan, 2026-09-18)
Status: DONE. One Doka look: business.getzogal.com/doka, doka.zogal.app
(+ /admin), the desktop till, the partner web till. `@zogal/ui` tokens
re-valued (names kept): ink frame/sidebar, coral action, coral tint,
paper ground; ornament = rule + stamp; leaves and LeafField removed;
`AuthCover` replaces the leafy auth panel in both apps. Desktop 0.3.0.
Marketing repo: Zogal Business = ink + amber prospectus; Doka = coral
product sheet; per-product accent via `data-product`.

## Tax in plain answers; no blank screens; login (2026-09-18)
- Tax page (till + dashboard) now answers three questions per tax — do I
  owe anything right now / when is the next payment / roughly how much —
  plus one "what to do" line; the working is folded away. Logic in
  `packages/tax-engine/src/plain.ts` (`explainObligation`, tested),
  card in `@zogal/ui` `TaxAnswerCard`.
- Offline: the till caches the user's context after each sign-in and runs
  on it when the server is unreachable; with nothing cached it shows
  `ConnectionScreen` (no internet / can't reach Doka, retry, auto-retry on
  reconnect) — never a blank screen. Dashboard shows the same screen.
  Login screens say plainly when there's no connection.
- Login: `AuthCover` now carries the day-book ledger (rows animate in) and
  the stamp; matches the product page. v0.3.2.

## Zogal Business back office — slice 1 (2026-09-19)
Repo github.com/Nathan-Trent/backofficezogalbusiness → ops.business.zogal.app.
0016 applied. Company (ink+amber) / product (Doka coral) frame with zogal.app's
sidebar rule; Root + staff switches (invite by email); Who is told; Activity;
Health per feature; Doka: sign-in map, shops, shop page (subscription, people,
terminals), users, user profile (linked owner, effective permissions), Message
(Doka identity, email + in-app), Sign in as (reason, 30 min, logged). Marketing
and Finance are placeholders (slices 2–3). Apps (v0.3.3): record_signin on
sign-in; PresenceBar shows notices and the impersonation bar. Fixed: 30-day
chart blank (percentage bar heights); revoke terminal (select of ungranted column).

## Back office slice 2 — keys, Finance, payments (2026-09-19)
0017 (product_secrets, pricing_plans_draft + publish_catalogue, plan gating in
create_device_activation_code + invite trigger, invoices + apply_payment) —
handed to Nathan to run. Desktop v0.3.4: "Check for updates" in the sidebar
footer (one UpdaterProvider shared with the banner). Back office: Keys per
product (Doka → Settings → Keys) and company-wide (Zogal Business → Keys, Root);
write-only, set/not set/from-env, audited. mail.ts and the notebook Edge
Function read keys from product_secrets (env fallback; key checked before
spending scan allowance). Finance: Plans & prices (draft → publish, diff vs
live, history; replaces /admin/pricing), Subscriptions & invoices (needs
attention, raise invoice + email, resend, mark paid by hand, void). Payments:
`/api/pay/init` and `/api/pay/confirm` (user JWT, invoice read under RLS,
Paystack/Flutterwave keys from product_secrets) + webhooks
`/api/pay/webhook/{paystack,flutterwave}` (signature/hash + provider re-verify;
amount checked; apply_payment idempotent). Dashboard Subscription page: plan
usage (shop_plan_usage), plans, invoices with Pay buttons, confirm on return
(`?invoice&provider&reference`), plan_limit errors in plain words.
Not started: plan change self-service from the dashboard; renewal reminders
7/1/0 days (needs a cron); Marketing slice; retire /admin; §8.1 tax page.
Nathan: run 0017; set keys in the back office; set webhook URLs in Paystack
(`/api/pay/webhook/paystack`) and Flutterwave (`/api/pay/webhook/flutterwave`,
secret hash = flutterwave_secret_hash); Vercel env DOKA_APP_URL on the back
office; optional VITE_PAY_API_URL on the dashboard (defaults to ops URL).

## Direction change: client-first + push, no polling (Nathan, 2026-09-19)
Nathan: "all of the build should be client side first… when there's a change
in the database, the database tells the front end… not always pinging."
Every surface: load once, navigate in memory, Supabase Realtime pushes
changes, writes are optimistic with in-place progress, long work is a
background job with retries. No page-level waits; custom alerts/toasts only.
Scheduled work runs on QStash (Upstash), not Vercel cron — Nathan runs the
schedule-creation curl when handed it.
Order agreed: (1) back office client-first + Realtime + optimistic switches +
jobs + sign-in feedback; (2) payment provider Active switch (one active; one
Pay button); (3) recurring billing: card-on-file tokens, renewal job via
QStash, failed-charge retries, reminders 7/1/0; (4) Realtime instead of
polling in desktop + dashboard (Presence, subscription, settings); (5)
Marketing slice, retire /admin, §8.1 tax page.
Rule: payments are SUBSCRIPTION ONLY — shops pay Zogal for Doka. Doka never
moves money between a shop and its customers.

Done 2026-09-19 (late): step 1 (back office client-first, live, jobs) and
step 2 (payments.provider switch, single Pay button) — deployed; 0018 + 0019
applied. v0.3.5 fixes the clipped sidebar footer. QStash schedule NOT yet
created (Nathan, later) — jobs still run via the JOBS_SECRET kick.

Done 2026-09-20 (overnight) — BACK OFFICE COMPLETE:
- Step 3 recurring billing (0020): card token captured on the first online
  payment (Paystack authorization_code / Flutterwave card token) into
  payment_methods; daily `renew` job raises the next invoice ≤3 days before
  expiry and charges the token with the ACTIVE provider, 3 tries with owner +
  staff told; `remind` job 7/1/0 days for shops with no card; the runner
  queues both daily jobs itself (ensureDailyJobs) so QStash only ticks.
  Dashboard: card on file, auto-renew on/off, remove card. Shop page shows
  the card; Finance shows renewal state.
- Step 4: Presence (notices + impersonation bar) pushed by Realtime in the
  desktop app (v0.3.6) and the dashboard — the 5-minute poll is gone. The
  sync engine's own cadence is unchanged (offline-first, by design).
- Marketing slice (0021): every sentence on business.getzogal.com is a field
  in site_content (schema in lib/content-schema.ts, IDENTICAL in both repos);
  the site reads live rows over built-in defaults, revalidates every minute
  and on publish (/api/revalidate + SITE_REVALIDATE_TOKEN). Back office:
  Marketing → Zogal Business site / Doka page editors (draft, diff vs live,
  publish with note + history, discard), Inbox (contact form → reply by
  email wearing the page's identity, archive; staff told on each tick).
  Contact form on the Doka page (submit_contact: shape + 5/IP/hour).
- doka.zogal.app/admin retired: shows a pointer to ops.business.zogal.app;
  admin screens deleted.
Nathan: run 0020 and 0021; set SITE_REVALIDATE_TOKEN on BOTH Vercel projects
(same value); create the QStash schedule when ready.

Done 2026-09-20 — main app:
- Web signup dead end fixed: signed in with no shop → Create your shop
  (create_shop RPC) instead of "install the desktop app". Back office Users
  lists every person with a "No shop yet" pill + filter (stalled sign-ups).
- Payment type per sale (0022): sales.payment_type cash|transfer|card|pos;
  record_sale + replay_offline_sale take p_payment_type (SYNC: rides in the
  outbox payload as payment_type; older queued entries replay as cash);
  PaymentTypePicker in the Sell cart (cash preselected, radio group, arrow
  keys); "Record cash sale" button; Sales history column + filter + detail;
  shop_report() wrapped (v1 kept) to add by_payment; dashboard Reports
  "Paid by" tab + CSV. Desktop tag v0.3.7 waits for 0022 (the app sends the
  new parameter; without 0022 record_sale has no matching signature).

- Desktop: Staff, Reports, Settings no longer "coming soon" — ported from
  the dashboard (same components, same RPCs; online-only and say so).
- Shop preference (0023) `payment_type_mode`: optional (default — cash
  assumed, "Paid by: Cash — change" in the cart) or required (cashier must
  pick; button reads "Choose how they paid"). Set in Settings on both apps.

## Release pipeline bug + version display (Nathan, 2026-09-20)
Nathan hit "Couldn't check for updates — None of the fallback platforms
['windows-x86_64-nsis', 'windows-x86_64'] were found" on an old install, and
flagged that a raw error like that should never reach a user. Root cause:
the Windows/Mac-arm/Mac-intel builds ran in parallel and each published
straight to the live "latest" GitHub release as it finished — so for the
several minutes between the first build landing and the last, the public
release (and its latest.json) was incomplete, and any app or the marketing
site checking during that window saw it. Fixed: builds now publish to a
DRAFT release; a final `publish` job undrafts it only once all three have
landed, so nothing sees a half-built release. Also: a failed update check
shows one plain sentence (`friendlyUpdateError`) instead of the exception
text. Both apps now show their release number in the sidebar footer
(desktop "Doka 0.3.8" / collapsed "v0.3.8"; web "Doka 0.3.8 · web"), read at
build time from tauri.conf.json so the two surfaces can't disagree.
v0.3.8 tagged and pushed; GitHub Actions building.

## Working through the parked list (Nathan, 2026-09-20): items 1–6
1. Login screen redesign — both apps' LoginScreen track an explicit phase
   (idle → checking → opening, or creating → created) instead of one "busy"
   flag, so the button always says what's happening, including the network
   round trip after signIn() resolves but before the app switches screens
   (previously flashed back to "Sign in" for a moment). Errors go through
   the existing friendlyError() mapper. auth.signUp() now returns whether a
   session came back immediately, so the screen says "signing you in"
   rather than always "check your email". Dropped the dead /admin login
   variant.
2. §8.1 tax rules page — see below.
3. Nielsen/Norman pass — swept both apps and the back office for common
   violations (browser confirm/alert, silent failures, unconfirmed
   destructive actions, dialog focus/escape, empty states, currency-
   formatting consistency). Clean everywhere except Sync issues, where
   three real ones stacked: SyncConflictRow's TS type never included
   "locked_period" even though 0010 added it to the DB months ago, so
   every locked-period conflict (an offline sale landing in an
   already-filed tax period — an active code path) silently fell into a
   generic default branch; that branch rendered `JSON.stringify(r.detail)`
   straight to the shop owner; and below_floor's two amounts bypassed
   formatNaira/toKobo (no thousands separator). All three fixed in both apps.
4. Self-service plan change: new `/api/pay/change-plan` (back office) —
   verifies the caller as themselves (JWT, has_permission shop.settings on
   their own shop, not a staff capability), raises a one-month invoice for
   the chosen live plan, starts a checkout for it immediately. Dashboard:
   "Switch to <plan>" on each plan card with a ConfirmDialog explaining what
   happens. The plan itself only changes once apply_payment() settles that
   invoice — same rule as any invoice, just owner-started instead of Zogal.
5. Device credential → OS credential store: moved off localStorage (webview-
   scoped, readable from devtools) onto Windows Credential Manager / macOS
   Keychain / Linux Secret Service via tauri-plugin-keyring — verified with
   a real `cargo add` + `cargo check` + full `cargo build`, not assumed from
   docs. One-time migration reads the old localStorage binding once, moves
   it into the keyring, never touches localStorage again — no till needs
   re-activating. loadDevice/saveDevice/clearDevice are now async;
   SessionProvider tracks device as `undefined` until that resolves and the
   loading screen waits for it, so an activated till can't flash "not
   activated". Partner web build (no native layer) keeps localStorage.
6. Rate-limit activate_device (0025, **handed to Nathan**): anon-callable by
   design, nothing stopped a script hammering it with no auth at all. Same
   shape as authorize_override/submit_contact's existing rate limits: count
   recent failed attempts by caller IP, refuse before checking the code, log
   the outcome. A real cashier typing a real code is unaffected.
v0.3.9 tagged and pushed for items 5-6 (native change, needs a real release
to prove itself on macOS CI — only verified on Windows locally).

### §8.1 tax rules page
Stage 6 (0010) already built the data model, the deterministic engine, and
"a figure is labelled an estimate until a human verifies the rule" — the
piece still missing was TRD §8.1's "separate, dedicated settings page in
the operational center". Built in the back office:
- New sensitive capability `doka.tax.manage`. Doka → Configure → Tax rules.
- Per tax type, per kind (threshold/rate/bands/filing_due): the rule in
  force in plain language, its effective-dated history, a Verified switch,
  and Add/Replace with a form shaped to the kind (the filing-due fields
  switch between monthly and annual automatically from the type's own
  `period`). Business-category → tax-type mapping editor. "Recent changes"
  from `tax_rules_history` via a new gated RPC (that table has no select
  policy at all — read the same way as the other admin-only figures).
- `0024_tax_rules_admin.sql` (jakodav2, **handed to Nathan**): `add_tax_rule()`
  is the only write path for a new rule — closes whatever was open for that
  (type, kind), refusing an effective date that wouldn't actually close it,
  and inserts the new one in one transaction. Never an edit in place.
- Read grants for tax_types/business_categories/business_category_tax_types/
  tax_rules turned out fine as-is (Supabase grants `anon`/`authenticated`
  table privileges by default; RLS is what restricts — the codebase's own
  explicit `revoke all ... from anon, authenticated` pattern elsewhere is
  belt-and-braces for tables deliberately locked down, not evidence every
  table needs it). No grant bug; checked before assuming one.

## Held sales on the terminal (Nathan, 2026-09-19) — v0.3.11
A customer is doing a transfer or went back for one more item; the cashier
needs to serve the next person and come back. **Hold sale** parks the whole
cart (lines, typed quantities/prices, customer, payment type) and clears the
till; a **Held sales (n)** list at the top of the sale panel shows name /
items / total / how long ago — tap to resume, bin icon to discard (confirm).
Resuming while the cart has lines asks: hold the current one first (default)
or discard it — never silently loses a cart. Unlimited holds.
- `apps/desktop/src/lib/heldSales.ts` — localStorage `doka.held.<shopId>`,
  survives restart. **Not synced, on purpose**: nothing is sold and no stock
  moves until the sale is resumed and recorded normally, so the outbox and
  server never see a hold. Cross-terminal resume would need a server table +
  sync path — not built, not asked for.
- Resumed lines re-read the item from the working set (price/floor changes
  since the hold apply; the typed sale price is kept and re-validated).
- Web dashboard unchanged (it doesn't sell).

### Parked (pick up later — do not lose)
- Accountant verification of the actual tax rules entered (the page and the
  human-gate mechanism are done; the figures are still the Stage 6 draft
  seed, verified = false, labelled as estimates until someone checks them).
- **Apple signing + notarization — REQUIRED before promoting the Mac download.**
  Unsigned build shows "Doka is damaged" on Sequoia (Gatekeeper). Workaround
  today: `xattr -cr /Applications/Doka.app`. Needs Apple Developer account →
  Developer ID cert → APPLE_* secrets (workflow already supports them).

## Release pipeline — LIVE (2026-09-18)
v0.3.0 (Windows) and v0.3.1 (Windows + macOS arm64/x86_64, unsigned) built
and published by GitHub Actions from tags. Updater public key in
tauri.conf.json; private key in GitHub secrets only. Installed tills
update themselves. Fix in v0.3.1: Apple signing vars exported only when
the certificate secret exists.

## Scheduled: temporary partner web build (Nathan, 2026-09-12)
At the END of the build sequence: host the same app as a web build (it is a
Vite app inside Tauri already) so a partner can sign up and test without
the desktop install. Switched off / discontinued when Nathan says. Not
started; nothing built for it yet.

## Stage 8 — Web dashboard
Status: BUILT (2026-09-13) — `0014_web_dashboard.sql` NOT YET APPLIED; not
yet deployed to Vercel. Verified locally: builds, lint/tests green, login
renders (desktop + phone widths); screens past login not exercised in a
browser by me (no credentials) — Nathan to click through after 0014.

**Decision (Nathan, 2026-09-13):** Vite + React SPA instead of the TRD's
Next.js — logged in TRD §2. Reason: shares `@zogal/ui` and the whole
component stack with the desktop app; nothing to render server-side.

**Built:**
- `packages/ui` (`@zogal/ui`) — extracted from the desktop app: shadcn
  primitives, brand marks, Alert/Confirm/toasts, NumberField, PeriodPicker,
  number + period helpers, token stylesheet. Desktop imports rewritten.
- `apps/web` — path-based pages (no router lib), `SessionProvider` (same
  Supabase auth; active shop is a choice, remembered per browser; `admin`
  flag from `is_platform_admin()`), responsive `Shell` (forest sidebar ≥
  md, top bar + drawer below), Zogal back-office section only for
  platform admins.
- Owner screens: **Overview** (period picker, takings / gross+net profit /
  stock / terminals online, series chart, sync-issue alert), **Reports**
  (`shop_report()`: by item / seller / terminal / customer / expense
  category, totals, CSV export), **Staff** (invite by email + role, change
  role, deactivate/reactivate, per-person permission overrides with
  plain-language names, custom roles from the fixed list, own manager
  PIN, pending invitations), **Terminals** (activation code — the locked
  §1 flow — online/offline, last sync, revoke), **Tax** (ported: declare
  category, status cards, mark filed), **Sync issues** (ported),
  **Subscription** (read-only: status/plan/expiry/days left; renewals via
  Zogal for now), **Settings** (shop name, timezone).
- Back office (`/admin/*`): **Shops** (every shop: owner, subscription,
  staff/terminals online, scans this month, open conflicts, 30-day sales;
  set status/plan/expiry with +30/+90/+1y), **Platform settings** (0013
  keys, inline edit, history), **Operational settings** (§5.1 values in
  plain words; merge-patch, history kept).
- `0014_web_dashboard.sql` (**to run**): `shop_report()`,
  `admin_list_shops()`, `admin_set_subscription()`,
  `admin_operational_settings()` / `admin_update_operational_settings()`,
  `admin_set_platform_setting()`; drops the duplicate
  `notebook_free_scans_monthly` from operational_settings (0013's platform
  setting is the one source of truth).
- `vercel.json` at repo root: build `npm run web:build`, output
  `apps/web/dist`, SPA rewrite. Vercel project must point at the repo
  root (it was wrongly at apps/desktop). Env vars needed on Vercel:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

**Not done / notes:**
- Payments (Paystack/Flutterwave) — own unit of work; subscription is set
  by the back office.
- The "temporary partner web build" is a different thing (the POS as a web
  app for a partner to test) and stays scheduled for the end.
- Node 22.11 on this machine is below Vite 7's 22.12 floor — works, warns.

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
- **2026-09-12** — 0012 applied. Stage 7 built: platform settings (admin-set
  keys), notebook scans + quota, `parse-notebook-page` Edge Function,
  Scan-a-page screen. 0013 + function deploy handed to Nathan. Noted the
  partner web build for the end of the sequence.
- **2026-09-13** — 0013 applied. Edge Function deploy deferred until Nathan
  has an Anthropic API key (see Stage 7 PENDING). Next: Stage 8.
- **2026-09-13** — Stage 8 built: `@zogal/ui` extracted; `apps/web`
  dashboard + Zogal back office; 0014 handed to Nathan. Vite SPA instead of
  Next.js (Nathan's decision, TRD §2 corrected). Next: apply 0014, deploy
  to Vercel, Nathan clicks through; then Stage 9.
- **2026-09-13** — 0014 applied, dashboard deployed on Vercel. Built the
  desktop auto-updater + GitHub release pipeline, split `/admin` into its
  own entry, `pos:build` for the partner web build. Nathan to: generate
  updater keys, add GitHub secrets, create the POS Vercel project.
- **2026-09-18** — Renamed to Doka by Zogal. 0015 (pricing + web-till
  switch) handed to Nathan. macOS in release matrix. zogalbusiness repo
  created with the sub-brand landing and Doka page.
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
