# TRD — Invoicing & Record-Keeping System for Nigerian Retail SMEs
**Working name:** [TBD]
**Status:** Draft v1 — companion to PRD
**Owner:** Nathan Ogogo

---

## 1. Platform Split (locked)

Three surfaces, distinct jobs — nothing shared across them beyond the database and auth layer.

| Surface | Runs on | Job |
|---|---|---|
| **Desktop app** | Windows/Mac laptop, installed | The operational engine. All actual work happens here: sales, purchases, expenses, barcode scanning, offline-first. This is where salespeople and managers live all day. |
| **Web dashboard** | Any browser, owner's phone or laptop | The control tower. Not read-only — full CRUD on users/roles, subscription management, desktop-device activation, reporting/analytics, tax status, and live device status (which desktop devices are currently online vs. offline, and last-sync time for each). This is where the shop owner manages the business remotely. |
| **Operational center** | Internal, your team only | Support and oversight across all tenant shops — view logs, troubleshoot, assist a shop's login, monitor system health. Separate from the shop owner's own admin view. |

**V2 mobile** is not a new build — it's the web dashboard made mobile-friendly (or a thin wrapper around it). No new backend, no new POS logic.

**Why desktop, not web, for the operational engine**: a browser can't treat a USB barcode scanner as a real connected device (only sees it as keystrokes into whatever's focused) and can't deliver true offline-first behavior without serious workarounds. Desktop (Tauri — see §6) gives real hardware access and real local storage.

**Device activation flow (locked)**: owner generates a short-lived one-time code from the web dashboard; that code is entered once on the desktop app on install, exchanged for a persisted device credential (so it isn't re-entered on every launch), and binds that install to the shop as a row in `devices`.

## 2. Language & Stack (locked)

- **Language: TypeScript, end to end.** Considered Go, Rust, C#/.NET, Python — rejected not because they're worse in the abstract, but because Nathan's 11 years of architectural and coding judgment (his actual asset, not tied to any one syntax) transfers cleanly in TS, and would transfer much less reliably when directing AI-generated code in an unfamiliar language. Scalability is a schema/architecture concern, not a language concern — Postgres scales the same under TS as under Java or .NET.
- **Vendor stance: Supabase + Vercel for speed, with a hard portability rule.** The real concern was vendor lock-in, not the language. Supabase under the hood is plain Postgres — treat it that way:
  - Schema is plain, standard SQL. No proprietary Supabase-only constructs that don't travel.
  - **Auth**: Supabase Auth handles the login mechanism only (this is the hardened, hard-to-get-wrong part — keep it). All real identity and permissioning (roles, custom permissions, shop membership) lives in your own tables. If Supabase Auth is ever swapped out, only the login mechanism changes — user data and logic are untouched.
  - **RLS and Edge Functions kept thin** — configuration only. Real business logic lives in your own application code, portable to any Postgres host.
  - Vercel hosts the web dashboard only — irrelevant to the desktop client. *(Correction 2026-09-13, Nathan's decision: the dashboard is a Vite + React static SPA, not Next.js — same stack as the desktop app so both share the `@zogal/ui` design-system package; there is nothing to render server-side since every read goes to Postgres under RLS. Portability is unchanged.)*

## 3. Architecture Pattern (locked)

**Modular monolith** — not microservices, not a tangled single blob either.

- One deployable codebase, internally organized into clean, separately-owned modules: `tax-engine`, `inventory-batches`, `sync`, `auth-permissions`, `frontend-desktop`, `frontend-web`.
- Clear boundaries between modules now (so you can work on one without wading through others), without paying the operational overhead of running actual separate services from day one.
- If it later scales to hundreds of shops and specific modules need to be pulled out as real services, the clean boundaries make that an extraction, not a rewrite.

**Multi-tenant from day one, architecturally** — even though the real user count starts at one (the phone shop) and grows to ~4–5 known contacts next. Data model, auth, and tenant isolation are built assuming hundreds of shops exist from the first migration. This is distinct from *product* decisions, which stay scoped to what the one real client actually needs — architecture scales ahead of the user; features follow the user.

## 4. Data Model (core entities)

Event-sourced / append-only where it matters for integrity:

- `shops` (tenant root)
- `users`, `roles`, `role_permissions`, `custom_roles` (shop-owner-defined, built from a fixed permission list you expose)
- `items`
- `batches` — immutable once created (cost price, quantity, purchase date, frozen forever)
- `sales` — can reference multiple batches (a single sale can span batches if one runs out mid-transaction)
- `purchases`
- `price_changes` — append-only history (selling price is fully editable; every change logged, nothing overwritten)
- `purchase_cost_corrections` — admin override path for a mistyped batch cost: requires a typed reason, original value stays visible in history, never a silent edit
- `expenses`
- `tax_rules` — versioned config: tax type, threshold value, effective date range. Every change logged (old value + when changed). Effective-date-ranged by design, so retrospective calculation for a past year just applies whatever rule was in effect then — no separate "historical calculation" logic needed.
- `tax_periods` — filing status per period, locks on "filed," amendments layered visibly on top afterward
- `barcodes` — unique per shop only, never globally unique across tenants
- `manager_pins` — system-generated, rotates weekly, visible only on the manager's own login
- `devices` — one row per activated desktop install: shop it's bound to, last successful sync timestamp, online/offline status (derived from last-sync recency), signed subscription token last issued
- `operational_settings` — single settings table backing §5.1's operational-center settings page (PIN rotation interval, grace period, mandatory sync interval, scan allowance, etc.), with change history

## 5. Roles & Permissions (locked)

**Default roles** (fixed, built-in): **Owner/Admin**, **Manager**, **Salesperson**.

- Shop owner **can create additional custom roles**, built by selecting from a fixed list of system-defined permissions/functionalities — not arbitrary free-form roles.
- **Manager approval actions** (e.g., removing an item from cart) require a **PIN specific to that manager**, not a single shared manager PIN.
- **PIN rotation (in v1, not deferred)**: the system generates a new manager PIN weekly. The manager must log in on their own device to see the current PIN before using it to authorize an override. This defeats a salesperson memorizing and reusing an old PIN, without needing full remote-approval infrastructure.
- Every override is logged against the specific PIN/manager used.
- **Operational center** (internal, your team) is a wholly separate view from any shop's own admin — support/oversight only, not part of the tenant's role hierarchy.

### 5.1 Operational settings page (locked)

Every operational parameter we've discussed as "configurable" lives in one settings page inside the operational center (your internal team's view) — not scattered across code, and not exposed to individual shop owners. This is where you tune system behavior without a code change or a deploy:

- Manager PIN rotation interval (default: weekly)
- Offline subscription grace period (default: 5 days)
- Read-only window before escalating to fully locked, post-grace-period (default: TBD)
- Mandatory minimum sync interval (default: every 5 days)
- Notebook photo-capture free monthly scan allowance (default: ~5/month)
- Sync-cadence warning escalation thresholds
- (Tax rules themselves live in their own dedicated tax settings page — see §8.1 — since they need effective-dating and audit history a generic settings page doesn't provide; this page is for operational/behavioral parameters only, not legal/tax data.)

All changes here are logged (old value, new value, who changed it, when) — same principle as everywhere else: nothing overwritten silently.

## 6. Client Shell (locked)

**Tauri.** Lighter footprint, better fit for modest shop hardware. Native layer is Rust — day-to-day work stays in the JS/TS layer, with occasional native-layer debugging touching Rust when hardware integration (barcode scanner, monotonic clock access — see §7) requires it.

## 7. Core Mechanics (locked — see PRD §5 for full detail, restated here for build reference)

- **Batch/FIFO costing**: immutable batches, oldest-first consumption, invisible to the salesperson.
- **Price separation**: cost price frozen per batch; selling/floor price fully owner-editable anytime, retroactive-apply is a deliberate logged action, never automatic. No ceiling on sale price, only a floor.
- **Barcodes**: store-scoped uniqueness only. Cross-store scan of an unrecognized barcode returns a plain "not recognized" — never reveals another tenant's data exists. Barcode generation includes a uniqueness check against everything already issued for that shop before a new one is created; printing is a straightforward PDF/label output once uniqueness is confirmed.
- **Offline-first**: instant local writes always; background sync on reconnect; mandatory sync cadence (~2–3 days, escalating warnings toward ~1 week). Physical stock is source of truth. Rare offline double-sale conflicts are surfaced to the owner on sync, never silently resolved.
- **Concurrency**: online = real Postgres transaction/row-lock on batch decrement to prevent double-sell across simultaneous terminals; offline = optimistic local writes, conflicts surfaced (not auto-resolved) on sync.
- **Offline subscription enforcement**: the desktop app must enforce subscription gating even with no network connection — otherwise a permanently offline device is a free loophole around an expired subscription.
  - On every successful sync, the server pushes a signed subscription token (expiry date + status). The desktop app can verify it wasn't tampered with locally, but cannot forge or extend one itself.
  - The app does not trust the device's system clock for this check, since that can be rolled back manually to dodge expiry. Instead, it tracks elapsed time forward from its last confirmed sync using the device's monotonic clock (counts forward only, unaffected by the visible system date being changed) — giving a tamper-resistant estimate of "how much time has actually passed since I last synced," independent of the system clock.
  - If the system clock and the monotonic-elapsed estimate diverge significantly, that's logged/flagged as a signal, not silently ignored.
  - Mandatory reconnection rule: every offline device must go online (successful sync) at minimum every 5 days. Approaching that limit, escalating warnings; past it, the device gates.
  - Grace period past subscription expiry: default 5 days of continued normal use before dropping to read-only, to tolerate a renewal happening while briefly offline.
  - Progressive gating on expiry (locked): full use during grace period → read-only (all writes blocked — no new sales, purchases, or expenses) → fully locked (no access at all) after a further read-only window elapses. During read-only, tax numbers/reports are hidden as well, not just writes blocked — only stock levels and sales/purchase history remain visible.
  - The length of the read-only window before escalating to fully locked is not hardcoded — it's a value on the operational settings page (§5.1), same as the grace period and mandatory sync interval.
  - Both the grace period and the 5-day mandatory sync interval are not hardcoded — see §5.1 (settings) for where they live and who can change them.

## 8. Tax Engine (locked shape)

- **Fully deterministic** — thresholds, rates, and rules live in the versioned `tax_rules` config table, not in code. AI never touches calculation or legal classification.
- **Live, ambient tracking** — no button, no click-to-calculate. A persistent tax-status widget reflects running turnover and current bracket in real time as sales are recorded, calculated against the year of assessment as defined by law, not an arbitrary rolling window (exact figures pending — see §8.1).
- **Self-declared category**: shop owner selects their business category and applicable tax types at setup from a maintained list — the system does not infer category from sales data. This is a deliberate choice: inferring from sales data would mean reading and analyzing the owner's data without their conscious input (a privacy concern) and would shift liability for a wrong classification onto the system rather than the owner's own declaration.
- **Multi-tax-type support**: category selection maps to potentially multiple applicable tax types (not just one bracket) — the system tells the owner what they owe, across each applicable type, not the reverse.
- **Refunds/reliefs — architecture built now, calculations switched on later**: the data model supports overpayment/refund detection, state-vs-federal double-taxation flags, and relief-qualifying inputs (e.g., charitable donations) with a "how to claim" guidance surface — but the actual rule logic for these stays off until the underlying tax rules are properly sourced and verified. Nothing to rebuild later, just rules to populate.
- **Filing status tracking**: self-reported by owner (no FIRS API exists for this), locks the period on filing, amendments are visible layered corrections.
- **Retrospective calculation**: because every tax rule is stored with an effective date range, applying last year's rules to last year's data is a native capability of the config design, not a separate feature to build.
- **Config changes are human-gated and logged**: AI may flag that a law appears to have changed; a human (Nathan or an accountant) approves before any tenant sees the new rule. Every change to `tax_rules` retains the prior value and the change timestamp.

### 8.1 Tax settings page (locked)

A separate, dedicated settings page in the operational center, distinct from the general operational settings page in §5.1 — this is where you (or an accountant working with you) manage the actual `tax_rules` config: tax types, thresholds, rates, effective date ranges, and business-category-to-tax-type mappings.

Kept separate from §5.1 deliberately: tax rules carry legal weight and need effective-dating plus a full audit trail (old value, new value, who changed it, when, and what date range it applies to) — a different shape of data than a simple operational toggle like "PIN rotation interval." Same underlying principle as everywhere else in the system though: nothing is overwritten, every change is logged, and retrospective calculation works automatically because each rule is tied to the period it was actually in force.

**Pending, to be entered here before launch**: exact current tax thresholds/rates and the precise legal definition of "year of assessment" for a small unincorporated retailer specifically. Sources conflict (₦25M–₦100M turnover bands turn up depending on source and tax type) — needs an accountant or chartered tax professional, not something to settle from search results alone. Not build-blocking — the page and the versioned config exist and work regardless of what values are in them — but the live tax widget shouldn't go in front of a real user until this is confirmed.

## 9. Build Sequence (locked)

1. **Foundation** — multi-tenant schema; core tables for shops, users, roles/permissions; batch/FIFO inventory logic.
2. **Auth & roles end to end** — Supabase Auth wired to own permission tables; default roles + custom role creation; weekly rotating manager PIN.
3. **Desktop app skeleton** — real sales flow against one shop (add item → sell → hits database).
4. **Barcode system** — scanning, multi-terminal support, barcode generation with uniqueness checking, label printing.
5. **Offline-first & sync** — proven in isolation before more is built on top of it.
6. **Tax engine foundation** — config-driven rules table, category selection, live threshold widget; refunds/reliefs data model present but inactive.
7. **Notebook photo capture** — most experimental piece, built once the core is stable.
8. **Web dashboard** — owner control tower: subscriptions, user/role management, desktop-device activation flow, reporting.
9. **Operational center** — internal support/oversight tooling for your team.

## 10. Claude Code — Operating Rules

**Never:**
- Run Supabase migrations, schema changes, or SQL directly. Always hand Nathan the query/migration to run manually in the Supabase dashboard.
- Expose the service-role key client-side. Anon key only in the desktop/web client; service-role key stays server-side.
- Make schema changes without explicit approval first.
- Add scope silently. If something beyond spec seems needed, flag and ask — don't build it in unasked.
- Let hallucinated assumptions substitute for a checked fact — verify against the actual codebase/build log state before proceeding, don't assume prior context.

**Always:**
- Research before implementing non-trivial logic — check for a more efficient, secure, or simpler approach rather than defaulting to the first thing that works. Optimize for **security, efficiency, speed, and usability** — all four, not just "it works."
- Maintain and consult a **build log/record** before starting any new work and update it after finishing — what's built, what's in progress, what's explicitly not started. This is how the next session (or the next developer) knows exactly where things stand without re-deriving it.
- Call out sync-related logic explicitly in comments/commit messages — this is the highest-risk area for subtle bugs.
- Follow the locked design system/style conventions (carried over from Zogal's build conventions).
- Keep modules cleanly separated per §3 — don't let boundaries blur for convenience.

## 11. Open Items Before Build Starts

1. Timeline: ASAP — no further scoping deferral; effort estimate to be produced once build begins on Stage 1 of §9.
