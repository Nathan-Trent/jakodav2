# PRD — Invoicing & Record-Keeping System for Nigerian Retail SMEs
**Working name:** [TBD]
**Status:** Draft v1 — pending client validation
**Owner:** Nathan Ogogo

---

## 1. Problem Statement

Small Nigerian retail businesses (starting point: a phone parts & accessories store) have no reliable way to track sales, purchases, and expenses as they happen. This creates two compounding problems:

1. **Operational**: owners can't answer basic questions — what's actually in stock, what did we really make on that sale, who sold what — without manually reconstructing records.
2. **Tax/compliance**: Nigeria's tax reporting requirements (Nigeria Tax Act 2025 / Nigeria Tax Administration Act 2025, effective Jan 2026) are new to most small business owners. When it's time to file, or when a tax officer requests records, owners have no clean audit trail and no idea what they even owe.

This product solves the record-keeping problem completely, and solves the tax problem as far as software honestly can: correct numbers, correct documents, correct guidance — the owner (or their accountant) does the actual filing. This is **not** a FIRS/TaxPro Max filing integration. No such public API exists.

## 2. Goals

- Make daily sales/purchase/expense capture fast enough that staff actually use it instead of reverting to notebooks.
- Produce trustworthy, auditable financial records year-round with zero manual reconciliation.
- Translate current Nigerian tax law into correct, always-current guidance and computed figures — without ever letting AI touch the actual math.
- Work reliably in low-connectivity, multi-person, multi-terminal retail environments.
- Be simple enough for a first-time, non-technical shop owner and precise enough to hold up under scrutiny (accountant, tax officer, the owner's own trust in the numbers).

## 3. Non-Goals (v1)

- No direct FIRS / TaxPro Max filing submission (portal-only system, no public API — confirmed).
- No mobile app in v1 — admin mobile companion is v2.
- No e-invoicing / MBS real-time clearance integration in v1 (optional future phase; current mandate timeline doesn't reach small/emerging taxpayers until ~2027–2028).
- No multi-store barcode uniqueness — barcodes are scoped per store only.

## 4. Users & Roles

| Role | Description | Access |
|---|---|---|
| **Owner/Admin** | Runs the business, sets prices, manages staff, views all reports | Full access to everything: cost data, margins, batch history, all reports, tax figures, filing status |
| **Salesperson** | Sells items at point of sale | Configurable per-person by admin — default: floor price + suggested price only, no cost, no margin |

Permissions are **admin-controlled per individual salesperson**, not a fixed role template — the admin decides exactly what each person can see.

## 5. Core Concepts (must be understood before build)

### 5.1 Batch-based cost tracking (FIFO)
- Every purchase creates a **batch**: quantity, cost price, purchase date. Batches are immutable once created — cost price of an existing batch can never be edited.
- Sales automatically consume the **oldest batch first** (First In, First Out). The salesperson never sees or chooses batches — this happens silently.
- Profit on any given sale = (selling price at time of sale) − (cost of the specific batch unit consumed), not "today's cost."
- This is the mechanism that keeps profit and tax figures honest even as purchase costs fluctuate.

### 5.2 Selling price vs. cost price
- **Cost price**: frozen per batch, immutable, historical fact.
- **Selling/base price + floor price**: fully owner-editable, at any time, and can be applied retroactively to existing stock (old and new batches alike) at the owner's discretion. This is a deliberate, logged action — never automatic.
- A salesperson may sell above the floor price at any amount; there is no ceiling. Each individual sale price is recorded as-is.

### 5.3 Barcodes — store-scoped
- Barcodes are unique **within a store only**, not globally unique across every business using the system.
- If a scanner from Store B reads a Store A barcode, the system should treat it as simply unrecognized — no error message that reveals another business's data exists, no partial match, nothing.
- System can auto-generate a barcode for any item that doesn't already have a manufacturer barcode; owner prints and applies it.

### 5.4 Offline-first
- All actions (sale, purchase, expense entry) are recorded locally on the terminal instantly, regardless of network state.
- Background process syncs to server whenever connectivity is available; can operate offline for an extended period.
- **Mandatory sync cadence**: system enforces reconnection at least every 2–3 days; escalating warnings as it approaches ~1 week without a successful sync.
- Physical stock is the real source of truth — if an item is physically gone, it's gone. Database-level conflicts between offline terminals (e.g., two terminals both offline selling the last unit) are a rare edge case; when they do surface on reconnect, flag clearly to the owner for manual resolution — never silently discard or overwrite.

### 5.5 Tax rules engine
- Tax thresholds, rates, categories, and applicable forms are stored as **versioned, dated configuration data** — not hardcoded logic. Updating the law means updating config, not shipping new code.
- All classification and calculation is **deterministic** — plain rules evaluation against the ledger's totals. AI is never involved in producing a number or a legal classification.
- AI's role is strictly: (a) translating deterministic output into plain language calibrated to the reader, (b) parsing free-form input (photographed notebook pages, conversational entry) into structured records, (c) generating guidance text alongside a correct, already-computed result.
- Rule changes are human-gated: AI may flag that a source suggests a law change; a human (Nathan or an accountant) approves before it goes live to any tenant. No auto-updating rules table from scraped sources.

### 5.6 Notebook photo capture
- Available as an input method for owners/staff still used to writing sales by hand.
- AI-translated from photo to structured record; this is a real, metered cost — a monthly free-scan allowance (admin-configurable, starting reference point ~5/month), paid beyond that. Not a behavioral deterrent — a genuine cost pass-through.

### 5.7 Filing status tracking
- No API exists to verify filing status with FIRS (TaxPro Max is portal-only, no third-party filing-status query capability — confirmed).
- Filing status is **self-reported by the owner**: owner marks a period (e.g., "VAT — March") as filed, and must attach the confirmation reference (DIN) FIRS issues on submission — ideally with a photo/screenshot of the confirmation.
- Once marked filed, that period **locks** — no further edits to sales/purchases/expenses within it. Any necessary correction after the fact is a visible amendment on top of the locked period, never a silent edit.
- Owner-facing view shows outstanding vs. filed periods at a glance.

## 6. Functional Requirements (Customer-Facing Feature List)

### 6.1 Item setup
- Add item: name, cost price (initial batch), floor price, suggested price.
- Auto-generate store-scoped barcode if none exists; support existing manufacturer barcodes.

### 6.2 Sales capture
- Scan barcode, or manual entry.
- Enforce floor price at point of sale; no ceiling.
- Support simultaneous sales across multiple terminals/salespeople in real time.
- Deduct stock from oldest batch first (FIFO), transparently.

### 6.3 Purchase/restock capture
- Scan or manual entry of incoming stock.
- New cost price always creates a new batch; never overwrites an existing batch's cost.
- On cost change detection, prompt owner: apply new selling price to all stock (old + new), or leave selling price unchanged — cost price is never affected by this choice.

### 6.4 Expense logging
- Categorized expense entry (rent, transport, staff, other) feeding into true profit calculation.

### 6.5 Notebook photo capture
- Photograph a handwritten sales/purchase page; AI parses into structured draft records for owner/staff confirmation before committing.
- Metered usage with configurable free monthly allowance.

### 6.6 Reporting (Owner/Admin)
- Real-time: sales, profit (true, batch-based), stock on hand, per-salesperson performance.
- Historical: cost-price change log per item, selling-price change log per item, full sales/purchase/expense history.

### 6.7 Tax readiness
- Period-based computed summary: sales, COGS (true, batch-based), expenses, profit, applicable tax obligations under current rules config.
- Generated, ready-to-submit documents/exports matching required filing formats.
- Step-by-step guidance: what's due, which form, where to file.
- Filing status tracker: mark period filed with reference number; locks period; outstanding-vs-filed view.

### 6.8 Roles & permissions
- Owner: full access.
- Salesperson: admin-configured visibility, default floor + suggested price only.

### 6.9 Offline operation
- Full functionality without network connection.
- Automatic background sync when connectivity available.
- Enforced minimum sync cadence (~2–3 days) with escalating alerts.
- Conflict surfacing (not silent resolution) for rare offline multi-terminal collisions.

## 7. Platform Sequencing

- **V1**: Installed desktop/laptop application, full feature set above, multi-terminal support from day one, physical barcode scanner integration (USB/Bluetooth).
- **V2**: Mobile companion app — **admin/owner monitoring only**, not a second point of sale. Remote visibility into sales, stock, profit.

## 8. Open Questions for Client Validation

1. Does the full end-to-end flow (see WhatsApp walkthrough, attached separately) match how the business actually operates day to day?
2. Roughly what volume of daily transactions — informs whether notebook capture is a real ongoing need or a short transition tool.
3. What proportion of current stock has real manufacturer barcodes vs. will need system-generated ones printed?
4. Would this business — and similar businesses the client knows — see value in this beyond the immediate owner's use case (validates broader market)?

## 9. Success Criteria (initial)

- Owner can, at any point, state true profit and current stock without manual reconciliation.
- Owner can produce a correct, ready-to-file tax summary for any past period without reconstructing records.
- Staff adopt scan/manual entry as the default; notebook photo capture usage trends toward zero over time.
- Zero disputes/errors traceable to cost-price or selling-price confusion (batch history resolves any question).
