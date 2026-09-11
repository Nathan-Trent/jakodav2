# Jakoda (repo: jakodav2) — Project Instructions for Claude Code

## Before doing anything
Read `/docs/PRD.md` and `/docs/TRD.md` in full. Read `/BUILD_LOG.md` to see
what's already built, what's in progress, and what's explicitly not started.

## Never
- Run Supabase migrations, schema changes, or SQL directly. Hand the query to
  Nathan to run manually in the Supabase dashboard.
- Expose the service-role key client-side. Anon key only in client code;
  service-role key stays server-side.
- Make schema changes without explicit approval first.
- Add scope silently. If something beyond spec seems needed, flag it and ask.
- Assume prior context without checking BUILD_LOG.md and the actual codebase
  state first.

## Always
- Research before implementing non-trivial logic — check for a more efficient,
  secure, or simpler approach before defaulting to the first thing that works.
- Optimize for security, efficiency, speed, and usability — all four.
- Update BUILD_LOG.md after finishing any unit of work: what's built, what's
  in progress, what's explicitly not started yet.
- Call out sync-related logic explicitly in comments/commit messages.
- Keep modules cleanly separated per TRD §3 (modular monolith) —
  tax-engine, inventory-batches, sync, auth-permissions, frontend-desktop,
  frontend-web.

## Stack
TypeScript end to end. Tauri for the desktop client. Supabase (Postgres +
Auth) with the portability rule from TRD §2 — plain SQL, thin RLS,
service-role key server-side only, Supabase Auth for login mechanism only.

## Build order
See TRD §9 for the full locked sequence. Always check BUILD_LOG.md for
current stage before starting new work.
