/**
 * TAX ENGINE module — Stage 6 (TRD §8, PRD §5.5).
 *
 * Fully deterministic: evaluates versioned, effective-dated `tax_rules`
 * against ledger totals. AI never produces a number or a legal
 * classification here.
 *
 *  - `types`    mirrors of the tax tables
 *  - `periods`  assessment windows and due dates, timezone-free
 *  - `engine`   computeObligations() and periodStatuses()
 *  - `repo`     loads rules/profile/summary from Supabase
 */
export * from "./types.js";
export * from "./periods.js";
export * from "./engine.js";
export * from "./repo.js";
