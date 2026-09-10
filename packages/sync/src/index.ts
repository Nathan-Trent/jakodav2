/**
 * SYNC module — Stage 5. Not started.
 *
 * Boundary reserved now so nothing else grows into it. Will own:
 *  - local write-ahead queue (offline-first, instant local writes)
 *  - background replay on reconnect (idempotent via sales.client_ref)
 *  - conflict surfacing (never silent resolution) for offline double-sells
 *  - mandatory sync cadence enforcement (2–3 days, escalating to ~1 week)
 */
export const SYNC_MODULE_STATUS = "not-started" as const;
