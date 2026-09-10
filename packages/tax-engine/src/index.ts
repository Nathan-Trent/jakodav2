/**
 * TAX ENGINE module — Stage 6. Not started.
 *
 * Fully deterministic: evaluates versioned, effective-dated `tax_rules`
 * config against ledger totals. AI never produces a number or a legal
 * classification here (PRD §5.5, TRD §8).
 */
export const TAX_ENGINE_MODULE_STATUS = "not-started" as const;
